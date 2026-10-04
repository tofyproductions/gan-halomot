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
  const emps = await Employee.find({ _id: { $in: ids } }).select('full_name israeli_id fixed_schedule').lean();
  const { from, to } = ilDayBounds(date);
  for (const emp of emps) {
    if (emp.fixed_schedule && emp.fixed_schedule.enabled) continue;
    const start = placed.filter(e => String(e.employee_id) === String(emp._id)).map(e => e.start_hhmm).sort()[0];
    const punches = await Punch.find({
      $or: [{ employee_id: emp._id }, { employee_id: null, israeli_id: emp.israeli_id }],
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

module.exports = { attendanceVsRota };
