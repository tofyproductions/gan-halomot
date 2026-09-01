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

const { Employee, EmployeeCommitment, Holiday, Punch, PayrollMonth, Branch } = require('../models');
const { ilDateTime, ISR_DAY, weekdayOf, todayIsrael } = require('./fixedSchedule');

/**
 * Fallback closure window, used ONLY when no Holiday(kind:'closure') entry is
 * found for the branch — the office's stated policy (2026-09-01): every
 * branch closes 9.8 and resumes 29.8, except קפלן which closes 10.8 and
 * resumes 1.9. A Holiday entry, if one exists, always wins — this exists
 * because that entry turned out to be missing/misconfigured for the 2026
 * closure and the office needed completion to work correctly regardless.
 *
 * Matched by substring on the branch name since there are only two policies
 * today; `end` lands within August either way (31.8 the day before 1.9, 28.8
 * the day before 29.8), so no cross-month arithmetic is needed.
 *
 * TODO: once every branch has a real Holiday(kind:'closure') entry for the
 * relevant year, this stops being consulted (closureWindowForBranch only
 * calls it when the Holiday lookup comes back empty) — it can stay as a
 * standing safety net for a branch that's missing one.
 */
const DEFAULT_CLOSURE_POLICY = [
  { match: /קפלן/, startDay: 11, endDay: 31 },
  { match: /.*/, startDay: 10, endDay: 28 },
];

async function fallbackClosureWindow(branchId, month) {
  if (!/-08$/.test(month)) return null; // the policy only speaks to August
  const branch = await Branch.findById(branchId).select('name').lean();
  const name = branch?.name || '';
  const policy = DEFAULT_CLOSURE_POLICY.find(p => p.match.test(name));
  if (!policy) return null;
  return {
    start: `${month}-${String(policy.startDay).padStart(2, '0')}`,
    end: `${month}-${String(policy.endDay).padStart(2, '0')}`,
    from_fallback_policy: true,
  };
}

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
  if (closures.length === 0) return fallbackClosureWindow(branchId, month);
  const starts = closures.map(h => ISR_DAY(h.start_date));
  const ends = closures.map(h => ISR_DAY(h.end_date));
  return { start: starts.sort()[0], end: ends.sort().pop() };
}

/**
 * What the commitment says about one weekday: { start_hhmm, end_hhmm } to
 * complete, or null (no commitment / day off / an alternating day — we can't
 * know which specific weeks she's committed on, so it's never auto-completed).
 *
 * start_hhmm is still used as the anchor clock time for the completed shift
 * (it has to start sometime, and her usual start time reads naturally on the
 * attendance grid); end_hhmm is the FALLBACK duration only, for a weekday
 * averageMinutesByWeekday has no data for — see gapDatesForEmployee.
 */
function committedHoursForWeekday(commitment, weekday) {
  if (!commitment) return null;
  if (commitment.is_alternating_off && commitment.alternating_day === weekday) return null;
  const day = (commitment.days || []).find(d => d.day === weekday);
  if (!day || day.is_off) return null;
  if (!day.start_hhmm || !day.end_hhmm) return null;
  return { start_hhmm: day.start_hhmm, end_hhmm: day.end_hhmm };
}

/** 'HH:MM' + minutes → 'HH:MM', clamped to the same calendar day (a shift
 * never wraps past midnight here — the longest real day is nowhere close). */
function addMinutesToHHMM(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.max(0, Math.min(23 * 60 + 59, h * 60 + m + Math.round(minutes)));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * How long she actually worked, on average, each weekday she showed up for,
 * over the `months` calendar months immediately before `beforeDate`.
 *
 * "Real" punches only — timestamp_source outside fixed_schedule/closure_completion,
 * and only auto/approved (the same countability rule payrollCalc.js applies) —
 * so a prior completion run, or an unresolved multi-punch day, never leaks into
 * the average that later completions are priced from.
 *
 * A day's worked minutes are its first-punch-to-last-punch span — matching
 * collapseToSpan()'s provisional pairing in payrollCalc.js. It slightly
 * overstates a day with an unresolved lunch-break gap, but under-stating by
 * strict pairing would silently drop legitimate multi-session days from the
 * average instead of just being a little generous on a handful of inputs.
 *
 * Returns a Map<weekday 0-6, avgMinutes>. A weekday with no data simply has no
 * entry — the caller falls back to her committed shift length rather than
 * completing the day at zero hours.
 */
async function averageMinutesByWeekday(employeeId, beforeDate, months = 3) {
  const [y, m, d] = beforeDate.split('-').map(Number);
  const toDate = new Date(Date.UTC(y, m - 1, d));
  const fromDate = new Date(Date.UTC(y, m - 1 - months, d));
  const from = ilDateTime(fromDate.toISOString().slice(0, 10), '00:00');
  const to = ilDateTime(toDate.toISOString().slice(0, 10), '00:00');

  const punches = await Punch.find({
    employee_id: employeeId,
    timestamp: { $gte: from, $lt: to },
    ignored: { $ne: true },
    timestamp_source: { $nin: ['fixed_schedule', 'closure_completion'] },
  }).select('timestamp approval_status').lean();

  const byDay = new Map(); // date → sorted epoch-ms[]
  for (const p of punches) {
    const s = p.approval_status || 'auto';
    if (s !== 'auto' && s !== 'approved') continue;
    const date = ISR_DAY(p.timestamp);
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(new Date(p.timestamp).getTime());
  }

  const sums = new Map(); // weekday → { total, count }
  for (const [date, times] of byDay) {
    if (times.length < 2) continue; // no span to measure
    times.sort((a, b) => a - b);
    const minutes = Math.round((times[times.length - 1] - times[0]) / 60000);
    if (minutes <= 0) continue;
    const wd = weekdayOf(date);
    const cur = sums.get(wd) || { total: 0, count: 0 };
    cur.total += minutes; cur.count += 1;
    sums.set(wd, cur);
  }

  const avg = new Map();
  for (const [wd, { total, count }] of sums) avg.set(wd, total / count);
  return avg;
}

/**
 * Committed weekdays in [windowStart, windowEnd] with no real punch.
 * `realDates` is a Set of 'YYYY-MM-DD' — every date she already has ANY punch on.
 * `avgMinutesByWeekday` (from averageMinutesByWeekday) prices each completed
 * day by her own recent-history average for that weekday; a weekday absent
 * from it falls back to her committed shift's own length.
 */
function gapDatesForEmployee(commitment, realDates, windowStart, windowEnd, avgMinutesByWeekday = new Map()) {
  const out = [];
  for (const date of dateRange(windowStart, windowEnd)) {
    const weekday = weekdayOf(date);
    if (weekday === 6) continue; // Saturday — never a work day
    if (realDates.has(date)) continue;
    const hours = committedHoursForWeekday(commitment, weekday);
    if (!hours) continue;
    const avgMin = avgMinutesByWeekday.get(weekday);
    const end_hhmm = avgMin ? addMinutesToHHMM(hours.start_hhmm, avgMin) : hours.end_hhmm;
    out.push({ date, start_hhmm: hours.start_hhmm, end_hhmm, from_average: !!avgMin });
  }
  return out;
}

/**
 * Every committed weekday in [windowStart, windowEnd], regardless of whether
 * she already has a punch there. Only used for the toggle's diagnostic —
 * "how many days would completion even cover" — never for materialization
 * itself (gapDatesForEmployee is the one that decides what actually gets
 * written, and it's the one that has to stay conservative).
 */
function eligibleDatesForEmployee(commitment, windowStart, windowEnd) {
  const out = [];
  for (const date of dateRange(windowStart, windowEnd)) {
    const weekday = weekdayOf(date);
    if (weekday === 6) continue;
    if (!committedHoursForWeekday(commitment, weekday)) continue;
    out.push(date);
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
  if (!/^\d{4}-\d{2}$/.test(month)) return { created: 0, results: [] };

  const pmFilter = { month, 'manual.closure_completion': true };
  if (employeeIds) pmFilter.employee_id = { $in: employeeIds };
  if (branchIds) pmFilter.branch_id = { $in: branchIds };
  const flagged = await PayrollMonth.find(pmFilter).select('employee_id').lean();
  if (flagged.length === 0) return { created: 0, results: [] };
  const empIds = flagged.map(f => f.employee_id);

  const [employees, commitments] = await Promise.all([
    Employee.find({ _id: { $in: empIds } }).select('full_name israeli_id branch_id').lean(),
    EmployeeCommitment.find({ employee_id: { $in: empIds } }).lean(),
  ]);
  const commitmentByEmp = new Map(commitments.map(c => [String(c.employee_id), c]));

  const today = todayIsrael();
  const branchWindowCache = new Map(); // branchId → window | null
  const toCreate = [];
  const results = []; // per-employee diagnostic — what the toggle actually reports back
  let skippedNoCommitment = 0;
  let skippedNoWindow = 0;

  for (const emp of employees) {
    const empIdStr = String(emp._id);
    const empty = {
      employee_id: empIdStr, has_commitment: false, has_window: false,
      committed_days_in_window: 0, already_had_punch_days: 0, newly_completed_days: 0,
    };
    const commitment = commitmentByEmp.get(empIdStr);
    if (!commitment) { skippedNoCommitment++; results.push(empty); continue; }
    if (!emp.branch_id) { skippedNoWindow++; results.push({ ...empty, has_commitment: true }); continue; }

    const bId = String(emp.branch_id);
    if (!branchWindowCache.has(bId)) {
      branchWindowCache.set(bId, await closureWindowForBranch(emp.branch_id, month));
    }
    const window = branchWindowCache.get(bId);
    if (!window) { skippedNoWindow++; results.push({ ...empty, has_commitment: true }); continue; }

    const windowEnd = window.end > today ? today : window.end; // never generate ahead of today
    if (window.start > windowEnd) {
      results.push({ ...empty, has_commitment: true, has_window: true });
      continue;
    }

    const from = ilDateTime(window.start, '00:00');
    const to = new Date(ilDateTime(windowEnd, '00:00').getTime() + 36 * 3600 * 1000);
    const existing = await Punch.find({
      employee_id: emp._id,
      timestamp: { $gte: from, $lt: to },
    }).select('timestamp').lean();
    const realDates = new Set(existing.map(p => ISR_DAY(p.timestamp)));

    const avgByWeekday = await averageMinutesByWeekday(emp._id, window.start);
    const gaps = gapDatesForEmployee(commitment, realDates, window.start, windowEnd, avgByWeekday);
    const eligible = eligibleDatesForEmployee(commitment, window.start, windowEnd);
    results.push({
      employee_id: empIdStr, has_commitment: true, has_window: true,
      window_start: window.start, window_end: windowEnd,
      window_from_fallback_policy: !!window.from_fallback_policy,
      committed_days_in_window: eligible.length,
      already_had_punch_days: eligible.length - gaps.length,
      newly_completed_days: gaps.length,
    });
    for (const g of gaps) {
      const inSn = syntheticSn(emp._id, g.date, 0);
      const outSn = syntheticSn(emp._id, g.date, 1);
      const note = g.from_average
        ? 'השלמת שכר אוגוסט — הגן היה סגור (לפי ממוצע שעות ב-3 חודשים אחרונים)'
        : 'השלמת שכר אוגוסט — הגן היה סגור (לפי שעות ההתחייבות — אין מספיק היסטוריית שעות ליום זה)';
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

  if (toCreate.length === 0) {
    return { created: 0, results, skipped_no_commitment: skippedNoCommitment, skipped_no_window: skippedNoWindow };
  }

  try {
    await Punch.insertMany(toCreate, { ordered: false });
  } catch (err) {
    if (err.code !== 11000 && !err.writeErrors) throw err;
  }
  return { created: toCreate.length, results, skipped_no_commitment: skippedNoCommitment, skipped_no_window: skippedNoWindow };
}

module.exports = {
  closureWindowForBranch,
  gapDatesForEmployee,
  eligibleDatesForEmployee,
  committedHoursForWeekday,
  averageMinutesByWeekday,
  addMinutesToHHMM,
  materializeMonth,
};
