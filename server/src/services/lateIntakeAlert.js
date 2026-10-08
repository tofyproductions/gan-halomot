const { sendSms } = require('./sms.service');
const { dispatchEmail } = require('./email.service');
const { recipientEmails, recipientPhone } = require('./reconcileUploadReminderJob');

/**
 * קליטה אחרי ה-15 — עינת must hear about it, because the month's payment is
 * already wrong by the time anyone else notices.
 *
 * A child absorbed mid-month pays for part of a month, and ClickTac bills the
 * whole one unless somebody adjusts it by hand. That somebody is עינת, and the
 * screen where the intake date is typed (רישום חיצוני) is not a screen she
 * reads daily. So the moment an intake date LATER THAN THE 15TH is saved on a
 * child, she is told directly — SMS to her phone, email to the same address
 * list every reconcile alert uses — naming the child, the gan and the date.
 *
 * Fire-and-forget by design: the office worker saving the date should not
 * wait on Gmail, and a failed send must not fail the save. Each channel fails
 * alone and is logged; the caller only decides WHETHER to alert (the >15 rule
 * and the did-the-date-change rule live with the save, next to the data).
 */

const fmtDate = (d) => {
  try { return new Date(d).toLocaleDateString('he-IL'); } catch { return String(d); }
};

async function sendLateIntakeAlert({ childName, idNumber, branchName, intakeDate }) {
  const dateText = fmtDate(intakeDate);
  const name = childName || `ת"ז ${idNumber}`;
  const text = `קליטה אחרי ה-15: ${name} (${branchName}) נקלט/ה ב-${dateText} — יש לסדר את התשלום החודשי. מערכת גן החלומות.`;

  const result = { sms: null, email: null };
  const [phone, emails] = await Promise.all([recipientPhone(), recipientEmails()]);

  if (phone) {
    try {
      await sendSms({ to: phone, text });
      result.sms = { ok: true };
    } catch (err) {
      result.sms = { ok: false, error: err.message };
      console.error('[late-intake] SMS failed:', err.message);
    }
  } else {
    result.sms = { ok: false, error: 'אין טלפון לעינת במערכת' };
  }

  if (emails.length) {
    try {
      await dispatchEmail({
        to: emails,
        subject: `קליטה אחרי ה-15 — ${name}`,
        html: `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:640px">
          <h2 style="margin:0 0 10px">קליטה אחרי ה-15 לחודש</h2>
          <p><b>${name}</b>${idNumber ? ` (ת"ז ${idNumber})` : ''} — ${branchName}</p>
          <p>תאריך קליטה: <b>${dateText}</b></p>
          <p>הילד/ה נקלט/ה אחרי ה-15 לחודש — יש לסדר את התשלום של החודש הראשון.</p>
          <p style="color:#6b7280;font-size:13px">התאריך נרשם במסך "רישום חיצוני".</p>
        </div>`,
      });
      result.email = { ok: true };
    } catch (err) {
      result.email = { ok: false, error: err.message };
      console.error('[late-intake] email failed:', err.message);
    }
  } else {
    result.email = { ok: false, error: 'הגדרת reconcile_alert_emails ריקה' };
  }

  return result;
}

module.exports = { sendLateIntakeAlert };
