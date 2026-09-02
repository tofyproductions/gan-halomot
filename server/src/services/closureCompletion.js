/**
 * "בונוס אוגוסט" (השלמת שכר אוגוסט) — closure-completion punches.
 *
 * Some branches close for the summer before the month is out. Committed staff
 * lose real pay for those days through no fault of theirs — the gan simply
 * wasn't open. The candidate days are FIXED by office policy: August 16–31
 * (services/augustBonus.js). Days 1–15 are ordinary payroll, covered by the
 * standing monthly completion.
 *
 * Since 2026-09: paying is a two-step decision. Flagging
 * PayrollMonth.manual.closure_completion only OPENS the month to the bonus;
 * nothing is paid until the accountant approves specific days
 * (manual.closure_completion_approved_dates — edited in the payroll table's
 * bonus dialog). This service MATERIALIZES exactly the approved committed
 * weekdays that carry no real punch, as ordinary Punch rows (source
 * 'closure_completion') — the same "make it a real row, don't teach payroll a
 * second source of truth" move as services/fixedSchedule.js — and DELETES the
 * rows of days whose approval was revoked, so the punches always mirror the
 * approval list.
 *
 * What happens to those rows downstream differs by salary type, and lives
 * OUTSIDE this file on purpose (this file only decides WHICH days and
 * generates the rows):
 *   - hourly: counted like any other punch — they pay for themselves.
 *   - global (תקן): excluded from hours by payrollCalc.js;
 *     payrollMonth.controller.js prices them as a בונוס carved out of the
 *     monthly completion (augustBonus.applyBonusSplit), so full approval pays
 *     exactly 100% of the agreed salary and nothing is ever paid twice.
 *
 * An approved day is a gift day the gan grants — the controller excludes the
 * window from vacation-day accrual, so it never draws from her balance.
 *
 * Conservative: a date that already carries a REAL punch (היערכות days she
 * clocked) is never touched — the real clock always silently wins.
 *
 * Back-compat: rows flagged before the approval field existed (approved_dates
 * missing entirely) adopt their already-materialized punch dates as the
 * approved list, so nobody's already-paid August silently shrinks.
 */

const { Employee, EmployeeCommitment, Punch, PayrollMonth } = require('../models');
const { ilDateTime, ISR_DAY, todayIsrael } = require('./fixedSchedule');
const {
  augustBonusWindow, candidateDays, committedHoursForWeekday, sanitizeApprovedDates,
} = require('./augustBonus');

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
    const wd = new Date(Date.UTC(...date.split('-').map(Number).map((v, i) => i === 1 ? v - 1 : v))).getUTCDay();
    const cur = sums.get(wd) || { total: 0, count: 0 };
    cur.total += minutes; cur.count += 1;
    sums.set(wd, cur);
  }

  const avg = new Map();
  for (const [wd, { total, count }] of sums) avg.set(wd, total / count);
  return avg;
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

/** All of this employee's punches for `month`, split into the synthetic
 * closure rows (by _id and by date) and the dates that carry any REAL punch. */
async function monthPunchState(employeeId, month) {
  const [y, m] = month.split('-').map(Number);
  const from = ilDateTime(`${month}-01`, '00:00');
  const nextMonth = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
  const to = ilDateTime(nextMonth, '00:00');
  const punches = await Punch.find({
    employee_id: employeeId,
    timestamp: { $gte: from, $lt: to },
  }).select('_id timestamp timestamp_source').lean();
  const closureByDate = new Map(); // date → [punch _id]
  const realDates = new Set();
  for (const p of punches) {
    const date = ISR_DAY(p.timestamp);
    if (p.timestamp_source === 'closure_completion') {
      if (!closureByDate.has(date)) closureByDate.set(date, []);
      closureByDate.get(date).push(p._id);
    } else {
      realDates.add(date);
    }
  }
  return { closureByDate, realDates };
}

/**
 * Sync closure-completion punches to the approval list for every employee
 * flagged for `month`, optionally narrowed to `branchIds` / `employeeIds`.
 * Creates approved days that are missing, deletes days no longer approved.
 * Idempotent — safe to call on every payroll/attendance load.
 */
async function materializeMonth(month, { branchIds = null, employeeIds = null, userId = null } = {}) {
  const window = augustBonusWindow(month);
  if (!window) return { created: 0, deleted: 0, results: [] };

  const pmFilter = { month, 'manual.closure_completion': true };
  if (employeeIds) pmFilter.employee_id = { $in: employeeIds };
  if (branchIds) pmFilter.branch_id = { $in: branchIds };
  const flagged = await PayrollMonth.find(pmFilter)
    .select('employee_id manual.closure_completion_approved_dates').lean();
  if (flagged.length === 0) return { created: 0, deleted: 0, results: [] };
  const approvalsByEmp = new Map(flagged.map(f => [
    String(f.employee_id),
    f.manual ? f.manual.closure_completion_approved_dates : undefined,
  ]));
  const empIds = flagged.map(f => f.employee_id);

  const [employees, commitments] = await Promise.all([
    Employee.find({ _id: { $in: empIds } }).select('full_name israeli_id branch_id').lean(),
    EmployeeCommitment.find({ employee_id: { $in: empIds } }).lean(),
  ]);
  const commitmentByEmp = new Map(commitments.map(c => [String(c.employee_id), c]));

  const today = todayIsrael();
  const windowEnd = window.end > today ? today : window.end; // never generate ahead of today
  const toCreate = [];
  const toDeleteIds = [];
  const results = []; // per-employee diagnostic — what the toggle/dialog reports back

  for (const emp of employees) {
    const empIdStr = String(emp._id);
    const commitment = commitmentByEmp.get(empIdStr);
    const { closureByDate, realDates } = await monthPunchState(emp._id, month);

    // Back-compat: a row flagged before approvals existed adopts its
    // already-materialized days as the approved list — once, persisted.
    let approvedDates = approvalsByEmp.get(empIdStr);
    if (approvedDates == null) {
      approvedDates = [...closureByDate.keys()].sort();
      await PayrollMonth.updateOne(
        { employee_id: emp._id, month },
        { $set: { 'manual.closure_completion_approved_dates': approvedDates } },
      );
    }
    const approvedSet = new Set(sanitizeApprovedDates(approvedDates));

    // Delete: closure rows whose approval was revoked, or that collide with a
    // real punch that has since arrived (the real clock wins).
    let deletedDays = 0;
    for (const [date, ids] of closureByDate) {
      if (!approvedSet.has(date) || realDates.has(date)) {
        toDeleteIds.push(...ids);
        deletedDays++;
        closureByDate.delete(date);
      }
    }

    const candidates = commitment ? candidateDays(commitment, month) : [];
    const gaps = candidates.filter(c =>
      c.date <= windowEnd
      && approvedSet.has(c.date)
      && !realDates.has(c.date)
      && !closureByDate.has(c.date));

    const avgByWeekday = commitment && gaps.length
      ? await averageMinutesByWeekday(emp._id, window.start)
      : new Map();

    results.push({
      employee_id: empIdStr,
      has_commitment: !!commitment,
      window_start: window.start,
      window_end: windowEnd,
      candidate_days: candidates.length,
      worked_days_in_window: candidates.filter(c => realDates.has(c.date)).length,
      approved_days: approvedSet.size,
      newly_completed_days: gaps.length,
      removed_days: deletedDays,
    });

    for (const g of gaps) {
      const avgMin = avgByWeekday.get(g.weekday);
      const end_hhmm = avgMin ? addMinutesToHHMM(g.start_hhmm, avgMin) : g.end_hhmm;
      const note = avgMin
        ? 'בונוס אוגוסט — יום חופשת קיץ בתשלום (לפי ממוצע שעות ב-3 חודשים אחרונים)'
        : 'בונוס אוגוסט — יום חופשת קיץ בתשלום (לפי שעות ההתחייבות — אין מספיק היסטוריית שעות ליום זה)';
      const common = {
        branch_id: emp.branch_id,
        employee_id: emp._id,
        israeli_id: emp.israeli_id || '',
        timestamp_source: 'closure_completion',
        received_at: new Date(),
        agent_version: 'closure-completion',
        manual_note: note,
        created_by: userId,
        approval_status: 'approved',
        approval_decided_by: userId,
        approval_decided_at: new Date(),
      };
      toCreate.push(
        { ...common, device_user_sn: syntheticSn(emp._id, g.date, 0), timestamp: ilDateTime(g.date, g.start_hhmm), state: 0 },
        { ...common, device_user_sn: syntheticSn(emp._id, g.date, 1), timestamp: ilDateTime(g.date, end_hhmm), state: 1 },
      );
    }
  }

  if (toDeleteIds.length) {
    await Punch.deleteMany({ _id: { $in: toDeleteIds }, timestamp_source: 'closure_completion' });
  }
  if (toCreate.length) {
    try {
      await Punch.insertMany(toCreate, { ordered: false });
    } catch (err) {
      if (err.code !== 11000 && !err.writeErrors) throw err;
    }
  }
  return { created: toCreate.length, deleted: toDeleteIds.length, results };
}

/**
 * Turning the month's flag OFF: every synthetic closure row of this employee's
 * month goes away, so nothing keeps being priced off a decision that was
 * reversed. The approval list is kept — flipping back on restores the same
 * choices.
 */
async function removeEmployeeMonth(employeeId, month) {
  const { closureByDate } = await monthPunchState(employeeId, month);
  const ids = [...closureByDate.values()].flat();
  if (ids.length === 0) return { deleted: 0 };
  await Punch.deleteMany({ _id: { $in: ids }, timestamp_source: 'closure_completion' });
  return { deleted: ids.length };
}

module.exports = {
  committedHoursForWeekday, // re-exported from augustBonus for existing callers
  averageMinutesByWeekday,
  addMinutesToHHMM,
  materializeMonth,
  removeEmployeeMonth,
  monthPunchState,
};
