const bcrypt = require('bcryptjs');
const { User, Setting, Employee } = require('../models');

const ROLES = ['system_admin', 'branch_manager', 'accountant', 'class_leader', 'teacher', 'assistant', 'cook'];

/**
 * GET /api/admin/role-tabs
 * Tab overrides that apply to EVERY user of a role, so an admin can grant/revoke
 * a tab for a whole role in one action instead of user-by-user.
 * Shape: { [role]: { add: [tabId], remove: [tabId] } }
 */
async function getRoleTabs(req, res, next) {
  try {
    const doc = await Setting.findOne({ key: 'role_tab_overrides' }).lean();
    res.json({ role_tabs: doc?.value || {} });
  } catch (err) { next(err); }
}

/** PUT /api/admin/role-tabs  body: { [role]: { add: [], remove: [] } } */
async function setRoleTabs(req, res, next) {
  try {
    const body = req.body?.role_tabs || {};
    const clean = {};
    for (const role of ROLES) {
      const entry = body[role];
      if (!entry) continue;
      const norm = (arr) => [...new Set((Array.isArray(arr) ? arr : [])
        .filter(t => typeof t === 'string' && t.length > 0 && t.length < 64))];
      clean[role] = { add: norm(entry.add), remove: norm(entry.remove) };
    }
    await Setting.findOneAndUpdate({ key: 'role_tab_overrides' }, { value: clean }, { upsert: true });
    res.json({ ok: true, role_tabs: clean });
  } catch (err) { next(err); }
}

async function listUsers(req, res, next) {
  try {
    const users = await User.find({ is_active: true })
      .select('full_name email role branch_id managed_branch_ids position tab_overrides_add tab_overrides_remove')
      .populate('branch_id', 'name')
      .populate('managed_branch_ids', 'name')
      .sort({ full_name: 1 });

    // Active staff who have no login at all. They cannot appear in this table
    // (it lists Users), so without calling them out the page silently pretends
    // they don't exist — which is how a branch manager can be set up in the
    // employee card and never show up here.
    const unlinked = (await Employee.find({ is_active: true, $or: [{ user_id: null }, { user_id: { $exists: false } }] })
      .select('full_name position israeli_id branch_id')
      .populate('branch_id', 'name')
      .sort({ full_name: 1 })
      .lean())
      .map(e => ({
        id: String(e._id),
        full_name: e.full_name,
        position: e.position || '',
        branch_name: e.branch_id?.name || '',
        // No ת"ז means we can't mint a login for her — it's the account key.
        has_israeli_id: String(e.israeli_id || '').replace(/\D/g, '').length >= 7,
      }));

    res.json({ users, unlinked_employees: unlinked });
  } catch (err) {
    next(err);
  }
}

async function updateUserRole(req, res, next) {
  try {
    const { id } = req.params;
    const { role, managed_branch_ids } = req.body;
    const ALLOWED_ROLES = ['system_admin', 'branch_manager', 'accountant', 'class_leader', 'teacher', 'assistant', 'cook'];
    const setObj = {};
    if (role) {
      if (!ALLOWED_ROLES.includes(role)) return res.status(400).json({ error: 'role not allowed' });
      setObj.role = role;
    }
    if (Array.isArray(managed_branch_ids)) {
      setObj.managed_branch_ids = managed_branch_ids.filter(x => x && typeof x === 'string');
    }
    const user = await User.findByIdAndUpdate(id, setObj, { new: true })
      .select('full_name email role branch_id managed_branch_ids tab_overrides_add tab_overrides_remove')
      .populate('branch_id', 'name')
      .populate('managed_branch_ids', 'name');
    if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });
    res.json({ user });
  } catch (err) { next(err); }
}

async function updateUserTabs(req, res, next) {
  try {
    const { id } = req.params;
    const { add, remove } = req.body;

    if (!Array.isArray(add) || !Array.isArray(remove)) {
      return res.status(400).json({ error: 'add ו-remove חייבים להיות מערכים' });
    }
    const cleanAdd = [...new Set(add.filter(t => typeof t === 'string' && t.length > 0 && t.length < 64))];
    const cleanRemove = [...new Set(remove.filter(t => typeof t === 'string' && t.length > 0 && t.length < 64))];

    const user = await User.findByIdAndUpdate(
      id,
      { tab_overrides_add: cleanAdd, tab_overrides_remove: cleanRemove },
      { new: true }
    ).select('full_name email role tab_overrides_add tab_overrides_remove');

    if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/users/:id/reset-password
 * Admin resets a user's login password. For security we NEVER reveal or set a
 * plaintext password — we flip password_set back to false so the user can log
 * in with name+ID again and is prompted to choose a new password. Optionally a
 * temporary password can be provided to hand the employee.
 */
/**
 * Issuing a new password for an employee who lost theirs.
 *
 * WHAT THIS USED TO DO, AND WHY IT WAS WRONG. It set `password_set: false`,
 * and its own comment said the quiet part: with no password set, step one of
 * login issues a token on a name and an id number alone. So "reset the
 * password" REMOVED the password — and both of the things it removed it in
 * favour of are printed on the staff list. Anyone who could read that list
 * could then sign in as whoever they liked, and the screen said the reset had
 * worked.
 *
 * Now it issues a real temporary password, shown to the administrator once,
 * and flags the account: that password opens exactly one screen — the one that
 * replaces it — and nothing else until it has been replaced.
 */
async function resetPassword(req, res, next) {
  try {
    const { temp_password } = req.body || {};

    // Readable down a telephone: no l/I/0/O, and grouped.
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const pick = (n) => Array.from(require('crypto').randomBytes(n))
      .map((b) => alphabet[b % alphabet.length]).join('');
    const password = temp_password && String(temp_password).length >= 4
      ? String(temp_password)
      : `${pick(4)}-${pick(4)}`;

    const user = await User.findByIdAndUpdate(req.params.id, {
      password_hash: await bcrypt.hash(password, 10),
      password_set: true,
      must_change_password: true,
    }, { new: true }).select('full_name id_number password_set');
    if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });

    res.json({
      ok: true,
      full_name: user.full_name,
      id_number: user.id_number || '',
      temp_password: password,
    });
  } catch (err) { next(err); }
}

async function emailDiagnostic(req, res, next) {
  const env = require('../config/env');
  const info = {
    active_provider: env.GAS_EMAIL_URL ? 'gas' : (env.RESEND_API_KEY ? 'resend' : (env.SMTP_USER ? 'smtp' : 'none')),
    gas_url_set: !!env.GAS_EMAIL_URL,
    gas_secret_set: !!env.GAS_EMAIL_SECRET,
    resend_key_set: !!env.RESEND_API_KEY,
    resend_key_length: env.RESEND_API_KEY ? env.RESEND_API_KEY.length : 0,
    resend_from: env.RESEND_FROM || '(default: onboarding@resend.dev)',
    smtp_host: env.SMTP_HOST || null,
    smtp_port: env.SMTP_PORT || null,
    smtp_user_set: !!env.SMTP_USER,
    smtp_user_value: env.SMTP_USER || null,
    smtp_pass_set: !!env.SMTP_PASS,
    smtp_pass_length: env.SMTP_PASS ? env.SMTP_PASS.length : 0,
    smtp_pass_has_spaces: env.SMTP_PASS ? /\s/.test(env.SMTP_PASS) : false,
  };
  res.json(info);
}

async function emailTest(req, res, next) {
  try {
    const env = require('../config/env');
    const { dispatchEmail } = require('../services/email.service');
    if (!env.GAS_EMAIL_URL && !env.RESEND_API_KEY && !env.SMTP_USER) {
      return res.status(400).json({
        ok: false,
        error: 'אין ספק מייל מוגדר — הגדר GAS_EMAIL_URL (מומלץ) או RESEND_API_KEY או SMTP_USER+SMTP_PASS',
      });
    }
    const to = req.body?.to || req.user?.email || env.SMTP_USER || 'dreamgan10@gmail.com';
    const info = await dispatchEmail({
      to,
      subject: 'בדיקת מייל — גן החלומות',
      text: 'אם הגיע — המערכת מוגדרת נכון.',
      html: '<div dir="rtl" style="font-family:Arial"><h2>המייל פעיל</h2><p>אם הגיע — ההגדרות תקינות.</p></div>',
    });
    res.json({ ok: true, messageId: info.messageId, provider: info.provider, sent_to: to });
  } catch (err) {
    console.error('emailTest failed:', err);
    res.status(500).json({
      ok: false,
      code: err.code,
      responseCode: err.responseCode,
      command: err.command,
      message: err.message,
      detail: err.detail,
    });
  }
}

module.exports = {
  listUsers, updateUserTabs, updateUserRole, resetPassword,
  getRoleTabs, setRoleTabs, emailDiagnostic, emailTest,
};
