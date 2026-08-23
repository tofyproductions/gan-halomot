/**
 * הסכם העסקה — generate from the employee card, send a mobile signing link,
 * and route the signed contract to accounting for confirmation.
 *
 * The escapes matter as much as the happy path: there are ~80 people already
 * employed with no contract in the system, and without "התעלם" / "העלה" this
 * feature would mark every one of them as a problem on the day it ships.
 */
const { Employee, Branch, EmploymentContract, ContractAnnex, PayrollMonth, User } = require('../models');
const tpl = require('../services/employmentContract');
const terms = require('../services/employmentTerms');
const { htmlToPdf } = require('../services/htmlPdf');
const { dispatchEmail } = require('../services/email.service');
const letterhead = require('../services/letterhead');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SIGN_LINK_DAYS = 30;

/**
 * How big a scanned contract may be.
 *
 * The file is stored base64 INSIDE the contract document, and a MongoDB
 * document stops at 16MB. Base64 costs a third on top, so the real ceiling is
 * about 11.5MB of PDF — past it Mongo answers "object to insert too large" and
 * the manager is shown a sentence in English about byte counts. Bigger still
 * and express's own parser gives up around 17MB with a RangeError, before any
 * of this code runs.
 *
 * So the limit is stated, checked, and explained in Hebrew, on both sides. The
 * client checks so nobody waits out a long upload to be refused at the end;
 * the server checks because the client is not the only way in.
 */
const MAX_CONTRACT_FILE_BYTES = 11 * 1024 * 1024;

const base64Bytes = (s) => {
  const body = String(s).replace(/^data:[^;]+;base64,/, '');
  const padding = (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor(body.length * 3 / 4) - padding);
};

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/** null when the file fits, an error sentence when it does not. */
function tooLarge(fileData) {
  const bytes = base64Bytes(fileData);
  if (bytes <= MAX_CONTRACT_FILE_BYTES) return null;
  return `הקובץ גדול מדי (${mb(bytes)}). המקסימום הוא ${mb(MAX_CONTRACT_FILE_BYTES)} — סרקו שוב באיכות נמוכה יותר או פצלו לקבצים.`;
}

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

/** The annex parts, in the shape the contract template lists them. */
const annexParts = async () => (await ContractAnnex.find({ is_active: true })
  .select('title part page_count').sort({ part: 1 }).lean())
  .map(a => ({ title: a.title, part: a.part, page_count: a.page_count }));

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
    const ctx = tpl.buildContext(emp, { branch, overrides: { annex_c_parts: await annexParts(), ...(overrides || {}) } });
    res.json({ html: letterhead.inject(tpl.render(ctx)), context: ctx });
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

    const ctx = tpl.buildContext(emp, { branch, overrides: { annex_c_parts: await annexParts(), ...(overrides || {}) } });
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
    const oversize = tooLarge(file_data);
    if (oversize) return res.status(413).json({ error: oversize });
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
  if (!doc.signature_data) return letterhead.inject(doc.html);
  return letterhead.inject(tpl.render(doc.fields || {}, {
    signature: {
      data_url: doc.signature_data,
      signed_at: doc.signed_at,
      signer_name: doc.signer_name,
      ip: doc.signed_ip,
    },
  }));
}

// --- standing annexes (נספח ג' — ונשמרתם) --------------------------------

/** The annex parts as a light list — never the base64 payload. */
const annexList = () => ContractAnnex.find({ is_active: true })
  .select('-file_data').sort({ annex_key: 1, part: 1 }).lean();

/** GET /api/employment-contracts/annexes */
async function listAnnexes(req, res, next) {
  try {
    const parts = await annexList();
    res.json({ annexes: parts.map(p => ({ ...p, id: String(p._id) })) });
  } catch (err) { next(err); }
}

/**
 * POST /api/employment-contracts/annexes
 * Replacing a part supersedes the previous one rather than deleting it — a
 * contract signed against last year's manual must still resolve to the file
 * the employee actually saw.
 */
async function uploadAnnex(req, res, next) {
  try {
    if (!isApprover(req)) {
      return res.status(403).json({ error: 'רק הנהלת חשבונות או מנהל מערכת יכולים לעדכן נספחים' });
    }
    const { annex_key, title, part, file_name, file_data, mime_type, page_count } = req.body || {};
    if (!file_data || !file_name) return res.status(400).json({ error: 'יש לצרף קובץ' });
    const oversizeAnnex = tooLarge(file_data);
    if (oversizeAnnex) return res.status(413).json({ error: oversizeAnnex });
    const key = annex_key || 'c';
    const partNum = Number(part) || 1;
    await ContractAnnex.updateMany({ annex_key: key, part: partNum, is_active: true }, { is_active: false });
    const doc = await ContractAnnex.create({
      annex_key: key,
      title: title || 'נספח ג׳ — ונשמרתם',
      part: partNum,
      file_name,
      mime_type: mime_type || 'application/pdf',
      page_count: Number(page_count) || 0,
      file_data: String(file_data).replace(/^data:[^;]+;base64,/, ''),
      size_bytes: Buffer.from(String(file_data).replace(/^data:[^;]+;base64,/, ''), 'base64').length,
      uploaded_by: req.user?.id || null,
      uploaded_by_name: req.user?.full_name || '',
    });
    const { file_data: _omit, ...light } = doc.toObject();
    res.status(201).json({ annex: { ...light, id: String(doc._id) } });
  } catch (err) { next(err); }
}

/**
 * GET /api/employment-contracts/annexes/:id/file — also reachable publicly
 * from the signing page, so the employee can read it before signing.
 *
 * The annex parts are ~3MB each and never change. Reading one out of Mongo
 * costs a 4MB base64 string plus a 3MB Buffer, and a signer opens all four in
 * a row — 28MB of churn per signature on a 512MB instance that already runs
 * Chromium. So each part is materialised to the OS temp dir on first read and
 * streamed from there afterwards: constant memory, and the cache dies with the
 * instance (which is fine — it rebuilds itself on the next read).
 */
const ANNEX_CACHE_DIR = path.join(os.tmpdir(), 'gan-annexes');

async function annexFile(req, res, next) {
  try {
    const id = String(req.params.id || '');
    if (!/^[a-f0-9]{24}$/i.test(id)) return res.status(404).json({ error: 'נספח לא נמצא' });

    const meta = await ContractAnnex.findById(id).select('-file_data').lean();
    if (!meta) return res.status(404).json({ error: 'נספח לא נמצא' });

    const cached = path.join(ANNEX_CACHE_DIR, `${id}.bin`);
    if (!fs.existsSync(cached)) {
      const doc = await ContractAnnex.findById(id).select('file_data').lean();
      if (!doc?.file_data) return res.status(404).json({ error: 'נספח לא נמצא' });
      fs.mkdirSync(ANNEX_CACHE_DIR, { recursive: true });
      // Write via a temp name and rename, so two concurrent readers can never
      // serve a half-written file.
      const tmp = `${cached}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, Buffer.from(doc.file_data, 'base64'));
      fs.renameSync(tmp, cached);
    }

    res.setHeader('Content-Type', meta.mime_type || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.file_name)}`);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    fs.createReadStream(cached).pipe(res);
  } catch (err) { next(err); }
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
    const annexes = await annexList();
    res.json({
      html: withSignature(doc),
      status: doc.status,
      already_signed: !!doc.signed_at,
      employee_name: emp?.full_name || '',
      id_hint: (emp?.israeli_id || '').slice(-4),
      // The employee must be able to actually open נספח ג' before she signs it.
      annexes: annexes.map(a => ({
        id: String(a._id), title: a.title, part: a.part,
        file_name: a.file_name, page_count: a.page_count,
        url: `/api/public/contract-annex/${a._id}`,
      })),
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


// ---------------------------------------------------------------------------
// תנאי העסקה — the pay a signed contract actually agrees to.
//
// A contract used to be a document and nothing more: an accountant could file
// one that says 60₪ while payroll kept paying 52₪, and no screen anywhere
// noticed the two disagreed. These three endpoints let the pay be recorded at
// the same moment as the paper, with a date on it.
//
// ACCOUNTANT AND ADMIN ONLY, all three — including the read. A branch manager
// may file her own hire's contract (that is why the routes let her in at all)
// but what anybody is paid is not hers to see or to set.
// ---------------------------------------------------------------------------

/** Months already closed cannot be moved — say which, rather than silently skipping them. */
async function finalizedMonthsFrom(employeeId, fromMonth) {
  const rows = await PayrollMonth.find({
    employee_id: employeeId, status: 'finalized', month: { $gte: fromMonth },
  }).select('month').sort({ month: 1 }).lean();
  return rows.map((r) => r.month);
}

const termsRow = (r) => ({
  id: String(r._id || ''),
  effective_month: r.effective_month,
  effective_date: r.effective_date,
  salary_type: r.salary_type,
  hourly_rate: r.hourly_rate,
  global_salary: r.global_salary,
  global_ot_rate: r.global_ot_rate,
  required_hours: r.required_hours,
  source: r.source,
  note: r.note,
  created_by_name: r.created_by_name,
  created_at: r.created_at,
});

/** GET /api/employment-contracts/terms/:employeeId — current terms + every recorded change. */
async function termsHistory(req, res, next) {
  try {
    if (!isApprover(req)) return res.status(403).json({ error: 'רק הנהלת חשבונות או מנהל מערכת' });
    const emp = await Employee.findById(req.params.employeeId)
      .select('full_name salary_type amuta_distribution terms_history start_date').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });
    const history = (emp.terms_history || [])
      .slice()
      .sort((a, b) => (b.effective_month || '').localeCompare(a.effective_month || '')
        || new Date(b.created_at || 0) - new Date(a.created_at || 0));
    res.json({
      card: terms.termsFromCard(emp),
      current: terms.termsForMonth(emp, terms.monthOf(new Date())) || terms.termsFromCard(emp),
      history: history.map(termsRow),
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/employment-contracts/terms/preview
 * What the change would do, without doing it — so the dialog can show the
 * before/after, the month it really starts, and which closed months it cannot
 * reach, BEFORE the accountant commits to it.
 */
async function previewTerms(req, res, next) {
  try {
    if (!isApprover(req)) return res.status(403).json({ error: 'רק הנהלת חשבונות או מנהל מערכת' });
    const emp = await Employee.findById(req.body?.employee_id)
      .select('full_name salary_type amuta_distribution terms_history start_date').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const plan = terms.planTermsChange(emp, req.body || {});
    if (plan.errors.length) return res.status(400).json({ error: plan.errors[0], errors: plan.errors });

    res.json({
      effective_month: plan.effective_month,
      mid_month: plan.mid_month,
      nothing_changed: plan.nothingChanged,
      previous: plan.previous,
      next: plan.next,
      finalized_months: await finalizedMonthsFrom(emp._id, plan.effective_month),
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/employment-contracts/terms
 * Record the change. `contract_id` ties it to the הסכם it came from, which is
 * what makes the history answer "why" and not only "what".
 */
async function saveTerms(req, res, next) {
  try {
    if (!isApprover(req)) return res.status(403).json({ error: 'רק הנהלת חשבונות או מנהל מערכת' });
    const emp = await Employee.findById(req.body?.employee_id);
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const plan = terms.applyTermsChange(emp, req.body || {}, {
      id: req.user?.id || null, full_name: req.user?.full_name || '',
    });
    if (plan.errors.length) return res.status(400).json({ error: plan.errors[0], errors: plan.errors });

    const finalized = await finalizedMonthsFrom(emp._id, plan.effective_month);
    await emp.save();

    res.status(201).json({
      ok: true,
      effective_month: plan.effective_month,
      previous: plan.previous,
      next: plan.next,
      // Recorded, but those months are frozen and will keep paying the old
      // rate until somebody reopens them. Reported, never done quietly.
      finalized_months: finalized,
    });
  } catch (err) { next(err); }
}

module.exports = {
  MAX_CONTRACT_FILE_BYTES,
  list, statusMap, getContext, preview, create, send, approve, waive, upload, file,
  listAnnexes, uploadAnnex, annexFile,
  termsHistory, previewTerms, saveTerms,
  publicGet, publicSign,
};
