/**
 * הסכם העסקה — generate from the employee card, send a mobile signing link,
 * and route the signed contract to accounting for confirmation.
 *
 * The escapes matter as much as the happy path: there are ~80 people already
 * employed with no contract in the system, and without "התעלם" / "העלה" this
 * feature would mark every one of them as a problem on the day it ships.
 */
const { Employee, Branch, EmploymentContract, User } = require('../models');
const tpl = require('../services/employmentContract');
const { htmlToPdf } = require('../services/htmlPdf');
const { dispatchEmail } = require('../services/email.service');

const SIGN_LINK_DAYS = 30;

function branchScopeOf(req) {
  const role = req.user?.role;
  if (role === 'system_admin' || role === 'accountant') return null;
  const managed = (req.user?.managed_branch_ids || []).map(String);
  const fallback = req.user?.branch_id ? [String(req.user.branch_id)] : [];
  return managed.length ? managed : fallback;
}
const isApprover = (req) => ['system_admin', 'accountant'].includes(req.user?.role);

async function loadEmployee(req, employeeId) {
  const emp = await Employee.findById(employeeId).lean();
  if (!emp) return { error: { status: 404, message: 'עובד לא נמצא' } };
  const scope = branchScopeOf(req);
  if (scope && !scope.map(String).includes(String(emp.branch_id))) {
    return { error: { status: 403, message: 'העובד/ת אינו/ה בסניף שבאחריותך' } };
  }
  const branch = emp.branch_id ? await Branch.findById(emp.branch_id).select('name').lean() : null;
  return { emp, branch };
}

/** The live contract for an employee = the newest one that isn't superseded. */
const currentFor = (employeeId) =>
  EmploymentContract.findOne({ employee_id: employeeId }).sort({ created_at: -1 });

const publicShape = (d) => (d ? {
  id: String(d._id),
  employee_id: String(d.employee_id),
  variant: d.variant,
  status: d.status,
  sent_at: d.sent_at,
  signed_at: d.signed_at,
  signer_name: d.signer_name,
  approved_at: d.approved_at,
  approved_by_name: d.approved_by_name,
  waived_reason: d.waived_reason,
  waived_by_name: d.waived_by_name,
  waived_at: d.waived_at,
  uploaded: !!d.uploaded_file?.data,
  uploaded_name: d.uploaded_file?.name || '',
  uploaded_at: d.uploaded_file?.uploaded_at || null,
  created_by_name: d.created_by_name,
  created_at: d.created_at,
  token_expires_at: d.token_expires_at,
  has_link: !!d.access_token,
} : null);

/**
 * GET /api/employment-contracts?employee_id=&status=
 * With employee_id: that employee's contract history. Without: everything in
 * scope — which is how accounting finds what is waiting for confirmation.
 */
async function list(req, res, next) {
  try {
    const filter = {};
    if (req.query.employee_id) filter.employee_id = req.query.employee_id;
    if (req.query.status) filter.status = req.query.status;
    const scope = branchScopeOf(req);
    if (scope) filter.branch_id = { $in: scope };
    const docs = await EmploymentContract.find(filter)
      .select('-html -uploaded_file.data -signature_data')
      .populate('employee_id', 'full_name israeli_id position')
      .populate('branch_id', 'name')
      .sort({ created_at: -1 }).limit(500).lean();
    res.json({
      contracts: docs.map(d => ({
        ...publicShape(d),
        employee_name: d.employee_id?.full_name || '',
        israeli_id: d.employee_id?.israeli_id || '',
        position: d.employee_id?.position || '',
        branch_name: d.branch_id?.name || '',
      })),
    });
  } catch (err) { next(err); }
}

/**
 * GET /api/employment-contracts/status?ids=a,b,c
 * One compact row per employee for the employees table badge. Employees with
 * no contract at all simply don't appear.
 */
async function statusMap(req, res, next) {
  try {
    const filter = {};
    const scope = branchScopeOf(req);
    if (scope) filter.branch_id = { $in: scope };
    if (req.query.ids) filter.employee_id = { $in: String(req.query.ids).split(',').filter(Boolean) };
    const docs = await EmploymentContract.find(filter)
      .select('employee_id status signed_at approved_at created_at')
      .sort({ created_at: -1 }).lean();
    const byEmp = {};
    for (const d of docs) {
      const k = String(d.employee_id);
      if (!byEmp[k]) byEmp[k] = { status: d.status, signed_at: d.signed_at, approved_at: d.approved_at };
    }
    res.json({ statuses: byEmp });
  } catch (err) { next(err); }
}

/**
 * GET /api/employment-contracts/context/:employeeId
 * Prefilled merge fields plus the job-definition presets, so the dialog opens
 * populated and the manager picks a role rather than typing an annex.
 */
async function getContext(req, res, next) {
  try {
    const { emp, branch, error } = await loadEmployee(req, req.params.employeeId);
    if (error) return res.status(error.status).json({ error: error.message });
    res.json({
      context: tpl.buildContext(emp, { branch }),
      job_presets: Object.entries(tpl.JOB_DEFINITIONS)
        .map(([position, lines]) => ({ position, text: lines.join('\n') })),
      current: publicShape(await currentFor(emp._id).lean()),
    });
  } catch (err) { next(err); }
}

/** POST /api/employment-contracts/preview  { employee_id, overrides } */
async function preview(req, res, next) {
  try {
    const { employee_id, overrides } = req.body || {};
    const { emp, branch, error } = await loadEmployee(req, employee_id);
    if (error) return res.status(error.status).json({ error: error.message });
    const ctx = tpl.buildContext(emp, { branch, overrides: overrides || {} });
    res.json({ html: tpl.render(ctx), context: ctx });
  } catch (err) { next(err); }
}

/**
 * POST /api/employment-contracts  { employee_id, overrides, send }
 * Create the contract. With send=true the text is frozen and a signing link is
 * minted — after that the wording cannot change without issuing a new one,
 * because the employee is being asked to sign this exact text.
 */
async function create(req, res, next) {
  try {
    const { employee_id, overrides, send } = req.body || {};
    const { emp, branch, error } = await loadEmployee(req, employee_id);
    if (error) return res.status(error.status).json({ error: error.message });

    const existing = await currentFor(emp._id).lean();
    if (existing && ['sent', 'signed', 'approved'].includes(existing.status) && !req.body.replace) {
      return res.status(409).json({
        error: 'לעובד/ת כבר קיים חוזה פעיל. לביטולו והנפקת חוזה חדש יש לסמן "החלף חוזה קיים".',
        current: publicShape(existing),
      });
    }

    const ctx = tpl.buildContext(emp, { branch, overrides: overrides || {} });
    const doc = await EmploymentContract.create({
      employee_id: emp._id,
      branch_id: emp.branch_id || null,
      variant: ctx.variant,
      status: send ? 'sent' : 'draft',
      fields: ctx,
      html: tpl.render(ctx),
      access_token: send ? EmploymentContract.newToken() : null,
      token_expires_at: send ? new Date(Date.now() + SIGN_LINK_DAYS * 864e5) : null,
      sent_at: send ? new Date() : null,
      created_by: req.user?.id || null,
      created_by_name: req.user?.full_name || '',
    });
    res.status(201).json({ contract: publicShape(doc), sign_url: signUrl(req, doc) });
  } catch (err) { next(err); }
}

const signUrl = (req, doc) => (doc.access_token
  ? `${process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`}/sign-contract/${doc.access_token}`
  : null);

/** POST /api/employment-contracts/:id/send — mint (or re-mint) the link. */
async function send(req, res, next) {
  try {
    const doc = await EmploymentContract.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'חוזה לא נמצא' });
    const scope = branchScopeOf(req);
    if (scope && !scope.map(String).includes(String(doc.branch_id))) {
      return res.status(403).json({ error: 'אין הרשאה' });
    }
    if (['signed', 'approved'].includes(doc.status)) {
      return res.status(409).json({ error: 'החוזה כבר נחתם' });
    }
    doc.access_token = EmploymentContract.newToken();
    doc.token_expires_at = new Date(Date.now() + SIGN_LINK_DAYS * 864e5);
    doc.sent_at = new Date();
    doc.status = 'sent';
    await doc.save();

    const url = signUrl(req, doc);
    // Most staff logins carry a synthetic address, so email is best-effort and
    // the link is always returned for WhatsApp — never assume it was delivered.
    const emp = await Employee.findById(doc.employee_id).select('full_name email').lean();
    let emailed = false;
    if (emp?.email && emp.email.includes('@') && !/@gan-halomot\.local$/i.test(emp.email)) {
      try {
        await dispatchEmail({
          to: emp.email,
          subject: 'הסכם העסקה לחתימה — גן החלומות',
          html: `<div dir="rtl">שלום ${emp.full_name},<br/><br/>
            להלן הסכם ההעסקה שלך לחתימה. ניתן לקרוא ולחתום ישירות מהנייד:<br/><br/>
            <a href="${url}">${url}</a><br/><br/>
            הקישור תקף ל-${SIGN_LINK_DAYS} ימים.<br/><br/>גן החלומות ע.ר</div>`,
        });
        emailed = true;
      } catch (e) { console.error('[contract] email failed:', e.message); }
    }
    res.json({ contract: publicShape(doc), sign_url: url, emailed });
  } catch (err) { next(err); }
}

/** POST /api/employment-contracts/:id/approve — accounting confirms. */
async function approve(req, res, next) {
  try {
    if (!isApprover(req)) {
      return res.status(403).json({ error: 'רק הנהלת חשבונות או מנהל מערכת יכולים לאשר חוזה' });
    }
    const doc = await EmploymentContract.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'חוזה לא נמצא' });
    if (!['signed', 'uploaded'].includes(doc.status)) {
      return res.status(409).json({ error: 'ניתן לאשר רק חוזה חתום או חוזה שהועלה' });
    }
    doc.status = 'approved';
    doc.approved_by = req.user?.id || null;
    doc.approved_by_name = req.user?.full_name || '';
    doc.approved_at = new Date();
    // The link has done its job — retire it so a stale copy can't be reused.
    doc.access_token = null;
    await doc.save();
    res.json({ contract: publicShape(doc) });
  } catch (err) { next(err); }
}

/** POST /api/employment-contracts/waive  { employee_id, reason } */
async function waive(req, res, next) {
  try {
    const { employee_id, reason } = req.body || {};
    const { emp, error } = await loadEmployee(req, employee_id);
    if (error) return res.status(error.status).json({ error: error.message });
    if (!String(reason || '').trim()) {
      return res.status(400).json({ error: 'יש לציין סיבה לוויתור על חוזה' });
    }
    const doc = await EmploymentContract.create({
      employee_id: emp._id,
      branch_id: emp.branch_id || null,
      variant: emp.salary_type === 'global' ? 'global' : 'hourly',
      status: 'waived',
      html: '',
      waived_reason: String(reason).trim(),
      waived_by: req.user?.id || null,
      waived_by_name: req.user?.full_name || '',
      waived_at: new Date(),
      created_by: req.user?.id || null,
      created_by_name: req.user?.full_name || '',
    });
    res.status(201).json({ contract: publicShape(doc) });
  } catch (err) { next(err); }
}

/**
 * POST /api/employment-contracts/upload  { employee_id, file_data, file_name, file_mimetype }
 * A contract signed on paper. It lands as `uploaded` and still needs
 * accounting's confirmation, exactly like a digitally signed one.
 */
async function upload(req, res, next) {
  try {
    const { employee_id, file_data, file_name, file_mimetype } = req.body || {};
    const { emp, error } = await loadEmployee(req, employee_id);
    if (error) return res.status(error.status).json({ error: error.message });
    if (!file_data) return res.status(400).json({ error: 'יש לצרף קובץ' });
    const doc = await EmploymentContract.create({
      employee_id: emp._id,
      branch_id: emp.branch_id || null,
      variant: emp.salary_type === 'global' ? 'global' : 'hourly',
      status: 'uploaded',
      html: '',
      uploaded_file: {
        data: String(file_data).replace(/^data:[^;]+;base64,/, ''),
        name: file_name || 'contract',
        mimetype: file_mimetype || 'application/pdf',
        uploaded_by_name: req.user?.full_name || '',
        uploaded_at: new Date(),
      },
      created_by: req.user?.id || null,
      created_by_name: req.user?.full_name || '',
    });
    res.status(201).json({ contract: publicShape(doc) });
  } catch (err) { next(err); }
}

/** GET /api/employment-contracts/:id/file — the contract as PDF (or the upload). */
async function file(req, res, next) {
  try {
    const doc = await EmploymentContract.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'חוזה לא נמצא' });
    const scope = branchScopeOf(req);
    if (scope && !scope.map(String).includes(String(doc.branch_id))) {
      return res.status(403).json({ error: 'אין הרשאה' });
    }
    if (doc.uploaded_file?.data) {
      res.setHeader('Content-Type', doc.uploaded_file.mimetype || 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.uploaded_file.name)}`);
      return res.send(Buffer.from(doc.uploaded_file.data, 'base64'));
    }
    if (!doc.html) return res.status(404).json({ error: 'אין מסמך להצגה' });
    const html = withSignature(doc);
    try {
      const buf = await htmlToPdf(html);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent('הסכם העסקה')}.pdf`);
      return res.send(buf);
    } catch (e) {
      console.error('[contract] PDF render failed, serving HTML:', e.message);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
  } catch (err) { next(err); }
}

/**
 * Re-render the frozen context with the signature stamped in. The stored
 * `html` is the unsigned text the employee agreed to; the signature is layered
 * on at read time so the signed copy can never disagree with what was signed.
 */
function withSignature(doc) {
  if (!doc.signature_data) return doc.html;
  return tpl.render(doc.fields || {}, {
    signature: {
      data_url: doc.signature_data,
      signed_at: doc.signed_at,
      signer_name: doc.signer_name,
      ip: doc.signed_ip,
    },
  });
}

// --- public (token) side --------------------------------------------------

/**
 * GET /api/public/contract/:token
 * The contract to read on the phone. Only the last 4 digits of the ת"ז are
 * hinted at — the signer proves she is the right person by entering them,
 * so a forwarded link alone is not enough to sign.
 */
async function publicGet(req, res, next) {
  try {
    const doc = await EmploymentContract.findOne({ access_token: req.params.token }).lean();
    if (!doc) return res.status(404).json({ error: 'הקישור אינו תקף' });
    if (doc.token_expires_at && doc.token_expires_at < new Date()) {
      return res.status(410).json({ error: 'תוקף הקישור פג. יש לפנות למנהל/ת הסניף.' });
    }
    const emp = await Employee.findById(doc.employee_id).select('full_name israeli_id').lean();
    res.json({
      html: withSignature(doc),
      status: doc.status,
      already_signed: !!doc.signed_at,
      employee_name: emp?.full_name || '',
      id_hint: (emp?.israeli_id || '').slice(-4),
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/public/contract/:token/sign  { signature, signer_name, id_last4 }
 * Signing is one-way: once signed the token stops accepting new signatures, so
 * a re-opened link cannot overwrite a signature that already exists.
 */
async function publicSign(req, res, next) {
  try {
    const { signature, signer_name, id_last4 } = req.body || {};
    const doc = await EmploymentContract.findOne({ access_token: req.params.token });
    if (!doc) return res.status(404).json({ error: 'הקישור אינו תקף' });
    if (doc.token_expires_at && doc.token_expires_at < new Date()) {
      return res.status(410).json({ error: 'תוקף הקישור פג' });
    }
    if (doc.signed_at) return res.status(409).json({ error: 'החוזה כבר נחתם' });
    if (!signature || !String(signature).startsWith('data:image')) {
      return res.status(400).json({ error: 'נדרשת חתימה' });
    }
    const emp = await Employee.findById(doc.employee_id).select('full_name israeli_id').lean();
    const expected = (emp?.israeli_id || '').slice(-4);
    if (!expected || String(id_last4 || '').trim() !== expected) {
      return res.status(403).json({ error: 'ארבע ספרות ת"ז אינן תואמות' });
    }

    doc.signature_data = signature;
    doc.signer_name = String(signer_name || emp?.full_name || '').trim();
    doc.signer_id_last4 = expected;
    doc.signed_at = new Date();
    doc.signed_ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    doc.status = 'signed';
    await doc.save();

    // Tell accounting there is something to confirm. Best-effort: a failed
    // notification must not undo a signature the employee just gave.
    try {
      const approvers = await User.find({ role: { $in: ['accountant', 'system_admin'] }, is_active: true })
        .select('email full_name').lean();
      const to = approvers.map(u => u.email)
        .filter(e => e && e.includes('@') && !/@gan-halomot\.local$/i.test(e));
      if (to.length) {
        await dispatchEmail({
          to: to.join(','),
          subject: `הסכם העסקה נחתם — ${emp?.full_name || ''}`,
          html: `<div dir="rtl">${emp?.full_name || ''} חתמה על הסכם ההעסקה.<br/>
                 יש לאשר אותו במסך העובדים כדי להשלים את הקליטה.</div>`,
        });
      }
    } catch (e) { console.error('[contract] approver notification failed:', e.message); }

    res.json({ ok: true });
  } catch (err) { next(err); }
}

module.exports = {
  list, statusMap, getContext, preview, create, send, approve, waive, upload, file,
  publicGet, publicSign,
};
