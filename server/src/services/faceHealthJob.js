const { Setting } = require('../models');
const { dispatchEmail } = require('./email.service');
const scanner = require('./face/scanner');

/**
 * Noticing that face recognition has quietly stopped.
 *
 * Of everything that can go wrong here, this is the one that would not be
 * reported: the queue jams, or the models fail to load after a deploy, and
 * from the outside absolutely nothing happens. Photographs keep uploading. The
 * gallery keeps working. No request errors, no red screen, no complaint —
 * parents simply assume their child was not photographed that week, which is
 * an ordinary thing to assume. It would be found weeks later, by accident.
 *
 * So the check is not "did something throw". It is "is work waiting while
 * nothing is being done", which is the shape this failure actually has.
 *
 * THE OFFICE'S "תקלות במערכת" ROUTING GETS THIS, never a branch manager. A queue that is stuck
 * is a technical fault she can do nothing about except worry; telling her
 * converts a developer's problem into a manager's anxiety and fixes nothing.
 */

const LAST_SENT_KEY = 'face_alert_last_sent';

// Long enough that an ordinary busy afternoon never trips it — the queue
// drains at roughly a photograph a second — and short enough that a jam is
// caught the same day.
const STALL_HOURS = 6;
// A stuck queue is still stuck tomorrow. One message a day is a reminder;
// one an hour is something you filter, and then you stop seeing the real one.
const REMIND_HOURS = 24;

const EVERY_MS = 60 * 60 * 1000;
const FIRST_RUN_MS = 15 * 60 * 1000;

/** The office's "תקלות במערכת" routing, as one comma-joined `to`. */
async function recipient() {
  return (await require('./office-recipients.service').officeEmails('system_faults')).join(',');
}

async function tick() {
  const h = await scanner.health();

  // Off is not broken. The feature ships off and spends most of its life that
  // way before the bootstrap week.
  if (!h.enabled) return { ok: true, reason: 'off' };
  if (!h.pending && !h.failed) return { ok: true, reason: 'idle' };

  const stalledHours = h.last_scan_at
    ? (Date.now() - new Date(h.last_scan_at)) / 3600000
    : Infinity;

  const stalled = h.pending > 0 && stalledHours > STALL_HOURS;
  if (!stalled) return { ok: true, pending: h.pending, reason: 'working' };

  const last = await Setting.findOne({ key: LAST_SENT_KEY }).lean();
  const sentHoursAgo = last && last.value && last.value.at
    ? (Date.now() - new Date(last.value.at)) / 3600000
    : Infinity;
  if (sentHoursAgo < REMIND_HOURS) {
    return { ok: false, pending: h.pending, reason: 'already told' };
  }

  const to = await recipient();
  if (!to) {
    // Still worth a log line: a missing address must not turn a real fault
    // into silence, which is the exact failure this job exists to prevent.
    console.error(`[face-health] ${h.pending} photographs waiting, nothing scanned `
      + `for ${Math.round(stalledHours)}h — and nobody to tell (email_routing → system_faults, and no system admin).`);
    return { ok: false, pending: h.pending, reason: 'no recipient' };
  }

  const hours = Math.round(stalledHours);
  await dispatchEmail({
    to,
    subject: `זיהוי פנים תקוע — ${h.pending} תמונות ממתינות`,
    text: [
      `${h.pending} תמונות ממתינות לסריקה, ושום תמונה לא נסרקה כבר ${hours} שעות.`,
      h.failed ? `בנוסף, ${h.failed} תמונות נכשלו.` : '',
      h.last_error_at ? `שגיאה אחרונה: ${new Date(h.last_error_at).toLocaleString('he-IL')}` : '',
      '',
      'מה לבדוק:',
      '  npm run face:switch    — מצב התור',
      '  npm run face:models    — האם קבצי המודל נגישים לשרת',
      '',
      'ההורים לא יראו שגיאה. הם פשוט לא יקבלו תמונות.',
    ].filter(Boolean).join('\n'),
  });

  await Setting.updateOne(
    { key: LAST_SENT_KEY },
    { $set: { key: LAST_SENT_KEY, value: { at: new Date() } } },
    { upsert: true },
  );

  return { ok: false, alerted: true, pending: h.pending, stalled_hours: hours };
}

function describeTick(r) {
  if (r.alerted) {
    return [{ level: 'error', text: `[face-health] alerted: ${r.pending} waiting, stalled ${r.stalled_hours}h` }];
  }
  if (!r.ok && r.reason === 'no recipient') return [];
  return [];
}

module.exports = {
  tick, describeTick, EVERY_MS, FIRST_RUN_MS, STALL_HOURS,
};
