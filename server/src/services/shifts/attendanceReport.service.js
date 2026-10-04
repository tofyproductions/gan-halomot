/**
 * Yesterday's published rota against yesterday's punches. Information for
 * managers and the office, nothing to approve: who was placed and never
 * punched, and who arrived more than 30 minutes after her scheduled start.
 */
const { ShiftWeek, Employee, Punch } = require('../../models');
const { weekStart } = require('../parentVisibility');
const { ilDayBounds, ISR_DAY } = require('../fixedSchedule');
const { lateness } = require('./crossRules');

const hhmmIL = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

async function attendanceVsRota({ branchId, date }) {
  const week = await ShiftWeek.findOne({ branch_id: branchId, week_start: weekStart(date), published_at: { $ne: null } }).lean();
  const out = { date, branch_id: String(branchId), rows: [] };
  if (!week) return out;
  const placed = (week.published || []).filter(e => e.date === date && e.start_hhmm);
  const ids = [...new Set(placed.map(e => String(e.employee_id)))];
  const emps = await Employee.find({ _id: { $in: ids }, is_active: { $ne: false } }).select('full_name israeli_id fixed_schedule').lean();
  const { from, to } = ilDayBounds(date);
  for (const emp of emps) {
    if (emp.fixed_schedule && emp.fixed_schedule.enabled) continue;
    const start = placed.filter(e => String(e.employee_id) === String(emp._id)).map(e => e.start_hhmm).sort()[0];
    // Unlinked clock punches are hers only by her ת"ז — without one, only her linked punches count.
    const who = [{ employee_id: emp._id }];
    if (emp.israeli_id) who.push({ employee_id: null, israeli_id: emp.israeli_id });
    const punches = await Punch.find({
      $or: who,
      timestamp: { $gte: from, $lt: to }, ignored: { $ne: true },
      approval_status: { $in: ['auto', 'approved'] }, timestamp_source: { $ne: 'fixed_schedule' },
    }).sort({ timestamp: 1 }).limit(1).lean();
    const first = punches.length && ISR_DAY(punches[0].timestamp) === date ? hhmmIL(punches[0].timestamp) : null;
    const verdict = lateness(first, start);
    if (verdict) out.rows.push({ employee_id: String(emp._id), employee_name: emp.full_name, scheduled_start: start, first_punch: first, ...verdict });
  }
  out.rows.sort((a, b) => a.employee_name.localeCompare(b.employee_name, 'he'));
  return out;
}

/**
 * The clock's answer per employee per day of the week — first punch in, last
 * punch out — for the days that already happened. Generated fixed-schedule
 * punches count too: they are what payroll counts for her. One punch with no
 * exit yet comes back as { in, out: null }.
 */
async function actualWeek({ branchId, weekStart: ws }) {
  const { weekDays } = require('./rules');
  const dates = weekDays(ws);
  const today = ISR_DAY(new Date());
  const past = dates.filter(d => d <= today);
  if (!past.length) return {};
  const emps = await Employee.find({ branch_id: branchId, is_active: true }).select('israeli_id').lean();
  if (!emps.length) return {};
  const withTz = emps.filter(e => e.israeli_id);
  const idOfTz = new Map(withTz.map(e => [e.israeli_id, String(e._id)]));
  const { from } = ilDayBounds(past[0]);
  const { to } = ilDayBounds(past[past.length - 1]);
  const punches = await Punch.find({
    $or: [
      { employee_id: { $in: emps.map(e => e._id) } },
      { employee_id: null, israeli_id: { $in: withTz.map(e => e.israeli_id) } },
    ],
    timestamp: { $gte: from, $lt: to },
    ignored: { $ne: true },
    approval_status: { $in: ['auto', 'approved'] },
  }).sort({ timestamp: 1 }).select('employee_id israeli_id timestamp').lean();
  const out = {};
  for (const p of punches) {
    const id = p.employee_id ? String(p.employee_id) : idOfTz.get(p.israeli_id);
    if (!id) continue;
    const d = ISR_DAY(p.timestamp);
    if (!past.includes(d)) continue;
    const mine = (out[id] = out[id] || {});
    const day = (mine[d] = mine[d] || { in: null, out: null });
    const t = hhmmIL(p.timestamp);
    if (!day.in) day.in = t;
    else day.out = t; // sorted ascending — the last one wins
  }
  return out;
}

module.exports = { attendanceVsRota, actualWeek };
