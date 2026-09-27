/**
 * הסכם העסקה — generate from the employee card, send a mobile signing link,
 * and route the signed contract to accounting for confirmation.
 *
 * The escapes matter as much as the happy path: there are ~80 people already
 * employed with no contract in the system, and without "התעלם" / "העלה" this
 * feature would mark every one of them as a problem on the day it ships.
 */
const {
  Employee, Branch, EmploymentContract, ContractAnnex, PayrollMonth, User, EmployeeCommitment,
  EmployeeDocument, Setting,
} = require('../models');
const tpl = require('../services/employmentContract');
const terms = require('../services/employmentTerms');
const storage = require('../services/storage.service');
const { htmlToPdf } = require('../services/htmlPdf');
const { dispatchEmail } = require('../services/email.service');
const letterhead = require('../services/letterhead');
const { branchManagerFilter } = require('../services/branch-recipients.service');
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
const MAX_STORED_FILE_BYTES = 40 * 1024 * 1024;   // in the bucket: only the connection limits it
const MAX_INLINE_FILE_BYTES = 11 * 1024 * 1024;   // in the document: MongoDB stops at 16MB

const maxUploadBytes = () =>
  (storage.isConfigured() ? MAX_STORED_FILE_BYTES : MAX_INLINE_FILE_BYTES);

const base64Bytes = (s) => {
  const body = String(s).replace(/^data:[^;]+;base64,/, '');
  const padding = (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor(body.length * 3 / 4) - padding);
};

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/**
 * The filename as the person typed it, not as busboy guessed it.
 *
 * multipart field values arrive as bytes and busboy decodes them latin1 by
 * default, so "חוזה חתום.pdf" reached us as "×××× ××ª××.pdf" and would have
 * been shown that way in the contract list forever. Re-reading those bytes as
 * UTF-8 restores it. Guarded, because a name that was already decoded
 * correctly must not be mangled by decoding it twice.
 */
function uploadedName(raw) {
  const name = String(raw || 'contract');
  const reread = Buffer.from(name, 'latin1').toString('utf8');
  return reread.includes('\uFFFD') ? name : reread;
}

/** null when the file fits, an error sentence when it does not. */
function oversizeMessage(bytes) {
  const max = maxUploadBytes();
  if (bytes <= max) return null;
  // "sorry, 11MB" is infuriating when the fix is one environment variable on
  // the server rather than anything the person reading it did wrong.
  return storage.isConfigured()
    ? `הקובץ גדול מדי (${mb(bytes)}). המקסימום הוא ${mb(max)}.`
    : `הקובץ גדול מדי (${mb(bytes)}). המקסימום הוא ${mb(max)}, כי אחסון קבצים חיצוני אינו מוגדר בשרת והקובץ נשמר בתוך בסיס הנתונים. סרקו באיכות נמוכה יותר, או הגדירו אחסון כדי להסיר את המגבלה.`;
}

const tooLarge = (fileData) => oversizeMessage(base64Bytes(fileData));

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
  const commitment = await EmployeeCommitment.findOne({ employee_id: emp._id }).lean();
  return { emp, branch, commitment };
}

/**
 * Write the weekly table back onto the employee's commitment.
 *
 * The contract screen is now a second door onto the same schedule that שכר ←
 * התחייבויות edits, and it has to be a door rather than a copy: the commitment
 * is what attendance compares against and what sick, absence and paid-vacation
 * days are counted on. A weekly table that lived only inside the contract would
 * put "רביעי חופש" on the signed page while the system went on expecting her
 * every Wednesday.
 *
 * Saturday is never stored — the commitment's own schema stops at Friday, and
 * the contract says separately that Saturday is the day of rest.
 *
 * Only days the manager actually described are written. An untouched row is not
 * an assertion that she is off that day, and overwriting a schedule somebody
 * built in the payroll screen with a form nobody filled in is how a correct
 * commitment quietly becomes an empty one.
 */
async function syncCommitment(emp, weeklyHours) {
  if (!Array.isArray(weeklyHours)) return null;
  const days = weeklyHours
    .filter(r => Number(r.weekday) >= 0 && Number(r.weekday) <= 5)
    .filter(r => r.off || r.in || r.out)
    .map(r => ({
      day: Number(r.weekday),
      is_off: !!r.off,
      start_hhmm: r.off ? '' : (r.in || ''),
      end_hhmm: r.off ? '' : (r.out || ''),
    }))
    .sort((a, b) => a.day - b.day);
  if (!days.length) return null;

  const existing = await EmployeeCommitment.findOne({ employee_id: emp._id }).select('_id').lean();
  // branch_id is required on the commitment, so an employee with no branch can
  // update one that already exists but cannot have the first one created here.
  // Silent rather than an error: the contract itself is correct either way, and
  // an employee with no branch is a card to fix, not a contract to block.
  if (!existing && !emp.branch_id) return null;

  return EmployeeCommitment.findOneAndUpdate(
    { employee_id: emp._id },
    { $set: { days }, $setOnInsert: { employee_id: emp._id, branch_id: emp.branch_id } },
    { new: true, upsert: true },
  ).lean();
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
  uploaded: !!(d.uploaded_file?.data || d.uploaded_file?.storage_key),
  uploaded_name: d.uploaded_file?.name || '',
  uploaded_at: d.uploaded_file?.uploaded_at || null,
  created_by_name: d.created_by_name,
  created_at: d.created_at,
  token_expires_at: d.token_expires_at,
  has_link: !!d.access_token,
  admin_approved_by_name: d.admin_approved_by_name,
  admin_approved_at: d.admin_approved_at,
  employer_signed_at: d.employer_signed_at,
  employer_signer_name: d.employer_signer_name,
  distributed_at: d.distributed_at,
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
    const { emp, branch, commitment, error } = await loadEmployee(req, req.params.employeeId);
    if (error) return res.status(error.status).json({ error: error.message });
    res.json({
      context: tpl.buildContext(emp, { branch, commitment }),
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
    const { emp, branch, commitment, error } = await loadEmployee(req, employee_id);
    if (error) return res.status(error.status).json({ error: error.message });
    const ctx = tpl.buildContext(emp, { branch, commitment, overrides: { annex_c_parts: await annexParts(), ...(overrides || {}) } });
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
    const { emp, branch, commitment, error } = await loadEmployee(req, employee_id);
    if (error) return res.status(error.status).json({ error: error.message });

    const existing = await currentFor(emp._id).lean();
    if (existing && ['pending_admin', 'sent', 'signed', 'approved'].includes(existing.status) && !req.body.replace) {
      return res.status(409).json({
        error: 'לעובד/ת כבר קיים חוזה פעיל. לביטולו והנפקת חוזה חדש יש לסמן "החלף חוזה קיים".',
        current: publicShape(existing),
      });
    }

    // The schedule goes back to the commitment BEFORE the text is built, so the
    // contract is rendered from the same rows the system will be counting
    // against — not from a copy that agreed with them only at this instant.
    const saved = await syncCommitment(emp, overrides?.weekly_hours);

    const ctx = tpl.buildContext(emp, {
      branch,
      commitment: saved || commitment,
      overrides: { annex_c_parts: await annexParts(), ...(overrides || {}) },
    });

    // A contract a branch manager issues carries salary terms she agreed to on
    // the gan's behalf — an admin approves those BEFORE any link reaches the
    // employee. A contract an admin (or accounting) issues is its own approval.
    const autoApproved = isApprover(req);
    const sendStatus = autoApproved ? 'sent' : 'pending_admin';
    const doc = await EmploymentContract.create({
      employee_id: emp._id,
      branch_id: emp.branch_id || null,
      variant: ctx.variant,
      status: send ? sendStatus : 'draft',
      fields: ctx,
      html: tpl.render(ctx),
      access_token: send && autoApproved ? EmploymentContract.newToken() : null,
      token_expires_at: send && autoApproved ? new Date(Date.now() + SIGN_LINK_DAYS * 864e5) : null,
      sent_at: send && autoApproved ? new Date() : null,
      admin_approved_by: send && autoApproved ? req.user?.id || null : null,
      admin_approved_by_name: send && autoApproved ? req.user?.full_name || '' : '',
      admin_approved_at: send && autoApproved ? new Date() : null,
      created_by: req.user?.id || null,
      created_by_name: req.user?.full_name || '',
    });
    let emailed = false;
    if (send && autoApproved) {
      emailed = await emailSignLink(req, doc, emp);
    } else if (send) {
      notifyAdminsPending(doc, emp).catch(e => console.error('[contract] pending-admin notify failed:', e.message));
    }
    res.status(201).json({ contract: publicShape(doc), sign_url: signUrl(req, doc), emailed });
  } catch (err) { next(err); }
}

/** The signing-link mail. Best-effort; the link always comes back for WhatsApp. */
async function emailSignLink(req, doc, empMaybe) {
  const url = signUrl(req, doc);
  if (!url) return false;
  const emp = empMaybe || await Employee.findById(doc.employee_id).select('full_name email').lean();
  if (!emp?.email || !emp.email.includes('@') || /@gan-halomot\.local$/i.test(emp.email)) return false;
  try {
    await dispatchEmail({
      to: emp.email,
      subject: 'הסכם העסקה לחתימה — גן החלומות',
      html: `<div dir="rtl">שלום ${emp.full_name},<br/><br/>
        להלן הסכם ההעסקה שלך לחתימה. ניתן לקרוא ולחתום ישירות מהנייד:<br/><br/>
        <a href="${url}">${url}</a><br/><br/>
        הקישור תקף ל-${SIGN_LINK_DAYS} ימים.<br/><br/>גן החלומות ע.ר</div>`,
    });
    return true;
  } catch (e) { console.error('[contract] email failed:', e.message); return false; }
}

/** Tell the admins a branch manager's contract waits for their yes. */
async function notifyAdminsPending(doc, emp) {
  const to = await require('../services/office-recipients.service').officeEmails('hr');
  if (!to.length) return;
  await dispatchEmail({
    to: to.join(','),
    subject: `חוזה העסקה ממתין לאישורך — ${emp?.full_name || ''}`,
    html: `<div dir="rtl">${doc.created_by_name || 'מנהלת סניף'} הנפיקה חוזה העסקה עבור ${emp?.full_name || ''}.<br/>
      החוזה ממתין לאישור מנהל/ת מערכת לפני שיישלח לעובד/ת לחתימה.<br/>
      האישור נמצא בכרטיס העובד/ת, בחלון "הסכם העסקה".</div>`,
  });
}

/**
 * POST /api/employment-contracts/:id/approve-send — the admin's yes on a
 * branch-manager-issued contract: mints the link and sends it to the employee.
 */
async function approveSend(req, res, next) {
  try {
    if (!isApprover(req)) {
      return res.status(403).json({ error: 'רק מנהל/ת מערכת או הנהלת חשבונות מאשרים שליחת חוזה' });
    }
    const doc = await EmploymentContract.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'חוזה לא נמצא' });
    if (doc.status !== 'pending_admin') {
      return res.status(409).json({ error: 'החוזה אינו ממתין לאישור' });
    }
    doc.admin_approved_by = req.user?.id || null;
    doc.admin_approved_by_name = req.user?.full_name || '';
    doc.admin_approved_at = new Date();
    doc.access_token = EmploymentContract.newToken();
    doc.token_expires_at = new Date(Date.now() + SIGN_LINK_DAYS * 864e5);
    doc.sent_at = new Date();
    doc.status = 'sent';
    await doc.save();
    const emailed = await emailSignLink(req, doc);
    res.json({ contract: publicShape(doc), sign_url: signUrl(req, doc), emailed });
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
    if (doc.status === 'pending_admin' && !isApprover(req)) {
      return res.status(403).json({ error: 'החוזה ממתין לאישור מנהל/ת מערכת — רק אישור זה שולח אותו לעובד/ת' });
    }
    if (doc.status === 'pending_admin') {
      // An approver resending a pending contract IS the approval.
      doc.admin_approved_by = req.user?.id || null;
      doc.admin_approved_by_name = req.user?.full_name || '';
      doc.admin_approved_at = new Date();
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

// --- the manager's saved signature + counter-signing ----------------------

/** GET /api/employment-contracts/my-signature — has this user drawn one? */
async function getMySignature(req, res, next) {
  try {
    const u = await User.findById(req.user?.id).select('signature_image').lean();
    res.json({ signature_image: u?.signature_image || null });
  } catch (err) { next(err); }
}

/** PUT /api/employment-contracts/my-signature  { signature } — drawn once, reused. */
async function setMySignature(req, res, next) {
  try {
    const sig = String(req.body?.signature || '');
    if (!sig.startsWith('data:image') || sig.length > 200 * 1024) {
      return res.status(400).json({ error: 'נדרשת חתימה מצוירת (עד 200KB)' });
    }
    await User.updateOne({ _id: req.user?.id }, { $set: { signature_image: sig } });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** The accountant's inbox, as payroll already knows it. */
async function accountantRecipients() {
  const [listDoc, single] = await Promise.all([
    Setting.findOne({ key: 'accountant_emails' }).lean(),
    Setting.findOne({ key: 'accountant_email' }).lean(),
  ]);
  const list = Array.isArray(listDoc?.value) ? listDoc.value : [];
  const all = [...list, single?.value].map(e => String(e || '').trim()).filter(e => e.includes('@'));
  return [...new Set(all)];
}

/**
 * POST /api/employment-contracts/:id/countersign
 *
 * The employee signed; the branch manager (or an admin) confirms — and her
 * SAVED signature is stamped as the employer's. One click, because the drawing
 * happened once, in advance. The completed contract then goes out on its own:
 * to accounting, into the employee's תיק, and to the employee herself.
 */
async function countersign(req, res, next) {
  try {
    const doc = await EmploymentContract.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'חוזה לא נמצא' });
    const scope = branchScopeOf(req);
    if (scope && !scope.map(String).includes(String(doc.branch_id))) {
      return res.status(403).json({ error: 'אין הרשאה' });
    }
    if (doc.status !== 'signed') {
      return res.status(409).json({ error: 'ניתן לחתום כמעסיק רק על חוזה שהעובד/ת חתמה עליו' });
    }
    if (doc.employer_signed_at) {
      return res.status(409).json({ error: 'החוזה כבר נחתם על ידי המעסיק' });
    }
    const u = await User.findById(req.user?.id).select('signature_image full_name').lean();
    if (!u?.signature_image) {
      return res.status(400).json({
        error: 'לא הוגדרה חתימה. יש לצייר חתימה פעם אחת (בחלון החוזה — "החתימה שלי") ואז לאשר.',
        needs_signature: true,
      });
    }

    doc.employer_signature_data = u.signature_image;
    doc.employer_signer_name = u.full_name || '';
    doc.employer_signed_by = req.user?.id || null;
    doc.employer_signed_at = new Date();
    await doc.save();

    const distributed = await distributeSignedContract(doc)
      .catch(e => { console.error('[contract] distribution failed:', e.message); return null; });
    if (distributed) {
      doc.distributed_at = new Date();
      await doc.save();
    }
    res.json({
      contract: publicShape(doc),
      distributed: !!distributed,
      distribution: distributed || undefined,
    });
  } catch (err) { next(err); }
}

/**
 * The completed (double-signed) contract, delivered everywhere it belongs:
 * accounting's inbox, the employee's document file, and the employee's email.
 * Best-effort per lane — one failed mail must not hide the contract from the
 * other two readers; what happened is reported back to the button.
 */
async function distributeSignedContract(doc) {
  const emp = await Employee.findById(doc.employee_id).select('full_name email branch_id').lean();
  const pdf = await htmlToPdf(withSignature(doc));
  const fileName = `הסכם העסקה — ${emp?.full_name || ''}.pdf`;
  const out = { filed: false, accountant: false, employee: false };

  // 1. The employee's תיק — this is where anybody will look in a year.
  try {
    const record = {
      employee_id: doc.employee_id,
      branch_id: doc.branch_id || emp?.branch_id || null,
      name: 'הסכם העסקה חתום',
      description: `נחתם ע"י העובד/ת ${doc.signer_name || ''} ונחתם ע"י ${doc.employer_signer_name || 'המעסיק'}`,
      doc_type: 'employment_contract',
      file_name: fileName,
      file_mimetype: 'application/pdf',
      size_bytes: pdf.length,
      storage_key: null,
      data: null,
      file_data: null,
      created_by: doc.employer_signed_by || null,
    };
    if (storage.isConfigured()) {
      try {
        const key = storage.makeKey('contracts', 'pdf');
        await storage.putObject({ key, body: pdf, contentType: 'application/pdf' });
        record.storage_key = key;
      } catch (e) {
        console.error('[contract] storage put failed, keeping inline:', e.message);
        record.file_data = pdf.toString('base64');
      }
    } else {
      record.file_data = pdf.toString('base64');
    }
    await EmployeeDocument.create(record);
    out.filed = true;
  } catch (e) { console.error('[contract] filing failed:', e.message); }

  const attachment = {
    filename: fileName,
    contentBase64: pdf.toString('base64'),
    contentType: 'application/pdf',
  };

  // 2. Accounting.
  try {
    const to = await accountantRecipients();
    if (to.length) {
      await dispatchEmail({
        to: to.join(','),
        subject: `הסכם העסקה חתום — ${emp?.full_name || ''}`,
        html: `<div dir="rtl">מצורף הסכם ההעסקה החתום של ${emp?.full_name || ''} (נחתם ע"י שני הצדדים).<br/>
          ההסכם שמור גם בתיק העובד/ת במערכת.</div>`,
        fileAttachments: [attachment],
      });
      out.accountant = true;
    }
  } catch (e) { console.error('[contract] accountant mail failed:', e.message); }

  // 3. The employee — her own copy of what she signed.
  try {
    if (emp?.email && emp.email.includes('@') && !/@gan-halomot\.local$/i.test(emp.email)) {
      await dispatchEmail({
        to: emp.email,
        subject: 'הסכם ההעסקה החתום שלך — גן החלומות',
        html: `<div dir="rtl">שלום ${emp.full_name},<br/><br/>
          מצורף עותק של הסכם ההעסקה שלך, חתום על ידי שני הצדדים.<br/>
          ברוכה הבאה לגן החלומות!<br/><br/>גן החלומות ע.ר</div>`,
        fileAttachments: [attachment],
      });
      out.employee = true;
    }
  } catch (e) { console.error('[contract] employee mail failed:', e.message); }

  return out;
}


/**
 * DELETE /api/employment-contracts/:id — a contract issued by mistake.
 *
 * Three identical "נשלח לחתימה" rows against one employee, created within a
 * minute of each other, is not history worth keeping: it is a form submitted
 * three times, and leaving it there means the next person cannot tell which
 * link the employee actually has.
 *
 * ONLY a contract nobody has signed. A signed or approved contract is the
 * evidence that an employment agreement exists, and the point of an electronic
 * signature is that the document behind it cannot quietly stop existing. A
 * wrongly-signed contract is superseded by a new one, never deleted — and the
 * refusal below says so rather than failing silently.
 *
 * A `waived` row is a recorded decision that this employee needs no contract,
 * which is also somebody's answer to a question, so it stays too.
 *
 * Deleting a `sent` contract retires its link by construction: the row is what
 * `publicGet` resolves the token against, so the moment it is gone the link
 * stops opening. That is the desired behaviour — the whole reason to delete a
 * mistaken send is that somebody may be holding a link they should not use.
 */
const DELETABLE = ['draft', 'pending_admin', 'sent'];

async function remove(req, res, next) {
  try {
    if (!isApprover(req)) {
      return res.status(403).json({ error: 'רק הנהלת חשבונות או מנהל מערכת יכולים למחוק חוזה' });
    }
    const doc = await EmploymentContract.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'חוזה לא נמצא' });

    if (!DELETABLE.includes(doc.status)) {
      const why = ['signed', 'approved', 'uploaded'].includes(doc.status)
        ? 'חוזה חתום אינו נמחק — הוא הראיה שההסכם קיים. אם החוזה שגוי, יש להנפיק חוזה חדש שיחליף אותו.'
        : 'ויתור על חוזה הוא החלטה מתועדת ואינו נמחק.';
      return res.status(409).json({ error: why });
    }

    // Who removed what, kept where the rest of this controller keeps its
    // record. There is no audit collection here, and inventing one for a
    // delete that only ever touches an unsigned draft would be the wrong
    // place to start.
    const emp = await Employee.findById(doc.employee_id).select('full_name').lean();
    console.log(
      `[contracts] ${req.user?.full_name || req.user?.id} deleted a ${doc.status} contract`
      + ` for ${emp?.full_name || doc.employee_id} (created ${doc.created_at?.toISOString?.() || '?'})`,
    );

    await doc.deleteOne();
    res.json({ ok: true, deleted: String(doc._id), status: doc.status });
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
    // Two ways in: a multipart file field (what the dialog sends now) or the
    // legacy `file_data` base64 string. Base64 inside JSON costs a third in
    // transfer and is half of why the ceiling was 11MB.
    const { employee_id, file_data, file_name, file_mimetype } = req.body || {};
    const { emp, error } = await loadEmployee(req, employee_id);
    if (error) return res.status(error.status).json({ error: error.message });

    const part = req.file;
    if (!part && !file_data) return res.status(400).json({ error: 'יש לצרף קובץ' });

    const buffer = part ? part.buffer
      : Buffer.from(String(file_data).replace(/^data:[^;]+;base64,/, ''), 'base64');
    const name = part ? uploadedName(part.originalname) : (file_name || 'contract');
    const mimetype = part ? part.mimetype : (file_mimetype || 'application/pdf');

    const oversize = oversizeMessage(buffer.length);
    if (oversize) return res.status(413).json({ error: oversize });

    const uploaded_file = {
      name, mimetype,
      size_bytes: buffer.length,
      uploaded_by_name: req.user?.full_name || '',
      uploaded_at: new Date(),
      storage_key: null,
      data: null,
    };

    if (storage.isConfigured()) {
      const ext = (name.split('.').pop() || 'pdf').toLowerCase();
      const key = storage.makeKey(`contracts/${emp.branch_id || 'misc'}`, ext);
      try {
        await storage.putObject({ key, body: buffer, contentType: mimetype });
        uploaded_file.storage_key = key;
      } catch (err) {
        // Falling back to the document here would silently reinstate the 16MB
        // ceiling for a file that may be well past it. Say what broke instead.
        console.error('[contract] storage put failed:', err.message);
        return res.status(502).json({
          error: `העלאת הקובץ לאחסון נכשלה: ${err.message}. בדקו את הגדרות האחסון.`,
        });
      }
    } else {
      uploaded_file.data = buffer.toString('base64');
    }

    const doc = await EmploymentContract.create({
      employee_id: emp._id,
      branch_id: emp.branch_id || null,
      variant: emp.salary_type === 'global' ? 'global' : 'hourly',
      status: 'uploaded',
      html: '',
      uploaded_file,
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
    // Streamed back through here rather than answered with a redirect: the
    // dialog fetches this as a blob with the bearer token, and a cross-origin
    // hop would need CORS on the bucket to work at all.
    if (doc.uploaded_file?.storage_key) {
      const signed = await storage.signedReadUrl(doc.uploaded_file.storage_key);
      const upstream = await fetch(signed);
      if (!upstream.ok) return res.status(502).json({ error: `שליפת הקובץ מהאחסון נכשלה (${upstream.status})` });
      res.setHeader('Content-Type', doc.uploaded_file.mimetype || 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.uploaded_file.name)}`);
      return res.send(Buffer.from(await upstream.arrayBuffer()));
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
  if (!doc.signature_data && !doc.employer_signature_data) return letterhead.inject(doc.html);
  return letterhead.inject(tpl.render(doc.fields || {}, {
    signature: doc.signature_data ? {
      data_url: doc.signature_data,
      signed_at: doc.signed_at,
      signer_name: doc.signer_name,
      ip: doc.signed_ip,
    } : null,
    employerSignature: doc.employer_signature_data ? {
      data_url: doc.employer_signature_data,
      signed_at: doc.employer_signed_at,
      signer_name: doc.employer_signer_name,
    } : null,
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
      // A contract must not stay blank where it names the person signing it.
      // Whatever the card didn't know, the signer completes right here.
      missing_fields: missingPersonalFields(doc.fields || {}),
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
 * The personal fields the contract's own text embeds. Anything empty here
 * prints as a ruled blank — which is exactly what the signer is asked to
 * complete before signing, so no signed contract carries an empty line where
 * the law expects a detail.
 */
const PERSONAL_FIELDS = [
  { key: 'address', label: 'כתובת מגורים' },
  { key: 'phone', label: 'טלפון' },
  { key: 'email', label: 'אימייל' },
  { key: 'religion', label: 'דת (לתשלום ימי חג)' },
  { key: 'bank_text', label: 'פרטי חשבון בנק', compound: 'bank' },
];

function missingPersonalFields(fields) {
  return PERSONAL_FIELDS
    .filter(f => !String(fields?.[f.key] || '').trim())
    .map(f => ({ key: f.compound || f.key, label: f.label }));
}

/**
 * What the signer may complete: her own personal details, nothing the manager
 * negotiated. Values land in the frozen merge fields (the signed render reads
 * them) AND on the employee card, so payroll knows them too.
 */
function applyFills(doc, emp, fills) {
  const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const empUpdate = {};
  const f = fills || {};
  const setIfEmpty = (ctxKey, empKey, value, max) => {
    const v = clean(value, max);
    if (!v || String(doc.fields?.[ctxKey] || '').trim()) return;
    doc.fields[ctxKey] = v;
    if (empKey && !String(emp?.[empKey] || '').trim()) empUpdate[empKey] = v;
  };
  doc.fields = doc.fields || {};
  setIfEmpty('address', 'address', f.address, 160);
  setIfEmpty('phone', 'phone', f.phone, 30);
  setIfEmpty('email', 'email', f.email, 120);
  setIfEmpty('religion', 'religion', f.religion, 40);
  if (!String(doc.fields.bank_text || '').trim()) {
    const bank = {
      bank_number: clean(f.bank_number, 10),
      bank_name: clean(f.bank_name, 60),
      bank_branch: clean(f.bank_branch, 10),
      bank_account: clean(f.bank_account, 30),
      bank_account_holder: clean(f.bank_account_holder, 80),
    };
    if (bank.bank_number && bank.bank_branch && bank.bank_account) {
      doc.fields.bank_text = [
        `בנק ${bank.bank_name ? `${bank.bank_name} (${bank.bank_number})` : bank.bank_number}`,
        `סניף ${bank.bank_branch}`,
        `חשבון ${bank.bank_account}`,
        bank.bank_account_holder ? `ע"ש ${bank.bank_account_holder}` : '',
      ].filter(Boolean).join(', ');
      for (const [k, v] of Object.entries(bank)) {
        if (v && !String(emp?.[k] || '').trim()) empUpdate[k] = v;
      }
    }
  }
  doc.markModified('fields');
  return empUpdate;
}

/**
 * POST /api/public/contract/:token/sign  { signature, signer_name, id_last4, fills }
 * Signing is one-way: once signed the token stops accepting new signatures, so
 * a re-opened link cannot overwrite a signature that already exists.
 */
async function publicSign(req, res, next) {
  try {
    const { signature, signer_name, id_last4, fills } = req.body || {};
    const doc = await EmploymentContract.findOne({ access_token: req.params.token });
    if (!doc) return res.status(404).json({ error: 'הקישור אינו תקף' });
    if (doc.token_expires_at && doc.token_expires_at < new Date()) {
      return res.status(410).json({ error: 'תוקף הקישור פג' });
    }
    if (doc.signed_at) return res.status(409).json({ error: 'החוזה כבר נחתם' });
    if (!signature || !String(signature).startsWith('data:image')) {
      return res.status(400).json({ error: 'נדרשת חתימה' });
    }
    const emp = await Employee.findById(doc.employee_id)
      .select('full_name israeli_id address phone email religion bank_number bank_name bank_branch bank_account bank_account_holder')
      .lean();
    const expected = (emp?.israeli_id || '').slice(-4);
    if (!expected || String(id_last4 || '').trim() !== expected) {
      return res.status(403).json({ error: 'ארבע ספרות ת"ז אינן תואמות' });
    }

    // A signature over a blank line is a contract missing a detail forever —
    // whatever the card didn't know, the signer supplies right now, or the
    // signature is refused with the exact list of what is still empty.
    const empUpdate = applyFills(doc, emp, fills);
    const stillMissing = missingPersonalFields(doc.fields);
    if (stillMissing.length) {
      return res.status(400).json({
        error: 'יש להשלים את הפרטים החסרים לפני החתימה',
        missing_fields: stillMissing,
      });
    }
    if (Object.keys(empUpdate).length) {
      await Employee.updateOne({ _id: doc.employee_id }, { $set: empUpdate })
        .catch(e => console.error('[contract] employee backfill failed:', e.message));
    }

    doc.signature_data = signature;
    doc.signer_name = String(signer_name || emp?.full_name || '').trim();
    doc.signer_id_last4 = expected;
    doc.signed_at = new Date();
    doc.signed_ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    doc.status = 'signed';
    await doc.save();

    // Tell the branch manager her signature is next, and accounting that the
    // wheel is turning. Best-effort: a failed notification must not undo a
    // signature the employee just gave.
    try {
      const [office, managers] = await Promise.all([
        require('../services/office-recipients.service').officeEmails('hr'),
        doc.branch_id
          ? User.find(branchManagerFilter(doc.branch_id)).select('email').lean().catch(() => [])
          : [],
      ]);
      const to = [...office, ...managers.map(u => u.email)
        .filter(e => e && e.includes('@') && !/@gan-halomot\.local$/i.test(e))];
      if (to.length) {
        await dispatchEmail({
          to: [...new Set(to)].join(','),
          subject: `הסכם העסקה נחתם — ${emp?.full_name || ''}`,
          html: `<div dir="rtl">${emp?.full_name || ''} חתמה על הסכם ההעסקה.<br/>
                 השלב הבא: מנהלת הסניף מאשרת וחותמת כמעסיק בכרטיס העובד/ת
                 (כפתור "אשר וחתום כמעסיק"), והחוזה המלא יישלח אוטומטית להנהלת
                 החשבונות, לתיק העובד/ת ולעובד/ת.</div>`,
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
  MAX_STORED_FILE_BYTES, MAX_INLINE_FILE_BYTES, maxUploadBytes,
  list, statusMap, getContext, preview, create, send, approve, waive, upload, file,
  approveSend, countersign, getMySignature, setMySignature,
  remove, DELETABLE,
  listAnnexes, uploadAnnex, annexFile,
  termsHistory, previewTerms, saveTerms,
  publicGet, publicSign,
  // for tests
  missingPersonalFields, applyFills,
};
