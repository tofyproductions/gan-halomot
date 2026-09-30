/**
 * טופס 101 — the rules everything else asks.
 *
 * Two things make this more than "is there a file attached":
 *
 * 1. A 101 is filed PER TAX YEAR. It is refiled every January, and one on file
 *    from 2024 says nothing about 2026. So "has a 101" is always "has a 101
 *    for year Y", and the roster's completeness column has to name the year or
 *    it is lying.
 *
 * 2. Until now the question was answered by matching /101/ against a document's
 *    free-text label, which reads as missing for anyone whose file is called
 *    something else and as present for a note that merely mentions the number.
 *    Documents now carry `doc_type: 'form_101'`; `backfillLegacy` converts the
 *    old label-matched rows once so the heuristic can be deleted rather than
 *    kept alive alongside the real field.
 */
const crypto = require('crypto');
const { EmployeeDocument, Employee, Form101Inbox } = require('../models');

/** The tax year in progress, in Israel — a calendar year. */
function currentTaxYear() {
  const nowIsrael = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric',
  }).format(new Date());
  return Number(nowIsrael);
}

/** sha256 of a buffer or base64 string — the mail dedupe key. */
function hashFile(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'base64');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** ת״ז as it is stored on Employee: digits only, zero-padded to 9. */
function normalizeId(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length <= 9 ? digits.padStart(9, '0') : digits;
}

/** Names differ by spacing and punctuation far more often than by spelling. */
function normalizeName(value) {
  return String(value || '')
    .replace(/["'`׳״]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Which employees have a 101 on file for `year`.
 * @returns {Promise<Set<string>>} employee ids, as strings
 */
async function employeeIdsWithForm(employeeIds, year) {
  const docs = await EmployeeDocument.find({
    employee_id: { $in: employeeIds },
    doc_type: 'form_101',
    tax_year: year,
  }).select('employee_id').lean();
  return new Set(docs.map(d => String(d.employee_id)));
}

/**
 * Attach a scanned form to an employee.
 *
 * Everything the scan read is kept on the document — including the basis for
 * the match — because the point of an automatic attachment is not to save the
 * two clicks, it is to make a wrong one visible afterwards.
 */
async function attachForm(employee, file, opts = {}) {
  const {
    scan = {}, mail = null, source = 'upload', matchBasis = 'manual',
    createdBy = null, selfUploaded = false,
  } = opts;

  const year = opts.taxYear || scan.tax_year || currentTaxYear();
  const label = `טופס 101 ${year}`;

  const doc = await EmployeeDocument.create({
    employee_id: employee._id,
    branch_id: employee.branch_id || null,
    month: null,
    name: label,
    description: opts.description || '',
    file_data: file.data,
    file_name: file.name || `${label}.pdf`,
    file_mimetype: file.mimetype || 'application/pdf',
    created_by: createdBy,
    doc_type: 'form_101',
    tax_year: year,
    source,
    self_uploaded: selfUploaded,
    mail: mail
      ? { from: mail.from || '', subject: mail.subject || '', date: mail.date || null, uid: mail.uid ?? null, hash: mail.hash || null }
      : { hash: opts.hash || null },
    match_basis: matchBasis,
    match_confidence: scan.confidence || '',
    scan_notes: scan.notes || '',
    // A form that arrived by itself still has to be looked at by a human, so it
    // starts as pending in the salary table's notes column like any upload.
    acknowledged: false,
  });
  return doc;
}

/**
 * Who does this form belong to?
 *
 * Ordered by how much the basis can be trusted, and it stops at the first
 * UNIQUE answer — two employees sharing a name is exactly the case where a
 * guess files someone's tax form under a colleague.
 *
 * @returns {{ employee, basis } | { employee: null, reason, candidates }}
 */
async function matchEmployee(scan, mailFrom, { allowNameMatch = true, mailId = '' } = {}) {
  const active = await Employee.find({ is_active: true })
    .select('full_name israeli_id email branch_id clock_aliases').lean();

  // 0. The ID the employee TYPED, from the Tepez subject/filename — before the
  //    one the scan READ. The scan reads the same number off the PDF Tepez
  //    rendered from her input, so it can only add error: on an 8-digit ID it
  //    completed the number with a digit that does not exist instead of padding
  //    a 0 (גאליה כהן, 51429389 read as 514293893, 30.09.2026), and the result
  //    still passed the check digit, so nothing caught it. Tried first, and only
  //    a UNIQUE hit is taken; otherwise the scan's ID gets its turn below.
  const typed = normalizeId(mailId);
  if (typed) {
    const byTyped = active.filter(e => normalizeId(e.israeli_id) === typed
      || (e.clock_aliases || []).some(a => normalizeId(a) === typed));
    if (byTyped.length === 1) return { employee: byTyped[0], basis: 'mail_subject_id' };
  }

  // 1. ת״ז — the only basis that is an identity rather than a label.
  const id = normalizeId(scan.israeli_id);
  if (id) {
    const byId = active.filter(e => normalizeId(e.israeli_id) === id
      || (e.clock_aliases || []).some(a => normalizeId(a) === id));
    if (byId.length === 1) return { employee: byId[0], basis: 'israeli_id' };
    if (byId.length > 1) {
      return {
        employee: null,
        reason: `ת״ז ${id} מופיעה אצל ${byId.length} עובדים`,
        candidates: byId.map(e => ({ employee_id: e._id, full_name: e.full_name, basis: 'israeli_id' })),
      };
    }
  }

  // 2. The sender's own address, when the system already knows it is theirs.
  const from = String(mailFrom || '').toLowerCase().trim();
  if (from) {
    const byMail = active.filter(e => e.email && e.email.toLowerCase().trim() === from);
    if (byMail.length === 1) return { employee: byMail[0], basis: 'sender_email' };
  }

  // 3. The name on the form. A guess — but a unique one, and for most employees
  //    it is all there is: they file from a personal address nobody recorded.
  const name = normalizeName(scan.employee_name);
  if (name) {
    const byName = active.filter(e => normalizeName(e.full_name) === name);
    if (byName.length === 1) {
      if (!allowNameMatch) {
        return {
          employee: null,
          reason: 'התאמה לפי שם בלבד — שיוך אוטומטי לפי שם כבוי',
          candidates: [{ employee_id: byName[0]._id, full_name: byName[0].full_name, basis: 'name' }],
        };
      }
      return { employee: byName[0], basis: 'name' };
    }
    if (byName.length > 1) {
      return {
        employee: null,
        reason: `השם "${scan.employee_name}" מופיע אצל ${byName.length} עובדים`,
        candidates: byName.map(e => ({ employee_id: e._id, full_name: e.full_name, basis: 'name' })),
      };
    }

    // Nothing exact. Offer near matches so the review screen starts from a
    // shortlist instead of an 83-row dropdown.
    const parts = name.split(' ').filter(p => p.length > 1);
    const near = active.filter((e) => {
      const n = normalizeName(e.full_name);
      return parts.length > 0 && parts.every(p => n.includes(p));
    });
    if (near.length > 0) {
      return {
        employee: null,
        reason: `לא נמצאה התאמה מדויקת לשם "${scan.employee_name}"`,
        candidates: near.slice(0, 5).map(e => ({ employee_id: e._id, full_name: e.full_name, basis: 'name' })),
      };
    }
  }

  return {
    employee: null,
    reason: scan.employee_name || scan.israeli_id
      ? 'לא נמצא עובד תואם לפרטים שבטופס'
      : 'לא נקראו פרטים מזהים מהטופס',
    candidates: [],
  };
}

/**
 * One-off conversion of the documents that were only ever a label.
 *
 * Runs at boot and is idempotent — it only touches rows that have no doc_type
 * yet. The tax year is taken from the label when it names one, and otherwise
 * from the upload date, which is the best available answer for a file that was
 * never asked which year it was for.
 */
async function backfillLegacy() {
  const legacy = await EmployeeDocument.find({
    doc_type: { $exists: false },
    $or: [{ name: /101/ }, { file_name: /101/ }],
  }).select('name file_name created_at').lean();

  if (legacy.length === 0) return { converted: 0 };

  const ops = legacy.map((d) => {
    const label = `${d.name || ''} ${d.file_name || ''}`;
    const year = Number((label.match(/20\d{2}/) || [])[0])
      || new Date(d.created_at || Date.now()).getFullYear();
    return {
      updateOne: {
        filter: { _id: d._id },
        update: { $set: { doc_type: 'form_101', tax_year: year } },
      },
    };
  });
  const res = await EmployeeDocument.bulkWrite(ops);
  return { converted: res.modifiedCount || 0 };
}

/**
 * ── Whose form is it? The employer written on it. ──────────────────────────
 *
 * mail-sorter offers every 101 to BOTH businesses on purpose — "a 101 is about
 * a PERSON, not a business" (its pull.routes.ts) — and each is meant to keep the
 * ones it recognises. חברים של טופי does: it matches by ID and ignores the rest.
 * The גן took every one, paid to read it, and queued whatever matched no גן
 * employee as "לא נמצא עובד תואם", as though a form for another company were a
 * problem for somebody here to solve. On 30.09.2026 that queue held 16 forms,
 * and 15 read "חברים של טופי בע״מ" on the employer line.
 *
 * In Israel an employee with two employers files a 101 to EACH. So a טופי form
 * is not a גן form even when the same woman works in both places — which makes
 * this a correctness rule as well as a tidy one. See classifyScan for the order.
 *
 * A POSITIVE match only. An employer the scan could not read, or read with a
 * spelling nobody listed, is NOT "another company": dropping those would lose
 * real גן forms without a trace, and the review queue is exactly where an
 * unknown should land. Listed as substrings of the normalised name (quotes and
 * geresh stripped — the real queue had 12 × בע"מ and 3 × בע״מ).
 */
const OTHER_EMPLOYERS = [
  { match: 'טופי', label: 'חברים של טופי' },
];

/** The other business this form was issued to, or null when it may be ours. */
function otherEmployer(scan) {
  const name = normalizeName(scan && scan.employer_name);
  if (!name) return null;
  const hit = OTHER_EMPLOYERS.find((o) => name.includes(normalizeName(o.match)));
  return hit ? hit.label : null;
}

/**
 * The whole decision for one scanned form: another employer's, or ours to match.
 *
 * The EMPLOYER is asked first, before the ID. Asked second, a טופי form whose ID
 * belongs to a woman who also works at the גן would match her — and be filed as
 * her גן 101, which is the wrong employer's tax form in her file.
 *
 * @returns {{ kind: 'other_employer', label, reason }
 *          | { kind: 'match', employee, basis } | { kind: 'match', employee: null, reason, candidates }}
 */
async function classifyScan(scan, mailFrom, opts = {}) {
  const label = otherEmployer(scan);
  if (label) {
    return {
      kind: 'other_employer',
      label,
      reason: `שייך ל${label} — מטופל במערכת של ${label}, לא בגן`,
    };
  }
  return { kind: 'match', ...(await matchEmployee(scan, mailFrom, opts)) };
}

/**
 * Move what is ALREADY waiting in the queue and belongs to another employer.
 *
 * Decided from the employer name stored on each row when it was first read —
 * no re-scan and no cost. Idempotent: a second run finds nothing to move.
 * Returns how many rows moved.
 */
async function reclassifyQueuedOtherEmployer() {
  const pending = await Form101Inbox.find({ status: 'pending' })
    .select('_id scan.employer_name').lean();
  let moved = 0;
  for (const row of pending) {
    const label = otherEmployer(row.scan);
    if (!label) continue;
    await Form101Inbox.updateOne(
      { _id: row._id, status: 'pending' },
      { $set: { status: 'other_employer', reason: `שייך ל${label} — מטופל במערכת של ${label}, לא בגן` } },
    );
    moved += 1;
  }
  return moved;
}

/**
 * The ID in a Tepez 101's subject or filename — "טופס 101 - גאליה כהן - 51429389".
 *
 * The same rule mail-sorter's parseForm101Subject uses (5–9 digits, anchored on
 * separators so "101" and a year are not taken for an ID; subject first, then
 * the filename), so the two services read the same number from the same mail.
 * Empty when neither carries one — a scanned paper form, a form sent by hand —
 * and then the scan decides, exactly as before.
 */
function idFromMail(subject, filename) {
  const one = (raw) => {
    const clean = String(raw || '').replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();
    const m = clean.match(/(?:^|[\s\-–—:·|])(\d{5,9})(?=$|[\s\-–—:·|])/);
    return m ? m[1] : '';
  };
  return one(subject) || one(String(filename || '').replace(/\.[a-z0-9]+$/i, ''));
}

/**
 * Re-match what is waiting in the queue using the ID from its mail.
 *
 * Queued forms are never scanned again — alreadySeen() finds them by hash — so
 * a better matching rule only reaches NEW mail unless the queue is walked once.
 * Each pending row is re-classified from what is already stored on it (its
 * scan and its mail subject: no re-scan, no cost) and, when it now matches, is
 * filed the way the manual "שייך" button files it (form101.controller
 * assignInbox): the document on the employee, the queue row marked assigned,
 * its copy of the bytes dropped. Idempotent — an assigned row is not pending.
 *
 * @returns {{ attached, still_pending }}
 */
async function rematchPending({ allowNameMatch = false } = {}) {
  const pending = await Form101Inbox.find({ status: 'pending' });
  let attached = 0;
  for (const item of pending) {
    const mailId = idFromMail(item.mail && item.mail.subject, item.file_name);
    if (!mailId) continue;
    const verdict = await classifyScan(item.scan || {}, item.mail && item.mail.from, { allowNameMatch, mailId });
    if (verdict.kind !== 'match' || !verdict.employee) continue;

    const year = (item.scan && item.scan.tax_year) || currentTaxYear();
    const exists = await EmployeeDocument.exists({
      employee_id: verdict.employee._id, doc_type: 'form_101', tax_year: year,
    });
    if (exists) continue; // she already has one for that year — a person decides

    const doc = await attachForm(verdict.employee, {
      data: item.file_data, name: item.file_name, mimetype: item.file_mimetype,
    }, {
      scan: item.scan || {},
      taxYear: year,
      source: 'mail',
      matchBasis: verdict.basis,
      mail: { ...(item.mail ? item.mail.toObject ? item.mail.toObject() : item.mail : {}), hash: item.hash },
      description: `שויך אוטומטית לפי הת״ז בכותרת המייל (${(item.mail && item.mail.from) || 'ללא שולח'})`,
    });
    item.status = 'assigned';
    item.assigned_to = verdict.employee._id;
    item.assigned_document_id = doc._id;
    item.resolved_at = new Date();
    item.file_data = ' ';
    await item.save();
    attached += 1;
  }
  return { attached, still_pending: pending.length - attached };
}

module.exports = {
  currentTaxYear,
  idFromMail,
  rematchPending,
  otherEmployer,
  classifyScan,
  reclassifyQueuedOtherEmployer,
  OTHER_EMPLOYERS,
  hashFile,
  normalizeId,
  normalizeName,
  employeeIdsWithForm,
  attachForm,
  matchEmployee,
  backfillLegacy,
};
