const { User } = require('../models');

async function listUsers(req, res, next) {
  try {
    const users = await User.find({ is_active: true })
      .select('full_name email role branch_id position tab_overrides_add tab_overrides_remove')
      .populate('branch_id', 'name')
      .sort({ full_name: 1 });
    res.json({ users });
  } catch (err) {
    next(err);
  }
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

module.exports = { listUsers, updateUserTabs, emailDiagnostic, emailTest };
