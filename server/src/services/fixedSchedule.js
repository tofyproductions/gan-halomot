const { Employee, Punch } = require('../models');

/**
 * Fixed hours — punches for employees who don't clock in.
 *
 * Some staff (office, managers, a site with no clock) are paid on standing
 * weekly hours instead of a device reading. Rather than teach the payroll engine
 * a second source of truth, we MATERIALIZE their days as ordinary Punch records:
 * every downstream consumer — salary calc, the hours report, the attendance
 * grid, the punch-issues screen — keeps working unchanged, and a single day can
 * be edited or deleted exactly like any other punch.
 *
 * Two rules keep it honest:
 *   • Never generate beyond today. The month fills in day by day, so the hours
 *     report reflects work done and not a forecast.
 *   • Never touch a day that already has punches. If she did clock in, the clock
 *     wins and the day is reported as a CONFLICT for a human to decide.
 */

const ISR_DAY = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

/** Today's date in Israel, as 'YYYY-MM-DD'. */
function todayIsrael() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

/**
 * Build the UTC Date for an Israel-local wall-clock time, honouring DST for
 * that specific date (UTC+2 in winter, UTC+3 in summer).
 */
function ilDateTime(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const ilHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(probe),
    10,
  );
  const offsetHours = ilHour - 12; // 2 or 3
  return new Date(Date.UTC(y, m - 1, d, hh - offsetHours, mm, 0));
}

/**
 * Serial number for a generated punch — negative, and DERIVED from
 * (employee, date, in/out) rather than the clock, for two reasons:
 *
 *   • Negative keeps it clear of real device records (always positive) and of
 *     manual entries (which use -Date.now(), a different magnitude).
 *   • Deterministic means the unique (branch_id, device_user_sn) index is what
 *     enforces "one pair per day": if two page loads race to fill the same
 *     month, the second insert is rejected by the database instead of quietly
 *     doubling the day's hours.
 *
 * Layout: -(YYYYMMDD × 2^25 + employeeHash24 × 2 + slot), which stays well
 * inside Number.MAX_SAFE_INTEGER.
 */
function syntheticSn(employeeId, dateStr, slot) {
  const dateNum = Number(dateStr.replace(/-/g, ''));           // 20260722
  const hex = String(employeeId).slice(-6);                     // 24 bits of the ObjectId
  const empHash = parseInt(hex, 16) % 0x1000000;
  return -(dateNum * 0x2000000 + empHash * 2 + slot);
}

/** Weekday (0=Sun … 6=Sat) of a 'YYYY-MM-DD' string, in Israel terms. */
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Every 'YYYY-MM-DD' in `month` up to and including `lastDate`. */
function datesInMonth(month, lastDate) {
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${month}-${String(d).padStart(2, '0')}`;
    if (lastDate && iso > lastDate) break;
    out.push(iso);
  }
  return out;
}

/**
 * What the schedule says about one date: the hours to work, or null for a day
 * off. An exception always beats the weekly pattern.
 */
function plannedHoursFor(schedule, dateStr) {
  const ex = (schedule.exceptions || []).find(e => e.date === dateStr);
  if (ex) {
    if (ex.off) return null;
    if (ex.in && ex.out) return { in: ex.in, out: ex.out, from_exception: true };
    // An exception with no hours and not marked off is meaningless — fall through.
  }
  const day = (schedule.days || []).find(d => d.weekday === weekdayOf(dateStr));
  if (!day || !day.in || !day.out) return null;
  return { in: day.in, out: day.out, from_exception: false };
}

/** Employees with an active fixed schedule, optionally narrowed to branches. */
async function scheduledEmployees({ branchIds = null, employeeIds = null } = {}) {
  // Never materialize hours for someone the system does not pay — the hours
  // would only ever be looked at to compute a salary that isn't coming.
  const filter = { 'fixed_schedule.enabled': true, receives_salary: { $ne: false } };
  if (branchIds) filter.branch_id = { $in: branchIds };
  if (employeeIds) filter._id = { $in: employeeIds };
  return Employee.find(filter).select('full_name israeli_id branch_id start_date fixed_schedule').lean();
}

/**
 * Fill in a month's fixed-schedule punches, up to today.
 *
 * Idempotent: a day that already carries punches (generated, manual, or from the
 * clock) is left alone, so calling this on every payroll/attendance load is safe
 * and cheap. Returns what was created plus the conflicts worth surfacing.
 */
async function materializeMonth(month, { branchIds = null, employeeIds = null, userId = null } = {}) {
  if (!/^\d{4}-\d{2}$/.test(month)) return { created: 0, conflicts: [] };

  const employees = await scheduledEmployees({ branchIds, employeeIds });
  if (employees.length === 0) return { created: 0, conflicts: [] };

  const today = todayIsrael();
  const currentMonth = today.slice(0, 7);
  if (month > currentMonth) return { created: 0, conflicts: [] }; // never ahead of today
  const dates = datesInMonth(month, month === currentMonth ? today : null);
  if (dates.length === 0) return { created: 0, conflicts: [] };

  // One read for the whole month's punches for these employees — we only need
  // to know WHICH days are already occupied and by what.
  const empIds = employees.map(e => e._id);
  const from = ilDateTime(dates[0], '00:00');
  const to = new Date(ilDateTime(dates[dates.length - 1], '00:00').getTime() + 36 * 3600 * 1000);
  const existing = await Punch.find({
    employee_id: { $in: empIds },
    timestamp: { $gte: from, $lt: to },
    ignored: { $ne: true },
  }).select('employee_id timestamp timestamp_source').lean();

  const occupied = new Map(); // 'empId|date' → { generated: n, real: n }
  for (const p of existing) {
    const k = `${String(p.employee_id)}|${ISR_DAY(p.timestamp)}`;
    const slot = occupied.get(k) || { generated: 0, real: 0 };
    if (p.timestamp_source === 'fixed_schedule') slot.generated += 1; else slot.real += 1;
    occupied.set(k, slot);
  }

  const toCreate = [];
  const conflicts = [];
  for (const emp of employees) {
    const sched = emp.fixed_schedule || {};
    // Earliest date the arrangement covers.
    const empStart = emp.start_date ? ISR_DAY(emp.start_date) : null;
    const floor = [sched.start_date, empStart].filter(Boolean).sort().pop() || null;

    for (const date of dates) {
      if (floor && date < floor) continue;
      const planned = plannedHoursFor(sched, date);
      if (!planned) continue;

      const slot = occupied.get(`${String(emp._id)}|${date}`);
      if (slot?.real) {
        // She punched on a day the schedule also covers — the clock is reality,
        // so we generate nothing and let a human decide in "בעיות בהחתמה".
        conflicts.push({
          employee_id: String(emp._id),
          full_name: emp.full_name,
          branch_id: emp.branch_id ? String(emp.branch_id) : null,
          date,
          planned_in: planned.in,
          planned_out: planned.out,
          clock_punches: slot.real,
        });
        continue;
      }
      if (slot?.generated) continue; // already materialized

      toCreate.push({ emp, date, planned });
    }
  }

  if (toCreate.length === 0) return { created: 0, conflicts };

  const docs = [];
  toCreate.forEach(({ emp, date, planned }) => {
    const inSn = syntheticSn(emp._id, date, 0);
    const outSn = syntheticSn(emp._id, date, 1);
    const note = planned.from_exception ? 'שעות קבועות (חריג ליום זה)' : 'שעות קבועות';
    docs.push(
      {
        branch_id: emp.branch_id,
        employee_id: emp._id,
        israeli_id: emp.israeli_id || '',
        device_user_sn: inSn,
        timestamp: ilDateTime(date, planned.in),
        timestamp_source: 'fixed_schedule',
        state: 0,
        received_at: new Date(),
        agent_version: 'fixed-schedule',
        manual_note: note,
        created_by: userId,
        approval_status: 'approved',
        approval_decided_by: userId,
        approval_decided_at: new Date(),
      },
      {
        branch_id: emp.branch_id,
        employee_id: emp._id,
        israeli_id: emp.israeli_id || '',
        device_user_sn: outSn,
        timestamp: ilDateTime(date, planned.out),
        timestamp_source: 'fixed_schedule',
        state: 1,
        received_at: new Date(),
        agent_version: 'fixed-schedule',
        manual_note: note,
        created_by: userId,
        approval_status: 'approved',
        approval_decided_by: userId,
        approval_decided_at: new Date(),
      },
    );
  });

  // ordered:false so one duplicate-key straggler can't abort the whole fill.
  try {
    await Punch.insertMany(docs, { ordered: false });
  } catch (err) {
    if (err.code !== 11000 && !err.writeErrors) throw err;
  }
  return { created: docs.length, conflicts };
}

/**
 * Conflicts only — a scheduled day the employee also clocked in on. Used by the
 * punch-issues screen without paying for a write pass.
 */
async function conflictsForMonth(month, { branchIds = null } = {}) {
  const employees = await scheduledEmployees({ branchIds });
  if (employees.length === 0) return [];

  const today = todayIsrael();
  const currentMonth = today.slice(0, 7);
  if (month > currentMonth) return [];
  const dates = datesInMonth(month, month === currentMonth ? today : null);
  if (dates.length === 0) return [];

  const empIds = employees.map(e => e._id);
  const from = ilDateTime(dates[0], '00:00');
  const to = new Date(ilDateTime(dates[dates.length - 1], '00:00').getTime() + 36 * 3600 * 1000);
  const punches = await Punch.find({
    employee_id: { $in: empIds },
    timestamp: { $gte: from, $lt: to },
    ignored: { $ne: true },
    timestamp_source: { $ne: 'fixed_schedule' },
  }).select('employee_id timestamp').lean();

  const realByDay = new Map();
  for (const p of punches) {
    const k = `${String(p.employee_id)}|${ISR_DAY(p.timestamp)}`;
    realByDay.set(k, (realByDay.get(k) || 0) + 1);
  }

  const out = [];
  for (const emp of employees) {
    for (const date of dates) {
      const n = realByDay.get(`${String(emp._id)}|${date}`);
      if (!n) continue;
      const planned = plannedHoursFor(emp.fixed_schedule || {}, date);
      if (!planned) continue;
      out.push({
        employee_id: String(emp._id),
        full_name: emp.full_name,
        branch_id: emp.branch_id ? String(emp.branch_id) : null,
        date,
        planned_in: planned.in,
        planned_out: planned.out,
        clock_punches: n,
      });
    }
  }
  return out;
}

/**
 * Record that a generated day should NOT come back — called when someone
 * deletes a fixed-schedule punch from the attendance grid. Without this the
 * next materialization pass would simply recreate it.
 */
async function markDayOff(employeeId, dateStr, note = 'נמחק ידנית מהמסך') {
  const emp = await Employee.findById(employeeId).select('fixed_schedule');
  if (!emp || !emp.fixed_schedule?.enabled) return false;
  const list = emp.fixed_schedule.exceptions || [];
  const idx = list.findIndex(e => e.date === dateStr);
  if (idx >= 0) {
    list[idx].off = true;
    list[idx].in = '';
    list[idx].out = '';
    if (!list[idx].note) list[idx].note = note;
  } else {
    list.push({ date: dateStr, off: true, in: '', out: '', note });
  }
  emp.fixed_schedule.exceptions = list;
  await emp.save();
  return true;
}

module.exports = {
  materializeMonth,
  conflictsForMonth,
  markDayOff,
  plannedHoursFor,
  datesInMonth,
  weekdayOf,
  todayIsrael,
  ilDateTime,
  ISR_DAY,
};
