/**
 * A published rota is what a fixed-schedule employee is paid for.
 *
 * Her punches are generated from her fixed hours (fixedSchedule.js). Once a
 * week is published, each of its open days becomes an exception on her fixed
 * schedule — the rota's span for that day and the branch she works at, or a
 * day off. Exceptions a person set by hand stay: they are the office's word.
 * Generated punches of those days are removed so the next materialisation
 * regenerates them from the exception (days in the future have none yet).
 *
 * Only employees the rota manages are touched: fixed-schedule employees who
 * appear in the published week (or did in the snapshot before this publish).
 * Anyone never placed keeps her fixed hours. A day with a hand-edited generated
 * punch is never deleted, and an exception a person set (or the office removed)
 * is never overwritten.
 */
const { Employee, ShiftWeek, Punch, Holiday } = require('../../models');
const { weekDays } = require('./rules');
const { rotaDay } = require('./crossRules');
const { ilDayBounds, closureDateSet } = require('../fixedSchedule');

async function homeClosures(branchId, dates, weekRow) {
  const holidays = await Holiday.find({
    branch_id: branchId, kind: 'closure',
    start_date: { $lte: new Date(`${dates[dates.length - 1]}T23:59:59+03:00`) },
    end_date: { $gte: new Date(`${dates[0]}T00:00:00+03:00`) },
  }).lean();
  const set = closureDateSet(holidays, branchId);
  for (const d of (weekRow && weekRow.closed_days) || []) set.add(d);
  return set;
}

async function applyRotaToFixedSchedules({ week, closedDates, today, previousPublished = [] }) {
  const dates = weekDays(week.week_start);
  const ids = new Map();
  for (const e of [...(week.published || []), ...(previousPublished || [])]) if (e.employee_id) ids.set(String(e.employee_id), e.employee_id);
  if (!ids.size) return { employees: 0, exceptions: 0, punchesRemoved: 0 };
  const fixedEmps = await Employee.find({ _id: { $in: [...ids.values()] }, 'fixed_schedule.enabled': true });
  if (!fixedEmps.length) return { employees: 0, exceptions: 0, punchesRemoved: 0 };

  // Her day may be split across branches — every published week of this week_start counts, tagged with its branch.
  const weeks = await ShiftWeek.find({ week_start: week.week_start, branch_id: { $ne: week.branch_id } }).lean();
  const all = [
    ...(week.published || []).map(e => ({ ...e, branch_id: e.branch_id || String(week.branch_id) })),
    ...weeks.flatMap(w => (w.published || []).map(e => ({ ...e, branch_id: String(w.branch_id) }))),
  ];
  const closureCache = new Map();
  const closuresOf = async (branchId) => {
    const key = String(branchId);
    if (key === String(week.branch_id)) return closedDates || new Set();
    if (!closureCache.has(key)) {
      const row = weeks.find(w => String(w.branch_id) === key) || null;
      closureCache.set(key, await homeClosures(branchId, dates, row));
    }
    return closureCache.get(key);
  };

  let exceptions = 0; let punchesRemoved = 0; let employees = 0;
  for (const emp of fixedEmps) {
    try {
      const mine = all.filter(e => String(e.employee_id) === String(emp._id));
      const closed = await closuresOf(emp.branch_id);
      const list = emp.fixed_schedule.exceptions || [];
      const touched = [];
      for (const date of dates) {
        const day = rotaDay(mine, date);
        if (!day && closed.has(date)) continue;
        const existing = list.findIndex(x => x.date === date);
        if (existing >= 0 && list[existing].source !== 'rota') continue;
        const ex = day
          ? { date, off: false, in: day.in, out: day.out, branch_id: day.branch_id, note: 'סידור עבודה', source: 'rota' }
          : { date, off: true, in: '', out: '', branch_id: null, note: 'סידור עבודה — לא משובצת', source: 'rota' };
        if (existing >= 0) list[existing] = ex; else list.push(ex);
        exceptions += 1;
        touched.push(date);
      }
      emp.fixed_schedule.exceptions = list;
      await emp.save();
      employees += 1;
      for (const date of touched.filter(d => d <= today)) {
        const { from, to } = ilDayBounds(date);
        const range = { $gte: from, $lt: to };
        const edited = await Punch.exists({ employee_id: emp._id, timestamp_source: 'fixed_schedule', schedule_edited: true, timestamp: range });
        if (edited) continue; // a person corrected this day — leave all of it
        const r = await Punch.deleteMany({ employee_id: emp._id, timestamp_source: 'fixed_schedule', timestamp: range });
        punchesRemoved += r.deletedCount || 0;
      }
    } catch (err) {
      console.error('[rota-pay]', emp._id, err.stack);
    }
  }
  return { employees, exceptions, punchesRemoved };
}

module.exports = { applyRotaToFixedSchedules };
