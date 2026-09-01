/**
 * "השלמת שכר אוגוסט" — closure-completion punches.
 *
 * Some branches close for the summer before the month is out (school year end
 * / קייטנה finishing), and again before the new year's first day. Committed
 * staff lose real pay for those days through no fault of theirs — the gan
 * simply wasn't open. When the admin flags an employee's
 * PayrollMonth.manual.closure_completion for a month, this MATERIALIZES her
 * committed weekdays inside her branch's Holiday closure window that carry no
 * real punch, as ordinary Punch rows (source 'closure_completion') — the same
 * "make it a real row, don't teach payroll a second source of truth" move as
 * services/fixedSchedule.js.
 *
 * What happens to those rows downstream differs by salary type, and lives
 * OUTSIDE this file on purpose (this file only decides WHICH days and
 * generates the rows):
 *   - hourly: counted like any other punch — they pay for themselves.
 *   - global (תקן): excluded from hours by payrollCalc.js (salaryType==='global'
 *     drops timestamp_source==='closure_completion' from countablePunches) —
 *     payrollMonth.controller.js prices them separately as a בונוס line and
 *     offsets the automatic completion so the total isn't paid twice. The row
 *     still shows up in the attendance grid as a visual marker.
 *
 * Idempotent and conservative: a date that already carries ANY punch (real,
 * or a previous run's) is never touched. There is no conflict-resolution UI
 * here like fixedSchedule's — the real clock always silently wins, which is
 * safe (never overwrites, never duplicates) even without one.
 */

const { Employee, EmployeeCommitment, Holiday, Punch, PayrollMonth } = require('../models');
const { ilDateTime, ISR_DAY, weekdayOf, todayIsrael } = require('./fixedSchedule');

/** Every 'YYYY-MM-DD' from `start` to `end` inclusive. */
function dateRange(start, end) {
  const out = [];
  let d = start;
  let guard = 0;
  while (d <= end && guard < 400) { // 400 days is far beyond any real closure window
    out.push(d);
    const [y, m, day] = d.split('-').map(Number);
    d = new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10);
    guard++;
  }
  return out;
}

/**
 * Union of every `kind: 'closure'` Holiday for this branch overlapping `month`.
 * ('short_day' is excluded on purpose — the gan is open that day.)
 * Returns { start, end } as 'YYYY-MM-DD', or null if no closure is recorded.
 */
async function closureWindowForBranch(branchId, month) {
  const [yy, mm] = month.split('-').map(Number);
  const monthStart = new Date(Date.UTC(yy, mm - 1, 1));
  const monthEnd = new Date(Date.UTC(yy, mm, 0, 23, 59, 59));
  const closures = await Holiday.find({
    branch_id: branchId,
    kind: 'closure',
    start_date: { $lte: monthEnd },
    end_date: { $gte: monthStart },
  }).select('start_date end_date').lean();
  if (closures.length === 0) return null;
  const starts = closures.map(h => ISR_DAY(h.start_date));
  const ends = closures.map(h => ISR_DAY(h.end_date));
  return { start: starts.sort()[0], end: ends.sort().pop() };
}

/**
 * What the commitment says about one weekday: { start_hhmm, end_hhmm } to
 * complete, or null (no commitment / day off / an alternating day — we can't
 * know which specific weeks she's committed on, so it's never auto-completed).
 */
function committedHoursForWeekday(commitment, weekday) {
  if (!commitment) return null;
  if (commitment.is_alternating_off && commitment.alternating_day === weekday) return null;
  const day = (commitment.days || []).find(d => d.day === weekday);
  if (!day || day.is_off) return null;
  if (!day.start_hhmm || !day.end_hhmm) return null;
  return { start_hhmm: day.start_hhmm, end_hhmm: day.end_hhmm };
}

/**
 * Committed weekdays in [windowStart, windowEnd] with no real punch.
 * `realDates` is a Set of 'YYYY-MM-DD' — every date she already has ANY punch on.
 */
function gapDatesForEmployee(commitment, realDates, windowStart, windowEnd) {
  const out = [];
  for (const date of dateRange(windowStart, windowEnd)) {
    const weekday = weekdayOf(date);
    if (weekday === 6) continue; // Saturday — never a work day
    if (realDates.has(date)) continue;
    const hours = committedHoursForWeekday(commitment, weekday);
    if (!hours) continue;
    out.push({ date, ...hours });
  }
  return out;
}

/** Deterministic negative serial, in its own range so it can never collide
 * with fixedSchedule's synthetic punches (which start at 0) or a real device
 * reading (always positive). */
function syntheticSn(employeeId, dateStr, slot) {
  const dateNum = Number(dateStr.replace(/-/g, ''));
  const hex = String(employeeId).slice(-6);
  const empHash = parseInt(hex, 16) % 0x1000000;
  return -(4_000_000_000_000_000 + dateNum * 0x2000000 + empHash * 2 + slot);
}

/**
 * Fill in closure-completion punches for every employee flagged for `month`,
 * optionally narrowed to `branchIds` / `employeeIds`. Safe to call repeatedly
 * (e.g. on every payroll/attendance load, like fixedSchedule.materializeMonth).
 */
async function materializeMonth(month, { branchIds = null, employeeIds = null, userId = null } = {}) {
  if (!/^\d{4}-\d{2}$/.test(month)) return { created: 0 };

  const pmFilter = { month, 'manual.closure_completion': true };
  if (employeeIds) pmFilter.employee_id = { $in: employeeIds };
  if (branchIds) pmFilter.branch_id = { $in: branchIds };
  const flagged = await PayrollMonth.find(pmFilter).select('employee_id').lean();
  if (flagged.length === 0) return { created: 0 };
  const empIds = flagged.map(f => f.employee_id);

  const [employees, commitments] = await Promise.all([
    Employee.find({ _id: { $in: empIds } }).select('full_name israeli_id branch_id').lean(),
    EmployeeCommitment.find({ employee_id: { $in: empIds } }).lean(),
  ]);
  const commitmentByEmp = new Map(commitments.map(c => [String(c.employee_id), c]));

  const today = todayIsrael();
  const branchWindowCache = new Map(); // branchId → window | null
  const toCreate = [];
  let skippedNoCommitment = 0;
  let skippedNoWindow = 0;

  for (const emp of employees) {
    const commitment = commitmentByEmp.get(String(emp._id));
    if (!commitment) { skippedNoCommitment++; continue; }
    if (!emp.branch_id) { skippedNoWindow++; continue; }

    const bId = String(emp.branch_id);
    if (!branchWindowCache.has(bId)) {
      branchWindowCache.set(bId, await closureWindowForBranch(emp.branch_id, month));
    }
    const window = branchWindowCache.get(bId);
    if (!window) { skippedNoWindow++; continue; }

    const windowEnd = window.end > today ? today : window.end; // never generate ahead of today
    if (window.start > windowEnd) continue;

    const from = ilDateTime(window.start, '00:00');
    const to = new Date(ilDateTime(windowEnd, '00:00').getTime() + 36 * 3600 * 1000);
    const existing = await Punch.find({
      employee_id: emp._id,
      timestamp: { $gte: from, $lt: to },
    }).select('timestamp').lean();
    const realDates = new Set(existing.map(p => ISR_DAY(p.timestamp)));

    const gaps = gapDatesForEmployee(commitment, realDates, window.start, windowEnd);
    for (const g of gaps) {
      const inSn = syntheticSn(emp._id, g.date, 0);
      const outSn = syntheticSn(emp._id, g.date, 1);
      const note = 'השלמת שכר אוגוסט — הגן היה סגור';
      toCreate.push(
        {
          branch_id: emp.branch_id,
          employee_id: emp._id,
          israeli_id: emp.israeli_id || '',
          device_user_sn: inSn,
          timestamp: ilDateTime(g.date, g.start_hhmm),
          timestamp_source: 'closure_completion',
          state: 0,
          received_at: new Date(),
          agent_version: 'closure-completion',
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
          timestamp: ilDateTime(g.date, g.end_hhmm),
          timestamp_source: 'closure_completion',
          state: 1,
          received_at: new Date(),
          agent_version: 'closure-completion',
          manual_note: note,
          created_by: userId,
          approval_status: 'approved',
          approval_decided_by: userId,
          approval_decided_at: new Date(),
        },
      );
    }
  }

  if (toCreate.length === 0) return { created: 0, skipped_no_commitment: skippedNoCommitment, skipped_no_window: skippedNoWindow };

  try {
    await Punch.insertMany(toCreate, { ordered: false });
  } catch (err) {
    if (err.code !== 11000 && !err.writeErrors) throw err;
  }
  return { created: toCreate.length, skipped_no_commitment: skippedNoCommitment, skipped_no_window: skippedNoWindow };
}

module.exports = {
  closureWindowForBranch,
  gapDatesForEmployee,
  committedHoursForWeekday,
  materializeMonth,
};
