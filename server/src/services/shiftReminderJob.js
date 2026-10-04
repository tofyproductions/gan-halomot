/**
 * "הסידור לשבוע הבא עוד לא נסגר" — Friday from 12:00, once a week.
 *
 * Employees plan their weekend around Sunday's rota, and 12:00 Friday is the
 * deadline the gan set for it. The job runs hourly like every other timed job
 * here (see index.js) and gates itself: wrong day or hour → nothing; already
 * ran for this week → nothing, via a Setting marker that survives restarts.
 */
const { Branch, ShiftWeek, Setting, User } = require('../models');
const notificationService = require('./notification.service');
const { branchManagerFilter } = require('./branch-recipients.service');
const { weekStart } = require('./parentVisibility');

const MARKER_KEY = 'shift_close_reminder';
const HOUR_IL = 12;

function ilParts(now) {
  const day = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hourCycle: 'h23' }).format(now));
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' }).format(now);
  return { day, hour, weekday };
}

function nextSunday(day) {
  const d = new Date(`${weekStart(day)}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

async function tick(now = new Date()) {
  const { day, hour, weekday } = ilParts(now);
  if (weekday !== 'Fri' || hour < HOUR_IL) return { skipped: 'not friday noon' };
  const target = nextSunday(day);
  const marker = await Setting.findOne({ key: MARKER_KEY }).lean();
  if (marker && marker.value === target) return { skipped: 'already ran' };

  const branches = await Branch.find({ is_active: { $ne: false } }).select('name').lean();
  const published = await ShiftWeek.find({ week_start: target, published_at: { $ne: null } }).select('branch_id').lean();
  const done = new Set(published.map(w => String(w.branch_id)));
  let reminded = 0;
  for (const b of branches) {
    if (done.has(String(b._id))) continue;
    const managers = await User.find(branchManagerFilter(b._id)).select('_id').lean();
    if (managers.length === 0) continue;
    let branchReminded = false;
    for (const manager of managers) {
      try {
        await notificationService.notifyOnce({
          type: 'shift_close_reminder', ref_collection: 'Branch', ref_id: b._id, recipient_id: manager._id,
          title: 'הסידור לשבוע הבא עוד לא נסגר',
          body: `${b.name} — הסידור לשבוע שמתחיל ב-${target.split('-').reverse().slice(0, 2).join('/')} ממתין לסגירה`,
          url: `/shifts?week=${target}`,
        });
        branchReminded = true;
      } catch (err) {
        console.error('[shift-reminder] notify failed:', err.message);
      }
    }
    if (branchReminded) reminded += 1;
  }
  await Setting.updateOne({ key: MARKER_KEY }, { $set: { value: target } }, { upsert: true });
  return { week_start: target, reminded };
}

module.exports = { tick, MARKER_KEY };
