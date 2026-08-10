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
const { EmployeeDocument, Employee } = require('../models');

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
async function matchEmployee(scan, mailFrom, { allowNameMatch = true } = {}) {
  const active = await Employee.find({ is_active: true })
    .select('full_name israeli_id email branch_id clock_aliases').lean();

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

module.exports = {
  currentTaxYear,
  hashFile,
  normalizeId,
  normalizeName,
  employeeIdsWithForm,
  attachForm,
  matchEmployee,
  backfillLegacy,
};
