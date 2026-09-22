const { Branch, Employee, EmployeeOnboarding, EmployeeDocument, User } = require('../models');
const storage = require('../services/storage.service');
const { dispatchEmail } = require('../services/email.service');
const { resolveBranchScope } = require('../utils/branch-scope');
const { branchManagerFilter } = require('../services/branch-recipients.service');

/**
 * רישום עובד/ת חדש/ה — the form a new hire fills in about themselves, and the
 * queue where it waits for a human.
 *
 * The link is PERMANENT and meant to be pasted into WhatsApp, which is the
 * same as saying it will be forwarded. So the endpoint that receives it cannot
 * create staff: a submission is a row in EmployeeOnboarding and nothing else.
 * Somebody in accounting reads it, checks it is the person they hired, and
 * presses a button — and only that button writes an Employee.
 *
 * The cost of getting this wrong is not spam. An Employee row is a person the
 * payroll pays, and an endpoint that makes them is an endpoint that makes
 * payments.
 */

const DOC_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg', 'image/png', 'image/heic', 'image/heif',
]);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 6;

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const digits = (v) => String(v || '').replace(/\D/g, '');

/** GET /api/public/employee-registration/branches */
async function publicBranches(req, res, next) {
  try {
    const branches = await Branch.find({ is_active: { $ne: false } })
      .select('name').sort({ name: 1 }).lean();
    // The real rooms, by their real names — unlike the careers form, the
    // person filling this in has already been hired INTO a specific branch and
    // knows which one. Collapsing כפר סבא's two here would make the office
    // guess something the new hire already knows.
    res.json({ branches: branches.map(b => ({ id: String(b._id), name: b.name })) });
  } catch (err) { next(err); }
}

/** Store one uploaded file, bucket first. */
async function storeFile(part, kind) {
  if (!DOC_TYPES.has(part.mimetype)) {
    throw Object.assign(new Error(`הקובץ "${part.originalname}" אינו PDF, Word או תמונה`), { status: 400 });
  }
  const filename = clean(part.originalname, 160) || 'מסמך';
  const file = {
    kind, filename, mimetype: part.mimetype, size_bytes: part.size,
    storage_key: null, data: null,
  };
  if (storage.isConfigured()) {
    try {
      const ext = (filename.split('.').pop() || 'pdf').toLowerCase();
      const key = storage.makeKey('onboarding', ext);
      await storage.putObject({ key, body: part.buffer, contentType: part.mimetype });
      file.storage_key = key;
      return file;
    } catch (err) {
      console.error('[onboarding] storage put failed, keeping inline:', err.message);
    }
  }
  file.data = part.buffer.toString('base64');
  return file;
}

/**
 * POST /api/public/employee-registration
 *
 * Anonymous. Everything it accepts is bounded, and nothing it writes is a
 * person the payroll can pay.
 */
async function publicSubmit(req, res, next) {
  try {
    const b = req.body || {};
    const full_name = clean(b.full_name, 80);
    const israeli_id = digits(b.israeli_id).slice(0, 12);
    const phone = clean(b.phone, 30);

    if (!full_name) return res.status(400).json({ error: 'נא למלא שם מלא' });
    if (israeli_id.length < 8 || israeli_id.length > 9) {
      return res.status(400).json({ error: 'תעודת זהות לא תקינה' });
    }
    if (digits(phone).length < 9) return res.status(400).json({ error: 'מספר טלפון לא תקין' });

    // The branch is looked up rather than trusted: the form posts an id, and
    // an id that is not a branch we run is not a branch.
    let branch = null;
    if (b.branch_id) {
      branch = await Branch.findById(b.branch_id).select('name').lean().catch(() => null);
    }

    const parts = (req.files || []).slice(0, MAX_FILES);
    const files = [];
    for (const part of parts) {
      try {
        files.push(await storeFile(part, clean(b[`kind_${part.fieldname}`], 30) || fieldKind(part.fieldname)));
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
      }
    }

    const doc = await EmployeeOnboarding.create({
      full_name,
      israeli_id,
      phone,
      email: clean(b.email, 120),
      address: clean(b.address, 160),
      birth_date: clean(b.birth_date, 10),
      requested_branch: branch?.name || clean(b.branch_name, 80),
      branch_id: branch?._id || null,
      position: clean(b.position, 60),
      bank_number: clean(b.bank_number, 10),
      bank_branch: clean(b.bank_branch, 10),
      bank_account: clean(b.bank_account, 30),
      bank_account_holder: clean(b.bank_account_holder, 80),
      emergency_name: clean(b.emergency_name, 80),
      emergency_phone: clean(b.emergency_phone, 30),
      emergency_relation: clean(b.emergency_relation, 40),
      note: clean(b.note, 1000),
      files,
      status: 'pending',
    });

    notifyOffice(doc, branch).catch(err => console.error('[onboarding] notify failed:', err.message));
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
}

/** The upload field name says what the file is. */
function fieldKind(fieldname) {
  if (/id/i.test(fieldname)) return 'id_document';
  if (/bank/i.test(fieldname)) return 'bank_details';
  if (/cert/i.test(fieldname)) return 'certificate';
  return 'other';
}

async function notifyOffice(doc, branch) {
  const emails = new Set();
  const office = await User.find({
    role: { $in: ['system_admin', 'accountant'] }, is_active: { $ne: false },
  }).select('email').lean();
  office.forEach(u => u.email && emails.add(u.email));
  if (doc.branch_id) {
    const managers = await User.find(branchManagerFilter(doc.branch_id)).select('email').lean().catch(() => []);
    managers.forEach(m => m.email && emails.add(m.email));
  }
  if (emails.size === 0) return;
  // Deliberately NOT the bank details. This mail lands in several inboxes and
  // is forwarded from them; an account number does not need to travel to be
  // useful, and it is one click away in the screen for the people who may see it.
  await dispatchEmail({
    to: [...emails],
    subject: `רישום עובד/ת חדש/ה — ${doc.full_name}`,
    html: `<div dir="rtl" style="font-family:Arial,sans-serif">
      <h2 style="margin:0 0 4px">רישום עובד/ת חדש/ה 📝</h2>
      <p style="margin:0 0 12px;color:#666">הגיע מטופס הרישום באתר וממתין לאישור.</p>
      <p><b>שם:</b> ${doc.full_name}</p>
      <p><b>טלפון:</b> ${doc.phone}</p>
      <p><b>סניף:</b> ${branch?.name || 'לא נבחר'}</p>
      <p><b>מסמכים:</b> ${doc.files.length}</p>
      <p style="color:#888">הרישום ממתין במסך "רישומי עובדים". עובד/ת נוצר/ת רק לאחר אישור.</p>
    </div>`,
    text: `רישום חדש: ${doc.full_name}, ${doc.phone}`,
  });
}

/* ------------------------------------------------------------------ *
 *  The review queue
 * ------------------------------------------------------------------ */

/** Accounting and admins see the money; a branch manager sees her hire. */
const seesBank = (req) => ['system_admin', 'accountant'].includes(req.user?.role);

function shape(doc, withBank) {
  const out = {
    id: String(doc._id),
    full_name: doc.full_name,
    israeli_id: doc.israeli_id,
    phone: doc.phone,
    email: doc.email,
    address: doc.address,
    birth_date: doc.birth_date,
    requested_branch: doc.requested_branch,
    branch_id: doc.branch_id ? String(doc.branch_id) : null,
    position: doc.position,
    emergency_name: doc.emergency_name,
    emergency_phone: doc.emergency_phone,
    emergency_relation: doc.emergency_relation,
    note: doc.note,
    status: doc.status,
    created_at: doc.created_at,
    decided_by_name: doc.decided_by_name,
    decided_at: doc.decided_at,
    reject_reason: doc.reject_reason,
    employee_id: doc.employee_id ? String(doc.employee_id) : null,
    files: (doc.files || []).map(f => ({
      id: String(f._id), kind: f.kind, filename: f.filename, size_bytes: f.size_bytes,
    })),
    // Said out loud rather than left as an absent key, so the screen can
    // explain the gap instead of rendering four blank rows.
    bank_visible: withBank,
  };
  if (withBank) {
    out.bank_number = doc.bank_number;
    out.bank_branch = doc.bank_branch;
    out.bank_account = doc.bank_account;
    out.bank_account_holder = doc.bank_account_holder;
  }
  return out;
}

/** Which rows this caller may act on. */
async function scopeFilter(req) {
  const scope = await resolveBranchScope(req);
  if (scope === null) return {};
  // A row with no branch belongs to the office. A manager seeing it would be
  // reading a registration for a gan that may not be hers.
  return { branch_id: { $in: scope } };
}

/** GET /api/employee-onboarding?status=pending */
async function list(req, res, next) {
  try {
    const filter = await scopeFilter(req);
    const status = String(req.query.status || 'pending');
    if (status !== 'all') filter.status = status;
    const rows = await EmployeeOnboarding.find(filter)
      .select('-files.data')
      .sort({ created_at: 1 })
      .limit(300)
      .lean();
    const withBank = seesBank(req);
    res.json({ registrations: rows.map(r => shape(r, withBank)) });
  } catch (err) { next(err); }
}

/** GET /api/employee-onboarding/counts */
async function counts(req, res, next) {
  try {
    const base = await scopeFilter(req);
    const [pending, approved, rejected] = await Promise.all([
      EmployeeOnboarding.countDocuments({ ...base, status: 'pending' }),
      EmployeeOnboarding.countDocuments({ ...base, status: 'approved' }),
      EmployeeOnboarding.countDocuments({ ...base, status: 'rejected' }),
    ]);
    res.json({ pending, approved, rejected });
  } catch (err) { next(err); }
}

/** The row, if this caller may touch it. */
async function loadScoped(req, id) {
  const doc = await EmployeeOnboarding.findById(id);
  if (!doc) return { error: 'הרישום לא נמצא', status: 404 };
  const scope = await resolveBranchScope(req);
  if (scope !== null && !scope.map(String).includes(String(doc.branch_id))) {
    return { error: 'הרישום שייך לסניף שאינו בניהולך', status: 403 };
  }
  return { doc };
}

/** GET /api/employee-onboarding/:id/file/:fileId */
async function downloadFile(req, res, next) {
  try {
    const { doc, error, status } = await loadScoped(req, req.params.id);
    if (error) return res.status(status).json({ error });
    const file = (doc.files || []).id(req.params.fileId);
    if (!file) return res.status(404).json({ error: 'קובץ לא נמצא' });
    let buf = null;
    if (file.storage_key) {
      const signed = await storage.signedReadUrl(file.storage_key);
      const upstream = await fetch(signed);
      if (!upstream.ok) return res.status(502).json({ error: `שליפת הקובץ נכשלה (${upstream.status})` });
      buf = Buffer.from(await upstream.arrayBuffer());
    } else if (file.data) {
      buf = Buffer.from(file.data, 'base64');
    }
    if (!buf) return res.status(404).json({ error: 'אין קובץ' });
    res.setHeader('Content-Type', file.mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.send(buf);
  } catch (err) { next(err); }
}

/**
 * POST /api/employee-onboarding/:id/approve
 *
 * The one place a registration becomes a person the payroll can pay.
 * Accounting and admins only — a branch manager may read her hire's form and
 * chase a missing certificate, but creating an employee card is a decision
 * with money on the other end of it.
 */
async function approve(req, res, next) {
  try {
    if (!seesBank(req)) {
      return res.status(403).json({ error: 'רק הנהלת חשבונות או מנהל מערכת מאשרים רישום' });
    }
    const doc = await EmployeeOnboarding.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'הרישום לא נמצא' });
    if (doc.status !== 'pending') {
      return res.status(400).json({ error: 'הרישום כבר טופל' });
    }

    // One ת"ז, one card. The system already refuses duplicates elsewhere and
    // this is the newest door into the same collection — approving a person
    // who is already on the payroll would give them two of everything.
    const clash = doc.israeli_id
      ? await Employee.findOne({ israeli_id: doc.israeli_id }).select('_id full_name').lean()
      : null;
    if (clash) {
      return res.status(409).json({
        error: `כבר קיים/ת עובד/ת עם ת"ז זו: ${clash.full_name}. יש לעדכן את הכרטיס הקיים במקום ליצור חדש.`,
      });
    }

    const employee = await Employee.create({
      full_name: doc.full_name,
      israeli_id: doc.israeli_id,
      phone: doc.phone,
      email: doc.email,
      address: doc.address,
      birth_date: doc.birth_date ? new Date(doc.birth_date) : null,
      branch_id: doc.branch_id || null,
      position: doc.position || '',
      is_active: true,
      bank_number: doc.bank_number,
      bank_branch: doc.bank_branch,
      bank_account: doc.bank_account,
      bank_account_holder: doc.bank_account_holder || doc.full_name,
      emergency_contact: {
        name: doc.emergency_name,
        phone: doc.emergency_phone,
        relation: doc.emergency_relation,
      },
    });

    // The files move into the employee's own תיק, which is where anybody will
    // look for them a year from now. The onboarding row keeps its copies so an
    // approval that is later undone does not take the originals with it.
    const LABEL = {
      id_document: 'צילום תעודת זהות',
      bank_details: 'אישור ניהול חשבון',
      certificate: 'תעודה',
      other: 'מסמך מהרישום',
    };
    for (const f of doc.files || []) {
      await EmployeeDocument.create({
        employee_id: employee._id,
        branch_id: employee.branch_id || null,
        name: LABEL[f.kind] || LABEL.other,
        description: 'הועלה בטופס רישום העובד/ת',
        doc_type: f.kind === 'bank_details' ? 'bank_details'
          : f.kind === 'id_document' ? 'id_document'
            : f.kind === 'certificate' ? 'certificate' : 'other',
        file_name: f.filename,
        file_mimetype: f.mimetype,
        size_bytes: f.size_bytes,
        storage_key: f.storage_key,
        data: null,
        file_data: f.data,
        created_by: req.user?.id || null,
      }).catch(err => console.error('[onboarding] doc copy failed:', err.message));
    }

    doc.status = 'approved';
    doc.employee_id = employee._id;
    doc.decided_by = req.user?.id || null;
    doc.decided_by_name = req.user?.full_name || '';
    doc.decided_at = new Date();
    await doc.save();

    res.json({ ok: true, employee_id: String(employee._id) });
  } catch (err) { next(err); }
}

/** POST /api/employee-onboarding/:id/reject  { reason } */
async function reject(req, res, next) {
  try {
    const { doc, error, status } = await loadScoped(req, req.params.id);
    if (error) return res.status(status).json({ error });
    if (doc.status !== 'pending') return res.status(400).json({ error: 'הרישום כבר טופל' });
    doc.status = 'rejected';
    doc.reject_reason = clean(req.body?.reason, 300);
    doc.decided_by = req.user?.id || null;
    doc.decided_by_name = req.user?.full_name || '';
    doc.decided_at = new Date();
    await doc.save();
    res.json({ ok: true });
  } catch (err) { next(err); }
}

module.exports = {
  publicBranches, publicSubmit, list, counts, downloadFile, approve, reject,
  MAX_FILE_BYTES, MAX_FILES,
};
