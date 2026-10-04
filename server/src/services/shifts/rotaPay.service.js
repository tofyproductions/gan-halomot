/**
 * A published rota is what a fixed-schedule employee is paid for.
 *
 * Her punches are generated from her fixed hours (fixedSchedule.js). Once a
 * week is published, each of its open days becomes an exception on her fixed
 * schedule — the rota's span for that day and the branch she works at, or a
 * day off. Exceptions a person set by hand stay: they are the office's word.
 * Generated punches of those days are removed so the next materialisation
 * regenerates them from the exception (days in the future have none yet).
 */
const { Employee, ShiftWeek, Punch } = require('../../models');
const { weekDays } = require('./rules');
const { rotaDay } = require('./crossRules');
const { ilDayBounds } = require('../fixedSchedule');

async function applyRotaToFixedSchedules({ week, closedDates, today }) {
  const dates = weekDays(week.week_start);
  const fixedEmps = await Employee.find({ 'fixed_schedule.enabled': true, branch_id: week.branch_id });
  if (!fixedEmps.length) return { employees: 0, exceptions: 0, punchesRemoved: 0 };
  // Her day may be split across branches — collect her published entries in every branch this week.
  const weeks = await ShiftWeek.find({ week_start: week.week_start, branch_id: { $ne: week.branch_id }, 'published.employee_id': { $in: fixedEmps.map(e => e._id) } }).lean();
  const elsewhere = weeks.flatMap(w => (w.published || []).map(e => ({ ...e, branch_id: String(w.branch_id) })));
  let exceptions = 0; let punchesRemoved = 0;
  for (const emp of fixedEmps) {
    const own = (week.published || []).filter(e => String(e.employee_id) === String(emp._id)).map(e => ({ ...e, branch_id: e.branch_id || String(week.branch_id) }));
    const mine = [...own, ...elsewhere.filter(e => String(e.employee_id) === String(emp._id))];
    const list = emp.fixed_schedule.exceptions || [];
    const touched = [];
    for (const date of dates) {
      if (closedDates.has(date)) continue;
      const existing = list.findIndex(x => x.date === date);
      if (existing >= 0 && list[existing].source !== 'rota') continue;
      const day = rotaDay(mine, date);
      const ex = day
        ? { date, off: false, in: day.in, out: day.out, branch_id: day.branch_id, note: 'סידור עבודה', source: 'rota' }
        : { date, off: true, in: '', out: '', branch_id: null, note: 'סידור עבודה — לא משובצת', source: 'rota' };
      if (existing >= 0) list[existing] = ex; else list.push(ex);
      exceptions += 1;
      touched.push(date);
    }
    emp.fixed_schedule.exceptions = list;
    await emp.save();
    for (const date of touched.filter(d => d <= today)) {
      const { from, to } = ilDayBounds(date);
      const r = await Punch.deleteMany({ employee_id: emp._id, timestamp_source: 'fixed_schedule', schedule_edited: { $ne: true }, timestamp: { $gte: from, $lt: to } });
      punchesRemoved += r.deletedCount || 0;
    }
  }
  return { employees: fixedEmps.length, exceptions, punchesRemoved };
}

module.exports = { applyRotaToFixedSchedules };
