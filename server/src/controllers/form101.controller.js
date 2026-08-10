/**
 * טופס 101 — the management side: who is missing one, what arrived by mail that
 * nobody could place, and the switches for the scan.
 *
 * The per-employee file itself is an EmployeeDocument like any other, so
 * viewing and deleting go through /api/employee-documents. What lives here is
 * everything that is about the FORM rather than about one document: the roster
 * view for a tax year, the review queue, and the scan's config and run log.
 */
const { Employee, EmployeeDocument, Form101Inbox } = require('../models');
const form101 = require('../services/form101');
const job = require('../services/form101SyncJob');
const mailbox = require('../services/mailbox.service');
const { scanForm101 } = require('../services/form101Scan');

// A base64 payload has to stay clear of Mongo's 16MB document limit, and
// base64 is ~4/3 of the bytes. Same cap as the rest of the document uploads.
const MAX_BASE64_MB = 8;

function tooBig(base64) {
  return Buffer.byteLength(base64 || '', 'utf8') > MAX_BASE64_MB * 1024 * 1024;
}

/** The branches this user may see, mirroring the employee list's scoping. */
function branchScope(req) {
  const role = req.user?.role;
  if (!role || role === 'system_admin' || role === 'accountant') return null; // unrestricted
  const managed = (req.user.managed_branch_ids || []).map(String);
  const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
  return managed.length > 0 ? managed : fallback;
}

/**
 * GET /api/form-101/overview?year=YYYY&branch=<id|all>
 *
 * Every active employee and whether they have a 101 for that year, plus the
 * one they filed most recently for any year — because "filed in 2024, never
 * since" and "never filed at all" are different conversations.
 */
async function overview(req, res, next) {
  try {
    const year = Number(req.query.year) || form101.currentTaxYear();
    const filter = { is_active: true };

    const allowed = branchScope(req);
    if (req.query.branch && req.query.branch !== 'all') filter.branch_id = req.query.branch;
    if (allowed) {
      if (filter.branch_id && !allowed.includes(String(filter.branch_id))) {
        return res.json({ year, employees: [] });
      }
      if (!filter.branch_id) filter.branch_id = { $in: allowed };
    }

    const employees = await Employee.find(filter)
      .populate('branch_id', 'name')
      .select('full_name israeli_id email branch_id start_date')
      .sort({ full_name: 1 })
      .lean();

    const docs = await EmployeeDocument.find({
      employee_id: { $in: employees.map(e => e._id) },
      doc_type: 'form_101',
    })
      .select('employee_id tax_year created_at source match_basis match_confidence self_uploaded file_name')
      .sort({ tax_year: -1, created_at: -1 })
      .lean();

    const byEmployee = new Map();
    for (const d of docs) {
      const key = String(d.employee_id);
      if (!byEmployee.has(key)) byEmployee.set(key, []);
      byEmployee.get(key).push(d);
    }

    const rows = employees.map((e) => {
      const mine = byEmployee.get(String(e._id)) || [];
      const forYear = mine.find(d => d.tax_year === year) || null;
      const latest = mine[0] || null;
      return {
        employee_id: String(e._id),
        full_name: e.full_name,
        israeli_id: e.israeli_id || '',
        email: e.email || '',
        branch_name: e.branch_id?.name || '',
        branch_id: String(e.branch_id?._id || e.branch_id || ''),
        start_date: e.start_date || null,
        has_form: !!forYear,
        document_id: forYear ? String(forYear._id) : null,
        filed_at: forYear?.created_at || null,
        filed_source: forYear?.source || null,
        match_basis: forYear?.match_basis || null,
        self_uploaded: !!forYear?.self_uploaded,
        // The most recent year on file, when it is not this one.
        last_year_on_file: !forYear && latest ? latest.tax_year : null,
      };
    });

    res.json({
      year,
      current_tax_year: form101.currentTaxYear(),
      employees: rows,
      missing_count: rows.filter(r => !r.has_form).length,
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/form-101/employees/:employeeId
 * Body: { file_data(base64), file_name?, file_mimetype?, tax_year? }
 *
 * A manager filing the form for someone. The year is read off the form when it
 * isn't given, so the common case is picking a file and nothing else.
 */
async function uploadForEmployee(req, res, next) {
  try {
    const { file_data, file_name, file_mimetype, tax_year } = req.body;
    if (!file_data) return res.status(400).json({ error: 'נדרש קובץ' });
    if (tooBig(file_data)) return res.status(413).json({ error: `הקובץ גדול מדי (מקסימום ${MAX_BASE64_MB}MB)` });

    const emp = await Employee.findById(req.params.employeeId).select('full_name branch_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    let scan = {};
    let year = Number(tax_year) || null;
    // Reading the form is a convenience, not a gate: a scan that fails (no API
    // key, an unreadable photo) must not stop a manager from filing the file.
    if (!year) {
      try {
        scan = await scanForm101(file_data, file_name, file_mimetype);
        year = scan.tax_year || null;
      } catch { scan = {}; }
    }
    year = year || form101.currentTaxYear();

    const existing = await EmployeeDocument.findOne({
      employee_id: emp._id, doc_type: 'form_101', tax_year: year,
    }).select('_id').lean();

    const doc = await form101.attachForm(emp, {
      data: file_data, name: file_name, mimetype: file_mimetype,
    }, {
      scan, taxYear: year, source: 'upload', matchBasis: 'manual',
      createdBy: req.user?.id || null,
      hash: form101.hashFile(file_data),
    });

    res.status(201).json({
      id: String(doc._id),
      tax_year: year,
      // Say so rather than silently keeping two — the manager may have meant to
      // replace the old one.
      duplicate_of: existing ? String(existing._id) : null,
      scan_notes: scan.notes || '',
    });
  } catch (err) { next(err); }
}

// --- The review queue -----------------------------------------------------

/** GET /api/form-101/inbox?status=pending */
async function listInbox(req, res, next) {
  try {
    const status = req.query.status || 'pending';
    const items = await Form101Inbox.find(status === 'all' ? {} : { status })
      .select('-file_data')
      .populate('assigned_to', 'full_name')
      .sort({ created_at: -1 })
      .limit(200)
      .lean();
    res.json({
      items: items.map(i => ({
        id: String(i._id),
        status: i.status,
        file_name: i.file_name,
        file_mimetype: i.file_mimetype,
        mail: i.mail,
        scan: i.scan,
        reason: i.reason,
        candidates: (i.candidates || []).map(c => ({ ...c, employee_id: String(c.employee_id) })),
        assigned_to_name: i.assigned_to?.full_name || '',
        created_at: i.created_at,
      })),
      pending_count: await Form101Inbox.countDocuments({ status: 'pending' }),
    });
  } catch (err) { next(err); }
}

/** GET /api/form-101/inbox/:id/file — the base64 payload, for preview. */
async function inboxFile(req, res, next) {
  try {
    const i = await Form101Inbox.findById(req.params.id).select('file_data file_name file_mimetype').lean();
    if (!i?.file_data) return res.status(404).json({ error: 'אין קובץ' });
    res.json({ data: i.file_data, name: i.file_name || 'טופס 101', mimetype: i.file_mimetype || 'application/pdf' });
  } catch (err) { next(err); }
}

/**
 * POST /api/form-101/inbox/:id/assign  { employee_id, tax_year? }
 * The human answer to a form the scan could not place.
 */
async function assignInbox(req, res, next) {
  try {
    const item = await Form101Inbox.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'פריט לא נמצא' });
    if (item.status !== 'pending') return res.status(409).json({ error: 'הפריט כבר טופל' });

    const emp = await Employee.findById(req.body.employee_id).select('full_name branch_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const year = Number(req.body.tax_year) || item.scan?.tax_year || form101.currentTaxYear();
    const doc = await form101.attachForm(emp, {
      data: item.file_data, name: item.file_name, mimetype: item.file_mimetype,
    }, {
      scan: item.scan || {},
      taxYear: year,
      source: 'mail',
      matchBasis: 'manual',
      createdBy: req.user?.id || null,
      mail: { ...(item.mail || {}), hash: item.hash },
      description: `שויך ידנית מתיבת הדואר (${item.mail?.from || 'ללא שולח'})`,
    });

    item.status = 'assigned';
    item.assigned_to = emp._id;
    item.assigned_document_id = doc._id;
    item.resolved_by = req.user?.id || null;
    item.resolved_at = new Date();
    // The file now lives on the employee's document; keeping a second copy in
    // the queue is the same bytes twice for no reason.
    item.file_data = ' ';
    await item.save();

    res.json({ ok: true, document_id: String(doc._id), tax_year: year });
  } catch (err) { next(err); }
}

/** POST /api/form-101/inbox/:id/discard — not a 101, or a duplicate. */
async function discardInbox(req, res, next) {
  try {
    const item = await Form101Inbox.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'פריט לא נמצא' });
    item.status = 'discarded';
    item.reason = req.body?.reason || item.reason;
    item.resolved_by = req.user?.id || null;
    item.resolved_at = new Date();
    item.file_data = ' ';
    await item.save();
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// --- The scan's config and run log ---------------------------------------

/** GET /api/form-101/config */
async function getConfig(req, res, next) {
  try {
    const cfg = await job.getConfig();
    const mail = mailbox.mailConfig();
    res.json({
      config: {
        enabled: cfg.enabled,
        from_contains: cfg.from_contains,
        subject_contains: cfg.subject_contains,
        mailbox: cfg.mailbox,
        mark_seen: cfg.mark_seen,
        lookback_days: cfg.lookback_days,
        max_messages: cfg.max_messages,
        allow_name_match: cfg.allow_name_match,
        last_run_at: cfg.last_run_at,
        last_success_at: cfg.last_success_at,
        last_error: cfg.last_error,
        runs: cfg.runs.slice(0, 15),
      },
      // Never the password — only whether one is configured, and which mailbox.
      mailbox_configured: mail.configured,
      mailbox_user: mail.configured ? mail.user : '',
      ai_configured: !!process.env.ANTHROPIC_API_KEY,
    });
  } catch (err) { next(err); }
}

/** PUT /api/form-101/config */
async function updateConfig(req, res, next) {
  try {
    const cfg = await job.getConfig();
    const b = req.body || {};
    const arr = (v) => (Array.isArray(v) ? v.map(s => String(s).trim()).filter(Boolean) : undefined);

    if (b.enabled !== undefined) cfg.enabled = !!b.enabled;
    if (arr(b.from_contains)) cfg.from_contains = arr(b.from_contains);
    if (arr(b.subject_contains)) cfg.subject_contains = arr(b.subject_contains);
    if (b.mailbox !== undefined) cfg.mailbox = String(b.mailbox || 'INBOX');
    if (b.mark_seen !== undefined) cfg.mark_seen = !!b.mark_seen;
    if (b.lookback_days !== undefined) cfg.lookback_days = Math.min(365, Math.max(1, Number(b.lookback_days) || 30));
    if (b.max_messages !== undefined) cfg.max_messages = Math.min(200, Math.max(1, Number(b.max_messages) || 40));
    if (b.allow_name_match !== undefined) cfg.allow_name_match = !!b.allow_name_match;
    await cfg.save();
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** POST /api/form-101/scan — run it now. */
async function scanNow(req, res, next) {
  try {
    const result = await job.run('manual');
    res.json({ run: result });
  } catch (err) { next(err); }
}

/** GET /api/form-101/mail-test — same "does the mailbox answer" check as Cibus. */
async function testMailbox(req, res, next) {
  try {
    res.json(await mailbox.testConnection());
  } catch (err) { next(err); }
}

module.exports = {
  overview,
  uploadForEmployee,
  listInbox,
  inboxFile,
  assignInbox,
  discardInbox,
  getConfig,
  updateConfig,
  scanNow,
  testMailbox,
};
