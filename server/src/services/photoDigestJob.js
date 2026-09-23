const {
  ParentAccount, Photo, PushSubscription, Registration,
} = require('../models');
const fcmService = require('./fcm.service');
const { dispatchEmail } = require('./email.service');
const { findParent } = require('./parentDirectory.service');

/**
 * "יש 3 תמונות חדשות של דני" — once a day, and never more.
 *
 * This is the thing that turns the app from an icon into a habit, and it is
 * also the fastest way to lose one. A hundred photographs a day across four
 * branches would be a notification every few minutes; within a week parents
 * would switch notifications off, and when they did they would switch off the
 * ones about payments and pickup too. So there is exactly one message a day,
 * about their own child, with a number in it.
 *
 * THE RULE THAT PREVENTS A SILENT BUG: the digest counts photographs added
 * SINCE THE LAST DIGEST, not photographs "from today". A teacher who uploads
 * the morning's pictures at nine in the evening would otherwise have them
 * counted for a day whose message has already gone, and they would never be
 * mentioned at all.
 *
 * A parent who has not consented to face recognition still gets this — their
 * gallery is filled by whatever staff tagged by hand, which is the same
 * photographs arriving by a slower route.
 */

// Late enough that the day is over and the teachers have uploaded, early
// enough not to arrive after a family has put a one-year-old to bed.
const DAILY_HOUR = 18;
// Friday at one, when the week is finished and nobody is at the gan.
const WEEKLY_DAY = 5;
const WEEKLY_HOUR = 13;

const EVERY_MS = 60 * 60 * 1000;
const FIRST_RUN_MS = 5 * 60 * 1000;

/** The hour and weekday in Israel, whatever the server thinks it is. */
function localNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', hour: 'numeric', weekday: 'short', hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const wd = parts.find((p) => p.type === 'weekday').value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  return { hour, day };
}

/** Is this the hour this parent's chosen schedule fires? */
function isDue(mode, now) {
  if (mode === 'weekly') return now.day === WEEKLY_DAY && now.hour === WEEKLY_HOUR;
  return now.hour === DAILY_HOUR;
}

/**
 * The window to count over.
 *
 * `last_sent_at` is the real answer. The fallbacks only matter for a parent
 * who has never had a digest, and they are deliberately short — a first
 * message saying "412 new photographs" is not a welcome, it is a wall.
 */
function since(account, mode) {
  const last = account.photo_digest && account.photo_digest.last_sent_at;
  if (last) return new Date(last);
  const days = mode === 'weekly' ? 7 : 1;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function notify({ account, childName, count, mode }) {
  const title = count === 1 ? 'תמונה חדשה' : `${count} תמונות חדשות`;
  const body = mode === 'weekly'
    ? `${childName} — סיכום השבוע בגן`
    : `של ${childName}`;

  let pushed = 0;
  const subs = await PushSubscription.find({ parent_id: account._id }).lean();
  for (const sub of subs) {
    try {
      const r = await fcmService.sendPush({
        token: sub.fcm_token, title, body, data: { url: '/parent' },
      });
      if (r && r.unregistered) await PushSubscription.deleteOne({ _id: sub._id });
      else pushed += 1;
    } catch (err) {
      console.error('[photo-digest] push failed:', err.message);
    }
  }
  if (pushed) return { channel: 'push' };

  // No app on a phone yet. Email rather than nothing — but never both, or the
  // parent who installed the app gets told twice.
  const reg = await Registration.findOne({
    parent_id_number: account.id_number, parent_email: { $nin: [null, ''] },
  }).select('parent_email').lean();
  if (!reg) return { channel: 'none' };

  await dispatchEmail({
    to: reg.parent_email,
    subject: `${title} של ${childName}`,
    text: `${title} של ${childName} בגן החלומות.\n\nלצפייה: היכנסו לאפליקציה.`,
  });
  return { channel: 'email' };
}

async function tick(now = localNow()) {
  const accounts = await ParentAccount.find({
    activated: true,
    is_active: { $ne: false },
    'photo_digest.mode': { $ne: 'off' },
  }).lean();

  let sent = 0;
  let skipped = 0;

  for (const account of accounts) {
    const mode = (account.photo_digest && account.photo_digest.mode) || 'daily';
    if (!isDue(mode, now)) { skipped += 1; continue; }

    const cutoff = since(account, mode);
    // Guard against a double run in the same hour — the job is hourly, but a
    // deploy in the wrong minute can fire it twice.
    if (account.photo_digest && account.photo_digest.last_sent_at
      && Date.now() - new Date(account.photo_digest.last_sent_at) < 6 * 60 * 60 * 1000) {
      skipped += 1;
      continue;
    }

    const parent = await findParent(account.id_number);
    if (!parent || !parent.children.length) { skipped += 1; continue; }

    // One message per family, named after the child with the most new
    // photographs — two children means one notification, not two.
    let best = { name: '', count: 0 };
    let total = 0;
    for (const group of parent.groups) {
      const ids = group.years.map((y) => y._id);
      const count = await Photo.countDocuments({
        child_ids: { $in: ids },
        source: 'staff',
        created_at: { $gt: cutoff },
      });
      total += count;
      if (count > best.count) best = { name: group.current.child_name, count };
    }

    if (!total) { skipped += 1; continue; }

    const label = parent.groups.length > 1 && best.count < total
      ? `${best.name} ועוד`
      : best.name;
    const res = await notify({
      account, childName: label, count: total, mode,
    });

    await ParentAccount.updateOne({ _id: account._id },
      { $set: { 'photo_digest.last_sent_at': new Date() } });
    if (res.channel !== 'none') sent += 1;
  }

  return { sent, skipped, considered: accounts.length };
}

function describeTick(r) {
  if (!r.sent) return [];
  return [{ level: 'log', text: `[photo-digest] sent ${r.sent} of ${r.considered}` }];
}

module.exports = {
  tick, describeTick, localNow, isDue, since,
  EVERY_MS, FIRST_RUN_MS, DAILY_HOUR, WEEKLY_DAY, WEEKLY_HOUR,
};
