/**
 * 07:00 every weekday morning: yesterday's no-shows and late arrivals, per
 * branch to its managers and as one summary to the office. Gated like the
 * punch digest — hourly calls, once a day via a Setting marker.
 */
const { Branch, Setting, User } = require('../models');
const notificationService = require('./notification.service');
const { branchManagerFilter } = require('./branch-recipients.service');
const { attendanceVsRota } = require('./shifts/attendanceReport.service');

const MARKER_KEY = 'shift_attendance_report_day';
const HOUR_IL = 7;
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function ilParts(now) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hourCycle: 'h23' }).format(now));
  return { day, hour };
}
const pushOnce = (payload) => notificationService.notifyOnce(payload).catch(err => console.error('[attendance-report] notify failed:', err.message));

async function tick(now = new Date()) {
  const { day, hour } = ilParts(now);
  if (hour < HOUR_IL) return { skipped: 'not 07:00 yet' };
  const yesterday = addDays(day, -1);
  if (new Date(`${yesterday}T12:00:00Z`).getUTCDay() === 6) return { skipped: 'yesterday was Saturday' };
  const marker = await Setting.findOne({ key: MARKER_KEY }).lean();
  if (marker && marker.value === day) return { skipped: 'already ran' };
  await Setting.updateOne({ key: MARKER_KEY }, { $set: { value: day } }, { upsert: true });

  const branches = await Branch.find({ is_active: { $ne: false } }).select('name').lean();
  const summary = [];
  for (const b of branches) {
    const rep = await attendanceVsRota({ branchId: b._id, date: yesterday });
    if (!rep.rows.length) continue;
    const absent = rep.rows.filter(r => r.kind === 'absent').length;
    const late = rep.rows.length - absent;
    const text = [absent && `${absent} לא הגיעו`, late && `${late} איחרו`].filter(Boolean).join(', ');
    summary.push({ branch: b, text });
    const managers = await User.find({ ...branchManagerFilter(b._id), role: 'branch_manager' }).select('_id').lean();
    for (const m of managers) {
      await pushOnce({ type: 'shift_attendance_report', ref_collection: 'Branch', ref_id: b._id, recipient_id: m._id,
        title: `נוכחות מול סידור — אתמול`, body: `${b.name}: ${text}`, url: `/shifts?report=${yesterday}` });
    }
  }
  if (summary.length) {
    const office = await User.find({ role: { $in: ['system_admin', 'accountant'] }, is_active: { $ne: false } }).select('_id').lean();
    for (const u of office) {
      await pushOnce({ type: 'shift_attendance_report_office', ref_collection: 'Branch', ref_id: summary[0].branch._id, recipient_id: u._id,
        title: 'נוכחות מול סידור — אתמול', body: summary.map(s => `${s.branch.name}: ${s.text}`).join(' · ').slice(0, 300), url: `/shifts?report=${yesterday}` });
    }
  }
  return { date: yesterday, branches: summary.length };
}

module.exports = { tick, MARKER_KEY };
