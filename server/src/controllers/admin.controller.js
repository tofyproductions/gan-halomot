const bcrypt = require('bcryptjs');
const { User } = require('../models');

async function listUsers(req, res, next) {
  try {
    const users = await User.find({ is_active: true })
      .select('full_name email role branch_id managed_branch_ids position tab_overrides_add tab_overrides_remove')
      .populate('branch_id', 'name')
      .populate('managed_branch_ids', 'name')
      .sort({ full_name: 1 });
    res.json({ users });
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
async function resetPassword(req, res, next) {
  try {
    const { temp_password } = req.body || {};
    const update = { password_set: false };
    if (temp_password && String(temp_password).length >= 4) {
      // Give them a known temp password AND keep password_set=false so they are
      // still nagged to replace it (temp works as the step-2 password meanwhile
      // is NOT enforced since password_set=false → name+ID logs in). We simply
      // store the hash so a later "set your own" flow has something to compare.
      update.password_hash = await bcrypt.hash(String(temp_password), 10);
    }
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true })
      .select('full_name password_set');
    if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });
    res.json({ ok: true, full_name: user.full_name, password_set: user.password_set });
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

module.exports = { listUsers, updateUserTabs, updateUserRole, resetPassword, emailDiagnostic, emailTest };
