/**
 * The scheduled Cibus import: read the mailbox, apply the report, record what
 * happened.
 *
 * The failure mode this is written against is SILENCE. A month where the email
 * never arrived looks exactly like a month where nobody spent anything, and by
 * the time someone notices, payroll has gone out wrong more than once. So every
 * attempt is logged — including the ones that found nothing — and the job keeps
 * retrying daily until the month actually succeeds rather than firing once on a
 * fixed date and giving up.
 */
const { CibusSync, User } = require('../models');
const mailbox = require('./cibusMailbox');
const { applyCibusReport } = require('./cibusImport');
const { dispatchEmail } = require('./email.service');

const RUN_LOG_CAP = 40;
const STALE_DAYS = 40;

/** The single config document, created with defaults on first use. */
async function getConfig() {
  let doc = await CibusSync.findOne({ key: 'cibus' });
  if (!doc) doc = await CibusSync.create({ key: 'cibus' });
  return doc;
}

/** 'YYYY-MM' shifted by `offset` months from today (Israel time). */
function targetMonth(offset) {
  const now = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()));
  now.setUTCDate(1);
  now.setUTCMonth(now.getUTCMonth() + Number(offset || 0));
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function record(doc, run) {
  doc.last_run_at = new Date();
  if (run.status === 'ok') {
    doc.last_success_at = new Date();
    doc.last_success_month = run.month;
    doc.last_error = '';
  } else if (run.status === 'error') {
    doc.last_error = run.message || 'שגיאה';
  }
  doc.runs = [run, ...(doc.runs || [])].slice(0, RUN_LOG_CAP);
  await doc.save();
  return run;
}

/**
 * Run once.
 * @param {Object} opts
 * @param {String} opts.trigger 'schedule' | 'manual'
 * @param {String} opts.month   override the computed month
 * @param {Boolean} opts.dryRun parse and report, write nothing
 */
async function runOnce({ trigger = 'manual', month = null, dryRun = false } = {}) {
  const doc = await getConfig();
  const ym = month || targetMonth(doc.month_offset);

  try {
    const res = await mailbox.fetchReports({
      fromContains: doc.from_contains,
      subjectContains: doc.subject_contains,
      mailbox: doc.mailbox,
      markSeen: doc.mark_seen && !dryRun,
      // Look back far enough to catch a late send, but not so far that last
      // month's email gets re-imported into this month.
      since: new Date(Date.now() - 45 * 864e5),
    });

    if (!res.configured) {
      return record(doc, { trigger, month: ym, status: 'error', message: res.error });
    }

    // Newest first — if the mailbox holds several, the latest is the one meant
    // for this run.
    const withFile = res.messages
      .filter(m => m.attachments.length)
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    if (!withFile.length) {
      const linkOnly = res.messages.find(m => m.bodyLinks.length);
      return record(doc, {
        trigger, month: ym, status: 'empty',
        mail_subject: res.messages[0]?.subject || '',
        mail_from: res.messages[0]?.from || '',
        message: linkOnly
          // Worth saying out loud rather than reporting a bare "nothing found":
          // it means the integration needs a different second step.
          ? `נמצא מייל תואם אך ללא קובץ מצורף — יש בו קישור להורדה: ${linkOnly.bodyLinks[0]}`
          : (res.messages.length
            ? 'נמצאו מיילים תואמים אך ללא קובץ xlsx/csv מצורף'
            : 'לא נמצא מייל תואם בתיבה'),
      });
    }

    const msg = withFile[0];
    const file = msg.attachments[0];
    const applied = await applyCibusReport(file.buffer, file.filename, ym, { dryRun });

    return record(doc, {
      trigger, month: ym, status: 'ok',
      matched_count: applied.matched_count,
      unmatched_count: applied.unmatched_count,
      total_amount: applied.total_amount,
      unmatched: applied.unmatched.slice(0, 50),
      file_name: file.filename,
      mail_subject: msg.subject,
      mail_from: msg.from,
      mail_date: msg.date,
      message: dryRun ? 'הרצת בדיקה — לא נשמר דבר' : (applied.warning || ''),
    });
  } catch (err) {
    console.error('[cibus] sync failed:', err.message);
    return record(doc, { trigger, month: ym, status: 'error', message: err.message });
  }
}

/**
 * The daily tick. Does nothing before `run_from_day`, and nothing once this
 * month's report has already landed — so it is safe to call every hour.
 */
async function tick() {
  const doc = await getConfig();
  if (!doc.enabled) return null;
  if (!mailbox.mailConfig().configured) return null;

  const today = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', day: 'numeric' })
    .format(new Date()));
  if (today < (doc.run_from_day || 1)) return null;

  const ym = targetMonth(doc.month_offset);
  if (doc.last_success_month === ym) return null;   // already have it

  const run = await runOnce({ trigger: 'schedule' });
  await alertIfStale(doc);
  return run;
}

/**
 * A scheduled import that quietly stops working is worse than no import at
 * all, so tell someone when nothing has succeeded for too long.
 */
async function alertIfStale(doc) {
  const last = doc.last_success_at;
  const days = last ? Math.floor((Date.now() - new Date(last)) / 864e5) : null;
  if (days == null || days < STALE_DAYS) return;
  // Once a week at most, not on every tick.
  if (doc.stale_alerted_at && Date.now() - new Date(doc.stale_alerted_at) < 7 * 864e5) return;
  try {
    const to = (await User.find({ role: { $in: ['accountant', 'system_admin'] }, is_active: true })
      .select('email').lean())
      .map(u => u.email)
      .filter(e => e && e.includes('@') && !/@gan-halomot\.local$/i.test(e));
    if (!to.length) return;
    await dispatchEmail({
      to: to.join(','),
      subject: 'ייבוא סיבוס לא הצליח כבר ' + days + ' ימים',
      html: `<div dir="rtl">הייבוא האוטומטי של דוח סיבוס לא הצליח מאז
        ${new Date(last).toLocaleDateString('he-IL')}.<br/>
        ייתכן שהתזמון בסיבוס בוטל, שהמייל משתנה, או שסיסמת התיבה פגה.<br/>
        עד שזה מטופל — יש לייבא את הקובץ ידנית במסך השכר.</div>`,
    });
    doc.stale_alerted_at = new Date();
    await doc.save();
  } catch (e) {
    console.error('[cibus] stale alert failed:', e.message);
  }
}

module.exports = { runOnce, tick, getConfig, targetMonth };
