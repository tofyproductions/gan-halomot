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
    if (!env.SMTP_USER || !env.SMTP_PASS) {
      return res.status(400).json({
        ok: false,
        error: 'SMTP_USER או SMTP_PASS חסרים ב-environment',
        config: {
          smtp_host: env.SMTP_HOST,
          smtp_user_set: !!env.SMTP_USER,
          smtp_pass_set: !!env.SMTP_PASS,
        },
      });
    }
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST, port: env.SMTP_PORT, secure: false,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
    // verify() pings the server with the credentials but doesn't send anything.
    await transporter.verify();
    // Send a tiny test mail to the requesting admin's address (or the SMTP_USER itself).
    const to = req.body?.to || req.user?.email || env.SMTP_USER;
    const info = await transporter.sendMail({
      from: `"גן החלומות בדיקת SMTP" <${env.SMTP_USER}>`,
      to,
      subject: 'בדיקת SMTP — גן החלומות',
      text: 'אם הגיע — SMTP מוגדר נכון.',
      html: '<div dir="rtl"><h2>SMTP פעיל</h2><p>אם המייל הזה הגיע, ההגדרות תקינות.</p></div>',
    });
    res.json({ ok: true, messageId: info.messageId, sent_to: to });
  } catch (err) {
    console.error('emailTest failed:', err);
    res.status(500).json({
      ok: false,
      code: err.code,
      responseCode: err.responseCode,
      command: err.command,
      message: err.message,
    });
  }
}

module.exports = { listUsers, updateUserTabs, emailDiagnostic, emailTest };
