/**
 * Direct payslip distribution — upload a final file and send it, with no audit
 * in between.
 *
 * The audit exists to check a month against the salary table. Two recurring
 * cases have nothing to check: a final file that was already verified, and the
 * one page for the person who was forgotten in the big file. Both used to be
 * forced through an audit, which then reported everyone else as "missing" and
 * had to be APPROVED before it could be distributed — a lie told to the
 * history in order to send one email.
 *
 * Here the file is parsed, every page is matched to an employee by ת״ז, and
 * the result waits as a list. Nothing is sent on upload; nothing is archived
 * until a send actually succeeds. The delivery itself — mail, archive to
 * "התלושים שלי", mark the month paid — is the same function the audit
 * distribution calls, so the two paths cannot drift.
 */
const { DirectPayslipBatch, Employee } = require('../models');
const { parsePayslipsPdf } = require('../services/payslipAudit/pdfParser');
const {
  deliverPayslipToEmployee, realEmployeeEmail, extractPage,
} = require('./payslipAudit.controller');

/** ת״ז as Employee stores it: digits only, zero-padded to 9. */
function normalizeId(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length <= 9 ? digits.padStart(9, '0') : digits;
}

function normalizeName(value) {
  return String(value || '').replace(/["'`׳״]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Which employee does this page belong to?
 *
 * ת״ז first, because it is an identity. A name is only accepted when exactly
 * one active employee carries it — two people sharing a name is precisely the
 * case where a guess mails one person's salary to another.
 */
function matchPage(payslip, employees) {
  const id = normalizeId(payslip.employee_id);
  if (id) {
    const byId = employees.filter(e => normalizeId(e.israeli_id) === id
      || (e.clock_aliases || []).some(a => normalizeId(a) === id));
    if (byId.length === 1) return { emp: byId[0], basis: 'israeli_id' };
  }
  const name = normalizeName(payslip.employee_name);
  if (name) {
    const byName = employees.filter(e => normalizeName(e.full_name) === name);
    if (byName.length === 1) return { emp: byName[0], basis: 'name' };
  }
  return { emp: null, basis: '' };
}

function itemFor(payslip, employees) {
  const { emp, basis } = matchPage(payslip, employees);
  const base = {
    page: payslip.page_index,
    israeli_id: String(payslip.employee_id || ''),
    name_on_payslip: payslip.employee_name || '',
    year_month: payslip.year_month || '',
  };
  if (!emp) return { ...base, status: 'no_match' };
  const email = realEmployeeEmail(emp);
  return {
    ...base,
    employee_id: emp._id,
    employee_name: emp.full_name,
    email: email || '',
    match_basis: basis,
    status: email ? 'pending' : 'no_email',
  };
}

/**
 * POST /api/payroll/direct-payslips   (multipart: payslip_file, month?, branch?)
 * Parses and matches. Sends nothing.
 */
// The whole PDF is kept in one Mongo document, and Mongo's hard cap is 16MB.
// The upload middleware allows 25MB, so without this the save fails deep in
// the driver after the parse has already run.
const MAX_PDF_MB = 12;

async function upload(req, res) {
  const file = req.file || req.files?.payslip_file?.[0];
  if (!file) return res.status(400).json({ error: 'לא נבחר קובץ' });
  if (file.buffer.length > MAX_PDF_MB * 1024 * 1024) {
    return res.status(413).json({
      error: `הקובץ גדול מדי (${(file.buffer.length / 1048576).toFixed(1)}MB). המקסימום להפצה ישירה הוא ${MAX_PDF_MB}MB — לקובץ מלא השתמש בביקורת תלושים.`,
    });
  }

  try {
    const parsed = await parsePayslipsPdf(file.buffer);
    const payslips = parsed.payslips || [];
    if (payslips.length === 0) {
      return res.status(400).json({ error: 'לא זוהו תלושים בקובץ' });
    }

    // The month the pages themselves claim. An explicit one wins — a scanned
    // page whose header didn't parse would otherwise be filed under nothing.
    const claimed = payslips.map(p => p.year_month).filter(Boolean);
    const month = String(req.body?.month || '').trim() || claimed[0] || '';
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'לא זוהה חודש בקובץ — יש לבחור חודש ידנית' });
    }
    // Pages from another month in the same file are the kind of mistake that is
    // only obvious afterwards. Report it; don't decide for the user.
    const otherMonths = [...new Set(claimed.filter(m => m !== month))];

    const employees = await Employee.find({ is_active: true })
      .select('full_name israeli_id email clock_aliases user_id')
      .populate('user_id', 'email')
      .lean();

    const items = payslips.map(p => itemFor(p, employees));

    const batch = await DirectPayslipBatch.create({
      month,
      branch: String(req.body?.branch || '').trim(),
      file_name: file.originalname || '',
      page_count: payslips.length,
      data: file.buffer,
      items,
      created_by: req.user?.id || null,
      created_by_name: req.user?.full_name || '',
    });

    res.status(201).json({
      batch: publicBatch(batch.toObject()),
      other_months: otherMonths,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'שגיאה בקריאת קובץ PDF' });
  }
}

/** Strip the PDF bytes — the list view must never carry the whole file. */
function publicBatch(b) {
  return {
    id: String(b._id),
    month: b.month,
    branch: b.branch || '',
    file_name: b.file_name,
    page_count: b.page_count,
    created_at: b.created_at,
    created_by_name: b.created_by_name || '',
    last_send_at: b.last_send_at,
    sent_count: (b.items || []).filter(i => i.status === 'sent').length,
    items: (b.items || []).map(i => ({
      page: i.page,
      israeli_id: i.israeli_id,
      name_on_payslip: i.name_on_payslip,
      year_month: i.year_month,
      employee_id: i.employee_id ? String(i.employee_id) : null,
      employee_name: i.employee_name,
      email: i.email,
      match_basis: i.match_basis,
      status: i.status,
      error: i.error,
      sent_to: i.sent_to,
      sent_at: i.sent_at,
    })),
  };
}

/** GET /api/payroll/direct-payslips?month=YYYY-MM */
async function list(req, res) {
  try {
    const filter = {};
    if (req.query.month) filter.month = req.query.month;
    const batches = await DirectPayslipBatch.find(filter)
      .select('-data')
      .sort({ created_at: -1 })
      .limit(50)
      .lean();
    res.json({ batches: batches.map(publicBatch) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

/** GET /api/payroll/direct-payslips/:id */
async function get(req, res) {
  try {
    const b = await DirectPayslipBatch.findById(req.params.id).select('-data').lean();
    if (!b) return res.status(404).json({ error: 'לא נמצא' });
    res.json({ batch: publicBatch(b) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

/** GET /api/payroll/direct-payslips/:id/page/:page — the single page, as PDF. */
async function pagePreview(req, res) {
  try {
    const b = await DirectPayslipBatch.findById(req.params.id).lean();
    if (!b?.data) return res.status(404).json({ error: 'לא נמצא' });
    const bytes = b.data.buffer ? Buffer.from(b.data.buffer) : Buffer.from(b.data);
    const buf = await extractPage(bytes, Number(req.params.page));
    if (!buf) return res.status(404).json({ error: 'עמוד לא קיים' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="payslip-${b.month}-p${req.params.page}.pdf"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
}

/**
 * PUT /api/payroll/direct-payslips/:id/pages/:page   { employee_id }
 * The human answer for a page ת״ז could not place. Also the way to correct a
 * match that is wrong — which is why an already-sent page is refused rather
 * than silently repointed.
 */
async function assignPage(req, res) {
  try {
    const b = await DirectPayslipBatch.findById(req.params.id);
    if (!b) return res.status(404).json({ error: 'לא נמצא' });
    const item = b.items.find(i => i.page === Number(req.params.page));
    if (!item) return res.status(404).json({ error: 'עמוד לא נמצא' });
    if (item.status === 'sent') return res.status(409).json({ error: 'העמוד כבר נשלח' });

    const emp = await Employee.findById(req.body?.employee_id)
      .select('full_name israeli_id email user_id').populate('user_id', 'email').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const email = realEmployeeEmail(emp);
    item.employee_id = emp._id;
    item.employee_name = emp.full_name;
    item.email = email || '';
    item.match_basis = 'manual';
    item.status = email ? 'pending' : 'no_email';
    item.error = '';
    await b.save();
    res.json({ batch: publicBatch(b.toObject()) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

/**
 * POST /api/payroll/direct-payslips/:id/send
 * Body: { pages?: number[], include_hours?: bool, to?: string }
 *
 * `pages` omitted sends every page that is ready. Passing one page is how a
 * single forgotten employee gets their payslip without touching anyone else.
 * `to` is test mode: everything goes to one address, nothing is archived and
 * no month is marked paid.
 *
 * Synchronous on purpose. The audit distribution runs in the background because
 * it mails a whole company; this one is a handful of pages, and an answer the
 * user can read beats a job log they have to go find.
 */
async function send(req, res) {
  try {
    const b = await DirectPayslipBatch.findById(req.params.id);
    if (!b) return res.status(404).json({ error: 'לא נמצא' });

    const only = Array.isArray(req.body?.pages) && req.body.pages.length
      ? new Set(req.body.pages.map(Number)) : null;
    const includeHours = req.body?.include_hours === true;   // off by default here
    const toOverride = String(req.body?.to || '').trim();
    const userId = req.user?.id || null;

    const targets = b.items.filter(i => (!only || only.has(i.page))
      && i.employee_id && (i.status === 'pending' || i.status === 'sent'));
    if (targets.length === 0) {
      return res.status(400).json({ error: 'אין עמודים מוכנים לשליחה (עמוד ללא שיוך או ללא מייל)' });
    }
    if (targets.length > 40) {
      return res.status(400).json({ error: 'שליחה ישירה מוגבלת ל-40 עמודים בבת אחת — לקובץ מלא השתמש בהפצה מביקורת' });
    }

    const bytes = b.data.buffer ? Buffer.from(b.data.buffer) : Buffer.from(b.data);
    const out = [];

    for (const item of targets) {
      try {
        const emp = await Employee.findById(item.employee_id)
          .select('full_name israeli_id email user_id').populate('user_id', 'email').lean();
        if (!emp) { item.status = 'no_match'; out.push({ page: item.page, name: item.employee_name, status: 'no_match' }); continue; }

        const pageBuf = await extractPage(bytes, item.page);
        if (!pageBuf) { item.status = 'error'; item.error = 'עמוד לא קיים'; out.push({ page: item.page, name: emp.full_name, status: 'error' }); continue; }

        const sent = await deliverPayslipToEmployee({
          emp, month: b.month, pageBuf, branch: b.branch || '', page: item.page,
          auditId: null, includeHours, toOverride, userId,
        });

        if (sent.status === 'no_email') {
          item.status = 'no_email';
          out.push({ page: item.page, name: emp.full_name, status: 'no_email' });
          continue;
        }
        // Test mode proves the mail, so it must not leave a record claiming the
        // employee received their payslip.
        if (!toOverride) {
          item.status = 'sent';
          item.sent_to = sent.email;
          item.sent_at = new Date();
          item.error = '';
        }
        out.push({ page: item.page, name: emp.full_name, email: sent.email, status: 'sent' });
      } catch (e) {
        item.status = 'error';
        item.error = e.message;
        out.push({ page: item.page, name: item.employee_name, status: 'error', error: e.message });
      }
    }

    if (!toOverride) b.last_send_at = new Date();
    await b.save();
    res.json({ results: out, batch: publicBatch(b.toObject()), test_mode: !!toOverride });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

/** DELETE /api/payroll/direct-payslips/:id — drops the stored PDF too. */
async function remove(req, res) {
  try {
    await DirectPayslipBatch.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

module.exports = { upload, list, get, pagePreview, assignPage, send, remove };
