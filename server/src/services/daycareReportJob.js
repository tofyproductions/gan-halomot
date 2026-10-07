const crypto = require('crypto');
const mongoose = require('mongoose');
const { Branch, User, Setting, NotificationEvent } = require('../models');
const notifications = require('./notification.service');

/**
 * דיווח הנוכחות החודשי למשרד הכלכלה — the reminder on the 10th.
 *
 * Every מעון has to file a monthly attendance report at
 * daycareattendance.labor.gov.il. Nothing in this system files it and nothing
 * can check that it was filed — the deadline lives on somebody's memory, and
 * the price of forgetting is the subsidy.
 *
 * So the system does the one thing it can honestly do: on the 10th it asks.
 * It does not claim the report is late, because it does not know; it says what
 * is due and links to where it is done.
 *
 * WRITTEN FOR חלום, NOT FOR THIS GAN. Recipients are resolved per branch from
 * whoever manages it, so a customer with one מעון and a customer with nine both
 * work with no list to maintain. The Setting is an ADDITION to that, for the
 * person who actually files it without managing a branch — which is this gan's
 * case exactly: עינת is the one who files, and her account is a teacher's.
 */

const RECIPIENTS_KEY = 'daycare_report_recipients';
const SENT_KEY = 'daycare_report_last_sent';
const REPORT_URL = 'https://daycareattendance.labor.gov.il';

/** The day of the month it goes out. The 10th, as the office works. */
const SEND_DAY = 10;
const SEND_HOUR = 8;

function israelParts(now = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false,
  }).format(now));
  const [y, m, d] = f.split('-').map(Number);
  return { ymd: f, month: f.slice(0, 7), year: y, monthNum: m, day: d, hour };
}

/** The month being reported ON — the one that just ended. */
function reportedMonth(now = new Date()) {
  const { year, monthNum } = israelParts(now);
  const prev = monthNum === 1 ? { y: year - 1, m: 12 } : { y: year, m: monthNum - 1 };
  const names = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
    'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  return { key: `${prev.y}-${String(prev.m).padStart(2, '0')}`, label: `${names[prev.m - 1]} ${prev.y}` };
}

async function extraRecipientIds() {
  const row = await Setting.findOne({ key: RECIPIENTS_KEY }).lean();
  return Array.isArray(row?.value) ? row.value.map(String) : [];
}

async function setRecipientIds(ids) {
  const value = [...new Set((ids || []).map(String))];
  await Setting.findOneAndUpdate({ key: RECIPIENTS_KEY }, { key: RECIPIENTS_KEY, value }, { upsert: true });
  return value;
}

/**
 * Who hears about it: whoever manages each live branch, plus the extra list.
 *
 * Deduplicated across branches — a manager of three מעונות is one person who
 * has to open one website, not three notifications to dismiss.
 */
async function recipients() {
  const branches = await Branch.find({ is_active: { $ne: false } }).select('name').lean();
  const ids = new Set();
  for (const b of branches) {
    for (const id of await notifications.branchManagerIds(b._id)) ids.add(String(id));
  }
  for (const id of await extraRecipientIds()) ids.add(String(id));

  if (ids.size === 0) return { users: [], branches };
  const users = await User.find({ _id: { $in: [...ids] }, is_active: true })
    .select('full_name').lean();
  return { users, branches };
}

/**
 * A stable ObjectId for a month.
 *
 * NotificationEvent.ref_id is an ObjectId because every other notification in
 * this system points at a RECORD — a lead, a punch, a shift. This one points
 * at nothing: there is no row in this database for "September's attendance
 * report", and inventing one so the reminder has something to reference would
 * be a table that exists to satisfy a foreign key.
 *
 * So the month itself becomes the id, deterministically: the same month always
 * produces the same twelve bytes, which is exactly what createEvent's dedup
 * needs — one reminder per month per person, and a new month is a new id.
 */
function monthRef(monthKey) {
  const hex = crypto.createHash('sha1').update(`daycare-report:${monthKey}`).digest('hex');
  return new mongoose.Types.ObjectId(hex.slice(0, 24));
}

/** Raise the reminder. Returns what it did, so a manual trigger can report it. */
async function send({ now = new Date() } = {}) {
  const { users, branches } = await recipients();
  if (users.length === 0) return { sent: false, no_recipients: true };

  const month = reportedMonth(now);
  const title = `דיווח נוכחות למשרד הכלכלה — ${month.label}`;
  const body = branches.length > 1
    ? `יש לדווח את נוכחות ${month.label} לכל ${branches.length} המעונות באתר משרד הכלכלה.`
    : `יש לדווח את נוכחות ${month.label} באתר משרד הכלכלה.`;

  const ref = monthRef(month.key);
  let delivered = 0;
  let already = 0;
  const failed = [];
  for (const u of users) {
    try {
      /**
       * Once per person per month, and the check is HERE rather than in
       * notifyOnce.
       *
       * notifyOnce resolves the row the moment it is created — it is built for
       * "tell her once, now" — so its own dedup, which looks for a PENDING row
       * with the same reference, finds nothing on the second call and makes
       * another. Right for a morning list, wrong for a monthly reminder: a
       * manual re-trigger, or a tick that ran twice across a deploy, would put
       * the same nudge on somebody's screen two and three times.
       *
       * Any status counts. She was told; being told again this month is not
       * better.
       */
      const seen = await NotificationEvent.exists({
        type: 'daycare_report', ref_id: ref, recipient_id: u._id,
      });
      if (seen) { already++; continue; }
      await notifications.notifyOnce({
        type: 'daycare_report',
        ref_collection: 'settings',
        // One per month: the same month is never raised twice, a new month
        // always is.
        ref_id: ref,
        recipient_id: u._id,
        title,
        body,
        url: REPORT_URL,
      });
      delivered++;
    } catch (err) {
      failed.push(`${u.full_name}: ${err.message}`);
      console.error('[daycare-report] notify failed:', err.message);
    }
  }
  // Honest: "sent" means somebody actually got it. Reporting success on zero
  // deliveries is how the monthly latch gets set on a month nobody was told
  // about, and then the reminder never comes at all.
  return {
    // Already-notified counts as sent: the month's reminder exists on their
    // screens, which is the thing the monthly latch is actually about.
    sent: delivered > 0 || already > 0,
    month: month.key,
    delivered,
    already,
    failed,
    recipients: users.map(u => u.full_name),
  };
}

/**
 * The hourly tick. Fires on the 10th, from 08:00 Israel, at most once a month.
 *
 * "At most once a month" is held in a Setting rather than in memory, because a
 * deploy on the 10th restarts the process and an in-memory flag would send the
 * whole thing twice.
 */
async function tick(trigger = 'schedule') {
  const now = new Date();
  const p = israelParts(now);

  if (trigger === 'schedule') {
    if (p.day !== SEND_DAY) return { skipped: 'not the 10th' };
    if (p.hour < SEND_HOUR) return { skipped: 'before send hour' };
    const last = await Setting.findOne({ key: SENT_KEY }).lean();
    if (last?.value === p.month) return { skipped: 'already sent this month' };
  }

  const result = await send({ now });
  if (result.sent) {
    await Setting.findOneAndUpdate({ key: SENT_KEY }, { key: SENT_KEY, value: p.month }, { upsert: true });
  }
  return result;
}

module.exports = {
  tick, send, recipients, reportedMonth, israelParts,
  setRecipientIds, extraRecipientIds,
  RECIPIENTS_KEY, SENT_KEY, REPORT_URL, SEND_DAY,
};
