const {
  Branch, User, EnrollmentImport, Setting,
} = require('../models');
const { sendSms } = require('./sms.service');
const { dispatchEmail } = require('./email.service');
const { enrollmentYear } = require('./academic-year.service');
const { isTmtSupervised } = require('../controllers/tmtApproval.controller');

/**
 * תזכורת חודשית להעלאת קליקטאק — עינת does not check this screen on her own
 * initiative, and a branch three weeks stale on the intake comparison is not
 * something anybody notices until a family calls asking why they were never
 * absorbed. So on the 11th of every month she is told, by SMS AND by email,
 * exactly which gans still need a fresh ClickTac file this month.
 *
 * "Needs a file" is read off the upload history, not off a calendar: a branch
 * whose most recent ClickTac import (either export) is inside the trailing
 * THRESHOLD_DAYS is current; a branch with none, or with one older than that,
 * is named. קפלן is not asked — it is not under the ministry and has no
 * ClickTac comparison at all (see isTmtSupervised).
 *
 * UNCONDITIONAL CADENCE. Unlike the compliance digest, this sends on the 11th
 * whether or not anyone is behind — "כל הגנים מעודכנים" is itself the answer
 * to "should I check this month", and a message that only ever arrives when
 * something is wrong is one she cannot tell apart from the job having broken.
 *
 * SMS goes straight to her phone (a User field, real). Email goes to whoever
 * is in the `reconcile_alert_emails` Setting — her own address, since her
 * User record's email is a system placeholder and not one she reads.
 */

const DAY_OF_MONTH = 11;
const SEND_HOUR = 9;
const THRESHOLD_DAYS = 30;
const RECIPIENT_NAME = 'עינת רוה';
const RECIPIENTS_KEY = 'reconcile_alert_emails';

/**
 * TWO KEYS, NOT ONE. The SMS provider and the email provider are unrelated
 * services and fail independently — this ran once in development with real
 * SMS credentials and no email credentials at all, and the SMS went through
 * while the email failed. A single monthly "sent" flag would have to choose
 * between re-texting her every hour until the email problem is fixed, or
 * marking the whole month done while she never got the email. Each channel
 * remembers its OWN last successful month, so a stuck email keeps retrying
 * hourly through the day without ever sending a second text.
 */
const SMS_SENT_KEY = 'reconcile_upload_reminder_sms_last_sent';     // 'YYYY-MM'
const EMAIL_SENT_KEY = 'reconcile_upload_reminder_email_last_sent'; // 'YYYY-MM'

function monthKeyInIsrael(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit',
  }).format(now).replace('-', '-'); // 'YYYY-MM' as-is
}

function dayInIsrael(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', day: '2-digit',
  }).format(now));
}

function hourInIsrael(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false,
  }).format(now));
}

/** The branches whose latest ClickTac upload (either export) is stale or missing. */
async function branchesNeedingUpload(now = new Date()) {
  const year = enrollmentYear();
  const cutoff = new Date(now.getTime() - THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
  const branches = await Branch.find({ is_active: { $ne: false } }).select('name tmt_supervised').lean();
  const supervised = branches.filter(isTmtSupervised);

  const latest = await EnrollmentImport.aggregate([
    { $match: { source: 'clicktac', academic_year: year, branch_id: { $in: supervised.map(b => b._id) } } },
    { $sort: { created_at: -1 } },
    { $group: { _id: '$branch_id', created_at: { $first: '$created_at' } } },
  ]);
  const lastByBranch = new Map(latest.map(l => [String(l._id), l.created_at]));

  return supervised
    .filter((b) => {
      const at = lastByBranch.get(String(b._id));
      return !at || new Date(at) < cutoff;
    })
    .map(b => b.name);
}

async function recipientEmails() {
  const setting = await Setting.findOne({ key: RECIPIENTS_KEY }).lean();
  const list = Array.isArray(setting?.value) ? setting.value : [];
  return [...new Set(list.map(e => String(e || '').trim().toLowerCase()).filter(e => e.includes('@')))];
}

function messageText(needing) {
  if (!needing.length) {
    return 'תזכורת חודשית — קליקטאק: כל הגנים מעודכנים, אין קובץ שממתין להעלאה. מערכת גן החלומות.';
  }
  return `תזכורת חודשית — יש להעלות קובץ קליקטאק (נרשמים/חוזים) עבור: ${needing.join(', ')}. מערכת גן החלומות.`;
}

function emailHtml(needing) {
  const body = needing.length
    ? `<p>הגנים הבאים לא קיבלו קובץ קליקטאק ב-30 הימים האחרונים:</p>
       <ul>${needing.map(n => `<li><b>${n}</b></li>`).join('')}</ul>
       <p style="color:#6b7280;font-size:13px">ההעלאה נעשית במסך "רישום חיצוני" של כל סניף.</p>`
    : '<p>כל הגנים מעודכנים — אין קובץ קליקטאק שממתין להעלאה החודש.</p>';
  return `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:640px">
    <h2 style="margin:0 0 10px">תזכורת חודשית — קליקטאק</h2>
    ${body}
  </div>`;
}

/** Find עינת's phone straight off her User record, by name — no id hard-coded. */
async function recipientPhone() {
  const user = await User.findOne({ full_name: RECIPIENT_NAME, is_active: { $ne: false } }).select('phone').lean();
  return user?.phone || null;
}

/**
 * Build and send — EACH CHANNEL GATED BY ITS OWN MONTHLY KEY (see the note on
 * SMS_SENT_KEY/EMAIL_SENT_KEY). `force` bypasses both gates, for a manual
 * "send now" trigger where re-sending on purpose is the whole point.
 */
async function send({ dryRun = false, now = new Date(), force = false } = {}) {
  const needing = await branchesNeedingUpload(now);
  const text = messageText(needing);
  const monthKey = monthKeyInIsrael(now);

  const [phone, emails, smsDone, emailDone] = await Promise.all([
    recipientPhone(), recipientEmails(),
    Setting.findOne({ key: SMS_SENT_KEY }).lean(),
    Setting.findOne({ key: EMAIL_SENT_KEY }).lean(),
  ]);
  const result = { needing, sms: null, email: null };

  if (!force && smsDone?.value === monthKey) {
    result.sms = { skipped: 'already sent this month' };
  } else if (phone) {
    if (!dryRun) {
      try {
        await sendSms({ to: phone, text });
        result.sms = { to: phone, ok: true };
        await Setting.findOneAndUpdate({ key: SMS_SENT_KEY }, { $set: { value: monthKey } }, { upsert: true });
      } catch (err) {
        result.sms = { to: phone, ok: false, error: err.message };
      }
    } else {
      result.sms = { to: phone, dry_run: true };
    }
  } else {
    result.sms = { ok: false, error: `לא נמצא משתמש פעיל בשם "${RECIPIENT_NAME}"` };
  }

  if (!force && emailDone?.value === monthKey) {
    result.email = { skipped: 'already sent this month' };
  } else if (emails.length) {
    if (!dryRun) {
      try {
        await dispatchEmail({ to: emails, subject: 'תזכורת חודשית — קליקטאק', html: emailHtml(needing) });
        result.email = { to: emails, ok: true };
        await Setting.findOneAndUpdate({ key: EMAIL_SENT_KEY }, { $set: { value: monthKey } }, { upsert: true });
      } catch (err) {
        result.email = { to: emails, ok: false, error: err.message };
      }
    } else {
      result.email = { to: emails, dry_run: true };
    }
  } else {
    result.email = { ok: false, error: `הגדרה '${RECIPIENTS_KEY}' ריקה — אין כתובת מייל של עינת` };
  }

  return result;
}

/**
 * The hourly tick. On the 11th, at or after 09:00 Israel time, every hour —
 * so a channel that failed once keeps retrying through the day, without ever
 * re-sending a channel that already succeeded this month (see `send`).
 */
async function tick(trigger = 'schedule') {
  const now = new Date();
  if (trigger === 'schedule') {
    if (dayInIsrael(now) !== DAY_OF_MONTH) return { skipped: 'not the 11th' };
    if (hourInIsrael(now) < SEND_HOUR) return { skipped: 'before send hour' };
    return send({ now });
  }
  // A manual trigger sends for real, on purpose, whether or not this month's
  // channels already succeeded.
  return send({ now, force: true });
}

module.exports = {
  tick, send, branchesNeedingUpload, messageText, RECIPIENTS_KEY, RECIPIENT_NAME, THRESHOLD_DAYS, DAY_OF_MONTH,
};
