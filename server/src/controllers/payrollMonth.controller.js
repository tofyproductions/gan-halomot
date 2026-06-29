/**
 * Controller for the monthly payroll table — the one with per-amuta column
 * groups and manual fields (sick, vacation, gift card, etc.). Backed by the
 * `PayrollMonth` collection plus on-the-fly recomputation via payrollCalc.
 */
const {
  PayrollMonth, PayrollPresetOption, PayrollCustomColumn, SalaryAdjustment,
  Employee, Branch, Amuta, Punch, EmployeeCommitment, Holiday,
  PayrollChangeRequest, EmployeeRequest, EmployeeDocument, Setting,
} = require('../models');
const { calculateMonthlySalary } = require('../services/payrollCalc');
const { analyzeCommitment, datesInMonth, workingWeekdays } = require('../services/commitmentAnalysis');
const { computeHolidayPay, getHolidaysInMonth } = require('../services/israeliHolidays');
const { parseCibusReport } = require('../services/payslipAudit/cibusParser');
const { computeSickPay, availableBalance, accruedBalance } = require('../services/sickPay');
const { dispatchEmail } = require('../services/email.service');

// Absence categories that REDUCE pay (the rest — sick/vacation/reserve — are paid).
const DEDUCTIBLE_ABSENCE = new Set(['unpaid', 'other']);

// Expand a [from,to] range (YYYY-MM-DD strings or Date objects) into the set of
// YYYY-MM-DD that fall within the given month — used to mark holiday / approved
// leave days so they are NOT counted as absences.
function addRangeToSet(set, from, to, monthYM) {
  if (!from) return;
  const toYmd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  const a = toYmd(from);
  const b = to ? toYmd(to) : a;
  for (const { ymd } of datesInMonth(monthYM)) {
    if (ymd >= a && ymd <= b) set.add(ymd);
  }
}

function parseMonthRange(monthYM) {
  const [y, m] = monthYM.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - 3 * 3600 * 1000);
  const to   = new Date(Date.UTC(y, m,     2, 0, 0, 0));
  return { from, to };
}

/**
 * Count an employee's sick WORK-days in [from,to] (YYYY-MM-DD), excluding
 * Saturday and the employee's day off (work_days). When monthYM is given, only
 * days inside that calendar month count. Mirrors the leave-day counting in
 * employeeRequests.controller so paid days reconcile with manual.sick_days.
 */
function countSickWorkDays(fromYmd, toYmd, workDays, monthYM = null) {
  const start = new Date(`${fromYmd}T12:00:00Z`);
  const end = new Date(`${toYmd || fromYmd}T12:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const allowed = Array.isArray(workDays) && workDays.length ? new Set(workDays.map(Number)) : null;
  let count = 0;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd === 6) continue;                    // Saturday always off
    if (allowed && !allowed.has(wd)) continue; // employee's day off
    if (monthYM && d.toISOString().slice(0, 7) !== monthYM) continue;
    count++;
  }
  return count;
}

/**
 * Partial-day absence: committed days the employee DID work but fell short of
 * their committed hours by MORE than the grace (1h). Lateness / leaving slightly
 * early (≤ grace) is ignored (salary completed in full). Each qualifying day's
 * FULL shortfall is a candidate; the accountant approves per day, and approved
 * hours are deducted proportionally. Whole no-show days are NOT included here —
 * those are handled by the separate whole-day absence column.
 *
 * @param commitment  EmployeeCommitment doc (days[] with start/end per weekday)
 * @param workedDays  breakdown.days: [{ date, minutes }]
 * @param excludeSet  Set of YMD to skip (holidays / approved leave)
 * @returns [{ date, committed_h, worked_h, shortfall_h }]
 */
function partialAbsenceCandidates(commitment, workedDays, excludeSet, graceH = 1) {
  if (!commitment || !Array.isArray(commitment.days) || commitment.days.length === 0) return [];
  const hhmm = (s) => {
    if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return 0;
    const [h, m] = s.split(':').map(Number);
    return (h || 0) + (m || 0) / 60;
  };
  const byWeekday = new Map();
  for (const d of commitment.days) byWeekday.set(Number(d.day), d);
  const altDay = (commitment.is_alternating_off && commitment.alternating_day != null)
    ? Number(commitment.alternating_day) : null;
  const out = [];
  for (const wd of (workedDays || [])) {
    const date = wd.date;
    if (wd.incomplete) continue;                // missing clock-out → minutes unreliable, don't deduct
    const workedH = (Number(wd.minutes) || 0) / 60;
    if (workedH <= 0) continue;                 // no-show is the other column
    if (excludeSet && excludeSet.has(date)) continue;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 6) continue;                // Saturday
    if (altDay != null && weekday === altDay) continue; // alternating week — skip (ambiguous)
    const cd = byWeekday.get(weekday);
    if (!cd || cd.is_off) continue;             // not a committed day
    const committedH = Math.max(0, hhmm(cd.end_hhmm) - hhmm(cd.start_hhmm));
    if (committedH <= 0) continue;
    const shortfall = committedH - workedH;
    if (shortfall > graceH) {
      out.push({
        date,
        committed_h: Math.round(committedH * 100) / 100,
        worked_h: Math.round(workedH * 100) / 100,
        shortfall_h: Math.round(shortfall * 100) / 100,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Mirror of partialAbsenceCandidates for the OTHER direction: committed days the
 * employee worked MORE than their committed hours by > grace. Returns the extra
 * hours per day so over-commitment work is surfaced in the absence column.
 * @returns [{ date, committed_h, worked_h, over_h }]
 */
function committedDayOverages(commitment, workedDays, excludeSet, graceH = 1) {
  if (!commitment || !Array.isArray(commitment.days) || commitment.days.length === 0) return [];
  const hhmm = (s) => {
    if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return 0;
    const [h, m] = s.split(':').map(Number);
    return (h || 0) + (m || 0) / 60;
  };
  const byWeekday = new Map();
  for (const d of commitment.days) byWeekday.set(Number(d.day), d);
  const altDay = (commitment.is_alternating_off && commitment.alternating_day != null)
    ? Number(commitment.alternating_day) : null;
  const out = [];
  for (const wd of (workedDays || [])) {
    if (wd.incomplete) continue;
    const workedH = (Number(wd.minutes) || 0) / 60;
    if (workedH <= 0) continue;
    if (excludeSet && excludeSet.has(wd.date)) continue;
    const weekday = new Date(`${wd.date}T12:00:00Z`).getUTCDay();
    if (weekday === 6) continue;
    if (altDay != null && weekday === altDay) continue;
    const cd = byWeekday.get(weekday);
    if (!cd || cd.is_off) continue;            // off-day work is handled separately
    const committedH = Math.max(0, hhmm(cd.end_hhmm) - hhmm(cd.start_hhmm));
    if (committedH <= 0) continue;
    const over = workedH - committedH;
    if (over > graceH) {
      out.push({
        date: wd.date,
        committed_h: Math.round(committedH * 100) / 100,
        worked_h: Math.round(workedH * 100) / 100,
        over_h: Math.round(over * 100) / 100,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Compute the number of "vacation days" an employee accrues this month from
 * kindergarten holidays (Holiday docs). Every weekday inside a holiday range
 * counts as one vacation day, EXCEPT:
 *   - Saturdays (never count — not a work day anyway)
 *   - The employee's weekly off-day (per EmployeeCommitment)
 *   - The last day of a half-day holiday counts as 0.5
 *
 * Returns { total, details: [{date, name, value}] } so the UI can show why.
 */
function computeKindergartenVacationDays(holidays, monthYM, commitment, statutoryDates) {
  // Only days she was supposed to WORK count as paid vacation. With a commitment
  // that means a required weekday; a closure on her off-day / a non-work weekday
  // gives no vacation pay.
  const requiredWeekdays = new Set();
  const hasCommitment = !!(commitment && Array.isArray(commitment.days) && commitment.days.length);
  if (hasCommitment) {
    for (const d of commitment.days) if (!d.is_off) requiredWeekdays.add(d.day);
  }
  const statutory = statutoryDates instanceof Set ? statutoryDates : new Set(statutoryDates || []);
  const result = { total: 0, details: [] };
  for (const h of holidays) {
    const start = new Date(h.start_date);
    const end = new Date(h.end_date);
    const endYmd = end.toISOString().slice(0, 10);
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const ymd = d.toISOString().slice(0, 10);
      if (!ymd.startsWith(monthYM)) continue;
      const wd = d.getUTCDay();
      if (wd === 6) continue;
      // Only a day she was supposed to work counts (when a commitment exists).
      if (hasCommitment && !requiredWeekdays.has(wd)) continue;
      // Statutory-holiday days are paid via דמי חגים, not vacation — skip them.
      if (statutory.has(ymd)) continue;
      const isLastDay = ymd === endYmd;
      const value = (h.is_half_day && isLastDay) ? 0.5 : 1;
      result.total += value;
      result.details.push({ date: ymd, name: h.name, value });
    }
  }
  result.total = Math.round(result.total * 10) / 10;
  return result;
}

/**
 * GET /api/payroll-month?month=YYYY-MM&branch=<id>&amuta=<id>
 *
 * Filters:
 *   - branch=<id>            single-branch view
 *   - amuta=<id>             all branches belonging to that amuta (merged)
 *   - (neither)              all branches in the org
 *
 * Returns: { rows: [...], amutot: [...], branches: [...], totals: {...} }
 * Each row contains the auto-calculated breakdown AND the persisted manual fields.
 */
async function getMonth(req, res, next) {
  try {
    const { month, branch, amuta } = req.query;
    if (!month) return res.status(400).json({ error: 'month=YYYY-MM is required' });

    // Determine which branches are in scope. Sentinel values that mean
    // "no filter": empty string, the literal 'all', or 'undefined'.
    const branchFilter = {};
    const isAllBranches = !branch || branch === 'all' || branch === 'undefined';
    if (!isAllBranches) {
      branchFilter._id = branch;
    } else if (amuta) {
      branchFilter.amuta_id = amuta;
    }
    // Enforce per-user branch scope: non-admins are restricted to the
    // branches they manage. system_admin / accountant see everything.
    const role = req.user?.role;
    // Bank details are sensitive — only accounting / system admin may see them.
    const canSeeBank = role === 'system_admin' || role === 'accountant';
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length > 0 ? managed : fallback;
      if (branchFilter._id && !allowed.includes(String(branchFilter._id))) {
        // User asked for a branch they don't manage — return empty
        return res.json({
          rows: [], amutot: [], branches: [], branches_in_view: [], custom_columns: [], totals: {},
        });
      }
      if (!branchFilter._id) {
        branchFilter._id = { $in: allowed };
      }
    }
    const branches = await Branch.find(branchFilter).select('_id name amuta_id').lean();
    if (branches.length === 0) {
      return res.json({
        rows: [], amutot: [], branches: [], branches_in_view: [], custom_columns: [], totals: {},
      });
    }
    const branchIds = branches.map(b => b._id);

    // Date window for the month (used for punches + inactive-relevance).
    const { from, to } = parseMonthRange(month);

    // Active employees are always shown. Inactive employees are shown ONLY if
    // they had activity this month (punches or a payroll record), so a just-
    // deactivated employee stays visible with their reason — without listing
    // everyone who ever left.
    const activeEmps = await Employee.find({ branch_id: { $in: branchIds }, is_active: true })
      .populate('amuta_distribution.amuta_id', 'name short_name').sort({ full_name: 1 }).lean();
    const punchEmpIds = await Punch.distinct('employee_id', { timestamp: { $gte: from, $lt: to }, ignored: { $ne: true } });
    const pmEmpIds = await PayrollMonth.distinct('employee_id', { month });
    // Orphan punches / payroll rows can carry a null employee_id; drop anything
    // that isn't a valid ObjectId so the $in below never receives the string
    // "null" (which would throw a CastError and fail the whole table load).
    const relevantInactive = [...new Set(
      [...punchEmpIds, ...pmEmpIds]
        .filter(id => id && /^[0-9a-f]{24}$/i.test(String(id)))
        .map(String),
    )];
    // Show an inactive employee if they were DEACTIVATED IN THE TABLE (they carry
    // an inactive_reason) — they stay visible every following month until they're
    // reactivated or removed — OR if they simply had activity this month. Old
    // soft-deleted staff (no reason, no activity) stay hidden.
    const inactiveEmps = await Employee.find({
      branch_id: { $in: branchIds }, is_active: false,
      $or: [
        { inactive_reason: { $nin: [null, ''] } },
        ...(relevantInactive.length ? [{ _id: { $in: relevantInactive } }] : []),
      ],
    }).populate('amuta_distribution.amuta_id', 'name short_name').sort({ full_name: 1 }).lean();
    const employees = [...activeEmps, ...inactiveEmps];

    // Pull amutot to render column groups
    const amutot = await Amuta.find({ is_active: true }).sort({ name: 1 }).lean();

    // Pull custom columns: both month-specific and "*" (all months)
    const customColumns = await PayrollCustomColumn.find({
      is_active: true,
      $or: [{ month }, { month: '*' }],
    }).sort({ position: 1, created_at: 1 }).lean();

    // Build branch→amuta map for payrollCalc
    const allBranches = await Branch.find({}).select('_id amuta_id').lean();
    const branchAmutaMap = new Map(
      allBranches
        .filter(b => b.amuta_id)
        .map(b => [String(b._id), String(b.amuta_id)])
    );

    // Pull punches for all in-scope employees
    const punches = await Punch.find({
      employee_id: { $in: employees.map(e => e._id) },
      timestamp: { $gte: from, $lt: to },
      ignored: { $ne: true },
    }).sort({ timestamp: 1 }).lean();

    const punchesByEmp = new Map();
    for (const p of punches) {
      const k = String(p.employee_id);
      if (!punchesByEmp.has(k)) punchesByEmp.set(k, []);
      punchesByEmp.get(k).push(p);
    }

    // Pull any existing PayrollMonth rows for these employees
    const existing = await PayrollMonth.find({
      employee_id: { $in: employees.map(e => e._id) },
      month,
    }).populate('manual.advance_deduction_preset_id').lean();
    const existingByEmp = new Map(existing.map(r => [String(r.employee_id), r]));

    // Salary adjustments — managers' ad-hoc credits/debits/hour corrections
    const adjustments = await SalaryAdjustment.find({
      employee_id: { $in: employees.map(e => e._id) },
      month,
      status: { $ne: 'rejected' },
    }).populate('created_by', 'full_name').sort({ created_at: -1 }).lean();

    // Commitments (contracted weekly schedules) — for absence detection
    const commitments = await EmployeeCommitment.find({
      employee_id: { $in: employees.map(e => e._id) },
    }).lean();
    const commitmentByEmp = new Map(commitments.map(c => [String(c.employee_id), c]));

    // Kindergarten holidays (Holiday model) for every in-scope branch that
    // overlap with the requested month. Drives the auto vacation-days suggestion.
    const [yy, mm] = month.split('-').map(Number);
    const monthStart = new Date(Date.UTC(yy, mm - 1, 1));
    const monthEnd = new Date(Date.UTC(yy, mm, 0, 23, 59, 59));
    // Statutory Israeli-holiday dates this month — paid via דמי חגים (not vacation).
    const statutoryHolidayDates = new Set(getHolidaysInMonth(month).map(h => h.date));
    const kindergartenHolidays = await Holiday.find({
      branch_id: { $in: branchIds },
      start_date: { $lte: monthEnd },
      end_date: { $gte: monthStart },
    }).lean();
    const holidaysByBranch = new Map();
    for (const h of kindergartenHolidays) {
      const k = String(h.branch_id);
      if (!holidaysByBranch.has(k)) holidaysByBranch.set(k, []);
      holidaysByBranch.get(k).push(h);
    }

    // Approved leave (vacation/sick) overlapping the month — those days are not
    // absences. (date fields are YYYY-MM-DD strings, so range queries are lexical.)
    const leaveRequests = await EmployeeRequest.find({
      employee_id: { $in: employees.map(e => e._id) },
      status: 'approved',
      from_date: { $lte: `${month}-31` },
      $or: [{ to_date: { $gte: `${month}-01` } }, { to_date: { $in: [null, ''] } }],
    }).lean();
    const leaveByEmp = new Map();
    for (const r of leaveRequests) {
      const k = String(r.employee_id);
      if (!leaveByEmp.has(k)) leaveByEmp.set(k, []);
      leaveByEmp.get(k).push(r);
    }

    // Approved sick certificates — this month AND history (for sick-pay brackets
    // and the accrued-balance ceiling). Self-filed requests key on user_id, so
    // match by employee_id OR user_id and resolve back to the employee.
    const empUserIds = employees.filter(e => e.user_id).map(e => e.user_id);
    const userIdToEmpId = new Map(
      employees.filter(e => e.user_id).map(e => [String(e.user_id), String(e._id)]),
    );
    const sickRequests = await EmployeeRequest.find({
      type: 'sick',
      status: 'approved',
      from_date: { $lte: `${month}-31` },
      $or: [
        { employee_id: { $in: employees.map(e => e._id) } },
        ...(empUserIds.length ? [{ user_id: { $in: empUserIds } }] : []),
      ],
    }).lean();
    const sickReqByEmp = new Map();
    for (const r of sickRequests) {
      const eid = r.employee_id ? String(r.employee_id) : userIdToEmpId.get(String(r.user_id));
      if (!eid) continue;
      if (!sickReqByEmp.has(eid)) sickReqByEmp.set(eid, []);
      sickReqByEmp.get(eid).push(r);
    }
    const adjByEmp = new Map();
    for (const adj of adjustments) {
      const k = String(adj.employee_id);
      if (!adjByEmp.has(k)) adjByEmp.set(k, []);
      adjByEmp.get(k).push({
        id: String(adj._id),
        type: adj.type,
        amount: adj.amount,
        hours: adj.hours,
        reason: adj.reason,
        status: adj.status,
        created_by_name: adj.created_by?.full_name || '',
        created_at: adj.created_at,
      });
    }

    // Need ALL branches (not just in-scope) so cross-branch hours can still
    // be shown in the table — an employee from branch A may have punched at B.
    const allBranchesData = await Branch.find({}).select('_id name amuta_id').sort({ name: 1 }).lean();
    const branchNameById = new Map(allBranchesData.map(b => [String(b._id), b.name]));

    const rows = employees.map(emp => {
      const empPunches = punchesByEmp.get(String(emp._id)) || [];
      const existingRow = existingByEmp.get(String(emp._id));
      const existingManual = existingRow?.manual || {};
      const row = existingRow;
      const manual = row?.manual || {};
      // Only countable (approved/auto) punches — same filter calculateMonthlySalary uses.
      const countablePunches = empPunches.filter(p => {
        const s = p.approval_status || 'auto';
        return s === 'auto' || s === 'approved';
      });

      // Days the gan was closed (holidays) or she had approved leave — never absences.
      // Dates the gan was closed (holidays) and dates of approved leave — used to
      // auto-classify WHY a committed day was missed.
      const holidayDates = new Set();
      for (const h of (holidaysByBranch.get(String(emp.branch_id)) || [])) {
        addRangeToSet(holidayDates, h.start_date, h.end_date, month);
      }
      const leaveDates = new Set();
      for (const r of (leaveByEmp.get(String(emp._id)) || [])) {
        addRangeToSet(leaveDates, r.from_date, r.to_date, month);
      }

      // All committed days she missed (NOT excluded) — each is annotated with a
      // source so the UI can show holiday/leave (justified) vs unknown (the
      // manager must mark the reason).
      const commitmentInfo = analyzeCommitment(
        commitmentByEmp.get(String(emp._id)), countablePunches, month,
      );

      // Absence only applies to תקן (global) employees — an hourly employee is
      // paid solely for the hours she punched, so "absence" is meaningless.
      const isTeken = emp.salary_type === 'global';
      const committedDays = commitmentInfo.committed_dates.length;
      const tekenSalary = Number(emp.amuta_distribution?.[0]?.global_salary) || 0;
      const dailyRate = (isTeken && committedDays > 0 && tekenSalary > 0)
        ? Math.round((tekenSalary / committedDays) * 100) / 100 : 0;
      const absenceEntries = isTeken && Array.isArray(existingManual.absence_entries) ? existingManual.absence_entries : [];
      const entryByDate = new Map(absenceEntries.map(e => [e.date, e]));
      // A committed day missed because the gan was closed (holiday) or for
      // approved leave is NOT an absence — it's vacation/leave, handled in those
      // columns. Only truly-unexplained missed days are absences.
      const absenceDays = isTeken
        ? commitmentInfo.absent_dates
            .filter(d => !holidayDates.has(d) && !leaveDates.has(d))
            .map(d => ({ date: d, source: 'unknown' }))
        : [];
      // Deduct only days the manager+accounting marked with a deductible reason.
      const deductibleDays = absenceDays.filter(a => {
        const e = entryByDate.get(a.date);
        return e && DEDUCTIBLE_ABSENCE.has(e.category || 'unpaid')
          && e.manager_approved === true && e.accounting_approved === true;
      }).length;
      const unknownCount = absenceDays.length;
      const justifiedCount = 0;
      const absenceDeduction = Math.round(deductibleDays * dailyRate * 100) / 100;

      // RETIRED — the old beyond-commitment "תוספת שכר" supplement is disabled.
      // Extra hours above commitment are now paid via the partial-absence /
      // extra-hours mechanism (partial_extra_entries, flat × hourly value).
      const payExcessSupplement = false;
      let breakdown = calculateMonthlySalary(emp, empPunches, month, {
        branchAmutaMap,
        include_salary_completion: existingManual.include_salary_completion !== false,
        pay_excess_supplement: payExcessSupplement,
        absence_deduction: absenceDeduction,
        // Teken hourly value is based on the employee's committed work hours
        // (their schedule), not a separate required_hours field that can drift.
        required_hours_override: commitmentInfo.has_commitment ? commitmentInfo.committed_hours : null,
        // The שכר תקן already includes the premium for OT built into the schedule,
        // so the BASE hourly value uses the OT-weighted committed hours — working
        // exactly the committed schedule then yields exactly the salary (no phantom
        // excess). Only OT beyond the commitment surfaces as a supplement.
        committed_weighted_override: commitmentInfo.has_commitment ? commitmentInfo.committed_weighted_hours : null,
        // Month-specific override wins for this month; otherwise the standing
        // per-employee travel amount (carries forward every month) is used.
        travel_override: (existingManual.travel_override != null && existingManual.travel_override !== '')
          ? existingManual.travel_override
          : (emp.travel_override ?? null),
      });
      // Closed months are frozen: serve the snapshot captured at finalize so a
      // later rate/logic change never shifts an already-paid month.
      if (existingRow?.status === 'finalized' && existingRow.auto_snapshot) {
        breakdown = existingRow.auto_snapshot;
      }

      // Holiday pay (דמי חגים) — auto-computed only for hourly employees
      // who pass tenure + guard-day rules. Manager can still override via
      // manual.holiday_pay; we expose both so the UI can show the breakdown.
      const hourlyRate = emp.amuta_distribution?.[0]?.hourly_rate || 0;
      const avgDailyHours = (breakdown.hours.days_worked > 0)
        ? (breakdown.hours.total / breakdown.hours.days_worked)
        : 8;
      const holidayPayInfo = computeHolidayPay({
        employee: emp,
        monthYM: month,
        punches: countablePunches,
        commitment: commitmentByEmp.get(String(emp._id)),
        hourlyRate,
        avgDailyHours,
        ganClosedDates: holidayDates, // gan-closure days don't fail the guard-day rule
      });
      // Kindergarten closures → vacation days — EXCLUDING statutory-holiday days
      // (those are paid via דמי חגים, not vacation).
      const kgHolidays = holidaysByBranch.get(String(emp.branch_id)) || [];
      const vacationAutoInfo = computeKindergartenVacationDays(
        kgHolidays, month, commitmentByEmp.get(String(emp._id)), statutoryHolidayDates,
      );
      const empAdjustments = adjByEmp.get(String(emp._id)) || [];
      // Aggregate adjustments
      const adjTotals = empAdjustments.reduce((acc, a) => {
        if (a.status !== 'approved') return acc;
        if (a.type === 'money_add' || a.type === 'purchase_reimburse' || a.type === 'travel_add') acc.money_add += Number(a.amount) || 0;
        else if (a.type === 'money_deduct' || a.type === 'advance_request' || a.type === 'loan_request') acc.money_deduct += Math.abs(Number(a.amount) || 0);
        else if (a.type === 'hours_add' || a.type === 'hour_correction') acc.hours_delta += Number(a.hours) || 0;
        else if (a.type === 'hours_deduct') acc.hours_delta -= Math.abs(Number(a.hours) || 0);
        else if (a.type === 'other') acc.money_add += Number(a.amount) || 0;
        return acc;
      }, { money_add: 0, money_deduct: 0, hours_delta: 0 });

      // Personal per-branch hourly bonus (individually agreed, e.g. ליאל +3₪/hr
      // at Herzliya): bonus = rate × hours worked at that branch. Auto-computed,
      // shown in the dedicated bonus column, and ADDED to the estimated total.
      const bonusLines = [];
      let bonusAuto = 0;
      if (emp.salary_type === 'hourly' && Array.isArray(emp.hourly_bonuses) && emp.hourly_bonuses.length) {
        const ruleByBranch = new Map(emp.hourly_bonuses.map(b => [String(b.branch_id?._id || b.branch_id), b]));
        for (const [bid, bk] of Object.entries(breakdown.per_branch || {})) {
          const rule = ruleByBranch.get(String(bid));
          const rate = rule ? (Number(rule.rate) || 0) : 0;
          const hrs = (bk.regular_hours || 0) + (bk.ot_125_hours || 0) + (bk.ot_150_hours || 0);
          if (rate > 0 && hrs > 0) {
            const roundedHrs = Math.round(hrs * 10) / 10;
            const amount = Math.round(rate * hrs);
            bonusLines.push({ branch_name: branchNameById.get(String(bid)) || '', hours: roundedHrs, rate, amount, reason: rule.reason || '' });
            bonusAuto += amount;
          }
        }
      }
      const bonusAutoNote = bonusLines
        .map(l => `${l.reason || ('בונוס ' + l.branch_name)}: ${l.hours}ש׳ × ₪${l.rate} = ₪${l.amount}`)
        .join(' · ');
      const mBonus = manual.bonus || {};
      const bonusDisabled = !!mBonus.disabled;
      const bonusEffective = bonusDisabled
        ? 0
        : (mBonus.override_amount != null ? Number(mBonus.override_amount) : bonusAuto);
      const bonusNote = mBonus.note || bonusAutoNote;
      // Fold the effective bonus into the estimated total so the salary reflects it.
      if (bonusEffective) breakdown.estimated_total = (breakdown.estimated_total || 0) + bonusEffective;

      // Fold holiday pay (דמי חגים) into the total — manager override if set,
      // otherwise the auto-eligible amount (hourly employees only). Was computed
      // and displayed but never actually added to the salary.
      const holidayPayEffective = (Number(manual.holiday_pay) > 0)
        ? Number(manual.holiday_pay)
        : (holidayPayInfo.total_pay || 0);
      if (holidayPayEffective) breakdown.estimated_total = (breakdown.estimated_total || 0) + holidayPayEffective;

      // Vacation: effective days = manual override, else auto from the gan's
      // holiday calendar. An HOURLY employee is PAID for vacation days she used
      // (against her balance); a תקן employee's salary already covers them, so
      // no extra pay — only the balance is drawn down.
      const vacEffDays = (Number(manual.vacation_days) > 0)
        ? Number(manual.vacation_days)
        : (vacationAutoInfo.total || 0);
      const vacationPay = (!isTeken && vacEffDays > 0)
        ? Math.round(vacEffDays * (Number(hourlyRate) || 0) * (Number(avgDailyHours) || 8) * 100) / 100
        : 0;
      if (vacationPay) breakdown.estimated_total = (breakdown.estimated_total || 0) + vacationPay;

      // --- Sick pay (דמי מחלה) --------------------------------------------
      // Each approved certificate is its OWN spell ("אין רצף") — bracketed per
      // חוק דמי מחלה (day 1 = 0%, days 2-3 = 50%, day 4+ = 100%), unless the
      // employee's policy is 'full' or a certificate is flagged pay_from_first_day.
      // Daily value = the employee's daily wage (overridable). Paid days are
      // capped by the accrued sick-day balance (1.5/month, max 90, minus used).
      const sickDailyValue = (emp.sick_daily_value_override != null && emp.sick_daily_value_override !== '')
        ? Number(emp.sick_daily_value_override)
        : (isTeken
            ? (dailyRate > 0 ? dailyRate : (tekenSalary > 0 ? Math.round((tekenSalary / 22) * 100) / 100 : 0))
            : Math.round((Number(hourlyRate) || 0) * (Number(avgDailyHours) || 8) * 100) / 100);
      // Count sick days by the employee's REAL working days (commitment schedule),
      // falling back to work_days — so a day she works (e.g. Friday) isn't dropped.
      const sickWorkdays = workingWeekdays(commitmentByEmp.get(String(emp._id)), emp.work_days);
      const empSickReqs = sickReqByEmp.get(String(emp._id)) || [];
      const sickCertsThisMonth = empSickReqs
        .filter(r => String(r.from_date).slice(0, 7) === month)
        .sort((a, b) => String(a.from_date).localeCompare(String(b.from_date)))
        .map(r => ({
          id: String(r._id),
          from_date: r.from_date,
          to_date: r.to_date || r.from_date,
          work_days: countSickWorkDays(r.from_date, r.to_date || r.from_date, sickWorkdays, month),
          pay_from_first_day: !!r.pay_from_first_day,
        }));
      // Sick work-days consumed in months strictly before this one — drawn down
      // from the accrued balance before this month's certificates.
      const sickUsedBefore = empSickReqs
        .filter(r => String(r.from_date).slice(0, 7) < month)
        .reduce((s, r) => s + countSickWorkDays(r.from_date, r.to_date || r.from_date, sickWorkdays, null), 0);
      // Effective opening for the balance ceiling: an explicit opening wins;
      // otherwise accrue 1.5/month from the hire date (start_date). With neither,
      // leave the balance UNCAPPED (null) so sick pay isn't wrongly zeroed for
      // employees whose balance hasn't been configured yet.
      const sickOpening = (emp.sick_balance_opening && emp.sick_balance_opening.as_of_month)
        ? emp.sick_balance_opening
        : (emp.start_date ? { days: 0, as_of_month: new Date(emp.start_date).toISOString().slice(0, 7) } : null);
      const sickAccrued = sickOpening ? accruedBalance(sickOpening, month) : null;
      const sickAvail = sickOpening ? availableBalance(sickOpening, month, sickUsedBefore) : null; // null = uncapped
      const sickCalc = computeSickPay(sickCertsThisMonth, {
        dailyValue: sickDailyValue,
        balanceAvailable: sickAvail, // null → uncapped (computeSickPay treats as Infinity)
        policyFull: emp.sick_pay_policy === 'full',
      });
      const sickPay = sickCalc.total_amount;
      if (sickPay) breakdown.estimated_total = (breakdown.estimated_total || 0) + sickPay;

      // --- Partial-day absence (היעדרות שעות) ------------------------------
      // Days the employee worked but fell > 1h short of their committed hours.
      // By default every shortfall is deducted; the accountant can mark a day as
      // EXCUSED (justified, optional reason) so it is NOT deducted. Unexcused
      // hours are deducted proportionally at the committed hourly value. The
      // deduction is also capped at the net monthly deficit so hours made up on
      // other days aren't charged. תקן (global) only.
      const paHasCommitment = !!commitmentInfo.has_commitment;
      const paExcl = new Set([...holidayDates, ...leaveDates]);
      const paCandidatesRaw = isTeken
        ? partialAbsenceCandidates(commitmentByEmp.get(String(emp._id)), breakdown.days || [], paExcl, 1)
        : [];
      const paEntries = Array.isArray(existingManual.partial_absence_entries) ? existingManual.partial_absence_entries : [];
      const paExcusedDates = new Set(paEntries.filter(e => e.excused).map(e => e.date));
      const paReasonByDate = new Map(paEntries.map(e => [e.date, e.reason || '']));
      const paHourlyValue = (isTeken && tekenSalary > 0 && commitmentInfo.committed_hours > 0)
        ? Math.round((tekenSalary / commitmentInfo.committed_hours) * 100) / 100 : 0;
      const paCandidates = paCandidatesRaw.map(c => ({
        ...c, excused: paExcusedDates.has(c.date), reason: paReasonByDate.get(c.date) || '',
      }));
      const paTotalShortfall = Math.round(paCandidates.reduce((s, c) => s + c.shortfall_h, 0) * 100) / 100;
      // Unexcused hours = what gets deducted (before the made-up cap).
      const paDeductGross = Math.round(paCandidates.filter(c => !c.excused).reduce((s, c) => s + c.shortfall_h, 0) * 100) / 100;
      // Monthly committed vs actually worked → surplus (overtime beyond commitment)
      // and net deficit (cap so made-up hours aren't deducted).
      const paCommittedH = Math.round((commitmentInfo.committed_hours || 0) * 100) / 100;
      const paWorkedH = Math.round((breakdown.hours?.total || 0) * 100) / 100;
      const paNetDeficit = paHasCommitment ? Math.max(0, Math.round((paCommittedH - paWorkedH) * 100) / 100) : 0;
      // Overtime-beyond-commitment is meaningful only for תקן — hourly staff are
      // paid per hour worked, so "extra vs commitment" is not shown for them.
      const paSurplus = (paHasCommitment && isTeken) ? Math.max(0, Math.round((paWorkedH - paCommittedH) * 100) / 100) : 0;
      const paEffectiveHours = isTeken ? Math.min(paDeductGross, paNetDeficit) : 0;
      const paDeduction = Math.round(paEffectiveHours * paHourlyValue * 100) / 100;
      const paMadeUp = isTeken && paCandidatesRaw.length > 0 && paNetDeficit <= 0;
      // Off-day work (תקן): days the employee worked that are NOT a committed work
      // day (their day off). Shown in the absence column as extra worked hours.
      const paCommitmentDoc = commitmentByEmp.get(String(emp._id));
      const paWorkSet = new Set(workingWeekdays(paCommitmentDoc, emp.work_days));
      // Alternating day (e.g. "one Friday a month"): the FIRST N worked occurrences
      // count as her commitment (neutral — not extra); every Friday BEYOND that N
      // is extra pay (תוספת). N = alternating_per_month (default 1).
      const paAltDay = (paCommitmentDoc && paCommitmentDoc.is_alternating_off && paCommitmentDoc.alternating_day != null)
        ? Number(paCommitmentDoc.alternating_day) : null;
      const paAltCommittedN = paAltDay != null
        ? (paCommitmentDoc.alternating_per_month != null ? Number(paCommitmentDoc.alternating_per_month) : 1)
        : 0;
      let paOffCandidates = (isTeken && paHasCommitment)
        ? (breakdown.days || []).filter(d => (Number(d.minutes) || 0) > 0 && !paExcl.has(d.date)
            && !paWorkSet.has(new Date(`${d.date}T12:00:00Z`).getUTCDay()))
        : [];
      if (paAltDay != null) {
        // Drop the first N worked alternating-day occurrences (her commitment);
        // the rest remain as off-day extra.
        const altWorked = paOffCandidates
          .filter(d => new Date(`${d.date}T12:00:00Z`).getUTCDay() === paAltDay)
          .sort((a, b) => a.date.localeCompare(b.date));
        const committedAlt = new Set(altWorked.slice(0, paAltCommittedN).map(d => d.date));
        paOffCandidates = paOffCandidates.filter(d => !committedAlt.has(d.date));
      }
      const paOffDayWork = paOffCandidates.map(d => ({ date: d.date, hours: Math.round((Number(d.minutes) / 60) * 100) / 100 }));
      const paOffDayHours = Math.round(paOffDayWork.reduce((s, d) => s + d.hours, 0) * 100) / 100;
      // Over-commitment work: committed days worked > 1h beyond the committed hours
      // (e.g. committed 08:00–13:45 but worked to 16:00 = +2.25h).
      const paOverages = (isTeken && paHasCommitment)
        ? committedDayOverages(commitmentByEmp.get(String(emp._id)), breakdown.days || [], paExcl, 1)
        : [];
      const paOverHours = Math.round(paOverages.reduce((s, d) => s + d.over_h, 0) * 100) / 100;
      // Total "תוספת" surfaced in the absence column = over-commitment + off-day work.
      const paExtraHours = Math.round((paOverHours + paOffDayHours) * 100) / 100;
      // Unified per-day EXTRA candidates (over-commitment + off-day). Default not
      // approved; approving a day PAYS its extra hours at the committed hourly value.
      const paExtraEntries = Array.isArray(existingManual.partial_extra_entries) ? existingManual.partial_extra_entries : [];
      const paExtraApprovedDates = new Set(paExtraEntries.filter(e => e.approved).map(e => e.date));
      const paExtraReasonByDate = new Map(paExtraEntries.map(e => [e.date, e.reason || '']));
      const paExtraCandidates = [
        ...paOverages.map(d => ({ date: d.date, kind: 'overage', hours: d.over_h, committed_h: d.committed_h, worked_h: d.worked_h })),
        ...paOffDayWork.map(d => ({ date: d.date, kind: 'offday', hours: d.hours, committed_h: 0, worked_h: d.hours })),
      ].sort((a, b) => a.date.localeCompare(b.date)).map(c => ({
        ...c, approved: paExtraApprovedDates.has(c.date), reason: paExtraReasonByDate.get(c.date) || '',
      }));
      const paExtraApprovedHours = Math.round(paExtraCandidates.filter(c => c.approved).reduce((s, c) => s + c.hours, 0) * 100) / 100;
      const paExtraPay = Math.round(paExtraApprovedHours * paHourlyValue * 100) / 100;
      if (paExtraPay) breakdown.estimated_total = (breakdown.estimated_total || 0) + paExtraPay;
      if (paDeduction) breakdown.estimated_total = (breakdown.estimated_total || 0) - paDeduction;

      return {
        employee_id: String(emp._id),
        full_name: emp.full_name,
        israeli_id: emp.israeli_id || '',
        employee_number: emp.employee_number || '',
        is_freelancer: !!emp.is_freelancer,
        // Bank details only for accounting/admin (sensitive).
        ...(canSeeBank ? {
          bank_number: emp.bank_number || '',
          bank_branch: emp.bank_branch || '',
          bank_account: emp.bank_account || '',
        } : {}),
        branch_id: String(emp.branch_id),
        branch_name: branchNameById.get(String(emp.branch_id)) || '',
        position: emp.position || '',
        permanent_note: emp.permanent_note || '',
        is_active: emp.is_active !== false,
        inactive_reason: emp.inactive_reason || '',
        salary_type: emp.salary_type,
        salary_is_net: !!emp.salary_is_net,
        // Travel config so UI can show "16₪/day" inline
        travel_mode: emp.travel_mode || 'per_day',
        travel_per_day: emp.travel_per_day || 0,
        travel_monthly_flat: emp.travel_monthly_flat || 0,
        travel_override: emp.travel_override ?? null, // standing per-employee amount
        breakdown,
        bonus: {
          auto: bonusAuto,
          auto_note: bonusAutoNote,
          effective: bonusEffective,
          note: bonusNote,
          disabled: bonusDisabled,
          override_amount: mBonus.override_amount ?? null,
          lines: bonusLines,
        },
        manual: {
          sick_days:      manual.sick_days || 0,
          absence_days:   manual.absence_days || 0,
          vacation_days:  manual.vacation_days || 0,
          holiday_pay:    manual.holiday_pay || 0,
          advance_deduction_preset_id: manual.advance_deduction_preset_id?._id || manual.advance_deduction_preset_id || null,
          advance_deduction_preset: manual.advance_deduction_preset_id?.label
            ? {
                id: String(manual.advance_deduction_preset_id._id),
                label: manual.advance_deduction_preset_id.label,
                action: manual.advance_deduction_preset_id.action,
              }
            : null,
          advance_deduction_text: manual.advance_deduction_text || '',
          gift_card:   manual.gift_card   || { kind: 'empty', amount: null, text: '' },
          recreation:  manual.recreation  || { kind: 'empty', amount: null, text: '' },
          cibus:       manual.cibus       || { kind: 'empty', amount: null, text: '' },
          miluim:      manual.miluim      || { kind: 'empty', amount: null, text: '' },
          travel_override: manual.travel_override ?? null,
          bonus: {
            override_amount: manual.bonus?.override_amount ?? null,
            note: manual.bonus?.note || '',
            disabled: !!manual.bonus?.disabled,
          },
          notes: manual.notes || '',
          custom_values: manual.custom_values || {},
          include_salary_completion: manual.include_salary_completion !== false,
          supplement_manager_approved: manual.supplement_manager_approved === true,
          supplement_accounting_approved: manual.supplement_accounting_approved === true,
          absence_entries: absenceEntries,
          partial_absence_entries: paEntries,
          partial_extra_entries: paExtraEntries,
        },
        adjustments: empAdjustments,
        adj_totals: adjTotals,
        absence: {
          days: absenceDays,                         // [{date, source: holiday|leave|unknown}]
          candidates: absenceDays.map(a => a.date),  // back-compat
          entries: absenceEntries,                   // per-day decisions (unknown days)
          daily_rate: dailyRate,                     // S / committed days
          deduction: absenceDeduction,               // amount actually deducted
          deductible_days: deductibleDays,
          unknown_count: unknownCount,               // days needing the manager's reason
          justified_count: justifiedCount,           // holiday / approved-leave days
        },
        // Partial-day absence (worked but > 1h short). Default = deduct; the
        // accountant marks days as EXCUSED (with optional reason) to not deduct.
        partial_absence: {
          candidates: paCandidates,                  // [{date, committed_h, worked_h, shortfall_h, excused, reason}]
          hourly_value: paHourlyValue,
          total_shortfall_hours: paTotalShortfall,   // sum of all flagged shortfalls
          deduct_gross_hours: paDeductGross,         // unexcused shortfall hours
          effective_hours: paEffectiveHours,         // hours actually deducted (after made-up cap)
          committed_hours: paCommittedH,             // monthly committed
          worked_hours: paWorkedH,                   // monthly actually worked
          net_deficit_hours: paNetDeficit,           // committed − worked (≥0)
          surplus_hours: paSurplus,                  // worked − committed (≥0) — overtime beyond commitment
          off_day_hours: paOffDayHours,              // worked on non-committed (day-off) days
          off_day_dates: paOffDayWork,               // [{date, hours}]
          overage_hours: paOverHours,                // committed days worked > 1h beyond commitment
          overage_dates: paOverages,                 // [{date, committed_h, worked_h, over_h}]
          extra_hours: paExtraHours,                 // total addition = overage + off-day work
          extra_candidates: paExtraCandidates,       // [{date, kind, hours, committed_h, worked_h, approved, reason}]
          extra_approved_hours: paExtraApprovedHours,
          extra_pay: paExtraPay,                     // ₪ paid for approved extra hours
          has_commitment: paHasCommitment,
          made_up: paMadeUp,                         // shortfalls fully compensated elsewhere
          deduction: paDeduction,
          excused_count: paCandidates.filter(c => c.excused).length,
          deduct_count: paCandidates.filter(c => !c.excused).length,
        },
        commitment: commitmentInfo.has_commitment ? {
          committed_days: commitmentInfo.committed_dates.length,
          committed_hours: commitmentInfo.committed_hours,  // contracted hours this month
          off_days: commitmentInfo.off_dates.length,
          absent_days: commitmentInfo.absent_dates,         // ymd[] for tooltip
          off_day_workdays: commitmentInfo.off_day_workdays, // ymd[] of compensation
          net_absent: commitmentInfo.net_absent,
        } : null,
        holiday_pay_auto: {
          total_days: holidayPayInfo.total_days,
          total_pay: holidayPayInfo.total_pay,
          eligible: holidayPayInfo.eligible_days,
          ineligible: holidayPayInfo.ineligible_days,
          blocking_reason: holidayPayInfo.blocking_reason,
          is_eligible: holidayPayInfo.total_days > 0,
          calc: holidayPayInfo.calc,
        },
        loans_info: (() => {
          const list = Array.isArray(emp.loans) ? emp.loans : [];
          const active = list.filter(l => (l.installments_paid || 0) < (l.installments_total || 0));
          const monthDeduction = active.reduce((s, l) => s + (Number(l.installment_amount) || 0), 0);
          return {
            count: active.length,
            month_deduction: Math.round(monthDeduction * 100) / 100,
            loans: list.map(l => ({
              id: String(l._id),
              total_amount: l.total_amount,
              installment_amount: l.installment_amount,
              installments_total: l.installments_total,
              installments_paid: l.installments_paid || 0,
              started_at: l.started_at || null,
              notes: l.notes || '',
              active: (l.installments_paid || 0) < (l.installments_total || 0),
            })),
          };
        })(),
        vacation_info: (() => {
          return {
            balance_from_payslip: row?.vacation_balance_from_payslip ?? null,
            balance_recorded_at: row?.vacation_balance_recorded_at || null,
            request_ids: row?.vacation_request_ids?.map(String) || [],
          };
        })(),
        vacation_days_auto: {
          total_days: vacationAutoInfo.total,
          details: vacationAutoInfo.details,
          source: 'kindergarten_holidays',
        },
        vacation_pay: vacationPay,        // paid for hourly (0 for תקן — covered by salary)
        vacation_eff_days: vacEffDays,    // effective vacation days drawn from balance
        sick_info: {
          policy: emp.sick_pay_policy || 'statutory',
          daily_value: Math.round(sickDailyValue * 100) / 100,
          daily_value_override: emp.sick_daily_value_override ?? null,
          balance_opening: {
            // Effective opening actually used (explicit, else derived from hire).
            days: Number(sickOpening?.days) || 0,
            as_of_month: sickOpening?.as_of_month || null,
          },
          balance_capped: sickOpening != null, // false → no balance limit configured
          balance_accrued: sickAccrued == null ? null : Math.round(sickAccrued * 100) / 100,
          balance_available: sickAvail == null ? null : Math.round(sickAvail * 100) / 100,
          used_before_month: Math.round(sickUsedBefore * 100) / 100,
          days_used_this_month: sickCalc.total_days_used,
          days_uncovered: sickCalc.total_days_uncovered,
          paid_days: sickCalc.total_paid_days,
          pay: sickPay,
          certs: sickCalc.results,   // per-cert: work_days, covered_days, paid_days, paid_amount, full_from_day_1
        },
        status: row?.status || 'draft',
      };
    });

    // Branch totals (for display strip)
    const totals = rows.reduce((acc, r) => {
      acc.employees += 1;
      acc.hours += r.breakdown.hours.total || 0;
      acc.base  += r.breakdown.components.base_salary || 0;
      return acc;
    }, { employees: 0, hours: 0, base: 0 });

    // Branches referenced by anyone's per_branch breakdown — these are the
    // column groups the UI should render (filter view scope + cross-branch hours).
    const referencedBranchIds = new Set();
    for (const r of rows) {
      Object.keys(r.breakdown.per_branch || {}).forEach(id => referencedBranchIds.add(id));
    }
    // Always include the in-scope branches even if no employee has any punches yet
    branches.forEach(b => referencedBranchIds.add(String(b._id)));

    const branchesInView = allBranchesData
      .filter(b => referencedBranchIds.has(String(b._id)))
      .map((b, idx) => ({
        id: String(b._id),
        name: b.name,
        amuta_id: b.amuta_id ? String(b.amuta_id) : null,
        // Stable color index — derived from the alphabetical position so it
        // stays the same across page reloads / month changes.
        color_index: idx,
      }));

    res.json({
      month,
      rows,
      amutot: amutot.map(a => ({ id: String(a._id), name: a.name, short_name: a.short_name })),
      branches: branches.map(b => ({ id: String(b._id), name: b.name, amuta_id: b.amuta_id ? String(b.amuta_id) : null })),
      branches_in_view: branchesInView,
      custom_columns: customColumns.map(c => ({
        id: String(c._id),
        month: c.month,
        label: c.label,
        kind: c.kind,
        position: c.position,
      })),
      totals,
    });
  } catch (err) { next(err); }
}

/**
 * PATCH /api/payroll-month/:employeeId?month=YYYY-MM
 * body: { manual: { ...partial fields... } }
 *
 * Upserts the (employee × month) row with the provided manual fields. All
 * manual fields are optional — only those present in the body are updated.
 */
async function upsertEntry(req, res, next) {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'month=YYYY-MM is required' });
    const { employeeId } = req.params;

    const emp = await Employee.findById(employeeId).select('branch_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const body = req.body?.manual || {};
    const role = req.user?.role;
    const setObj = {};
    const allowed = [
      'sick_days', 'absence_days', 'vacation_days', 'holiday_pay',
      'advance_deduction_preset_id', 'advance_deduction_text',
      'gift_card', 'recreation', 'cibus', 'miluim',
      'travel_override', 'bonus', 'notes', 'custom_values',
      'include_salary_completion',
      'supplement_manager_approved', 'supplement_accounting_approved',
      'absence_entries', 'partial_absence_entries', 'partial_extra_entries',
    ];

    // Per-role write rules for the approval flags:
    //   supplement_manager_approved    → branch_manager (own branches) or admin
    //   supplement_accounting_approved → accountant or admin
    const canSetManagerApproval    = role === 'branch_manager' || role === 'system_admin';
    const canSetAccountingApproval = role === 'accountant'     || role === 'system_admin';

    // A branch manager may ONLY touch the manager-side approvals (supplement +
    // absence), and only for an employee in a branch they manage.
    if (role === 'branch_manager') {
      const MGR_KEYS = new Set(['supplement_manager_approved', 'absence_entries']);
      if (Object.keys(body).some(k => !MGR_KEYS.has(k))) {
        return res.status(403).json({ error: 'מנהל סניף רשאי לעדכן רק אישורי מנהל' });
      }
      const managed = (req.user.managed_branch_ids || []).map(String);
      if (req.user.branch_id) managed.push(String(req.user.branch_id));
      if (!managed.includes(String(emp.branch_id))) {
        return res.status(403).json({ error: 'אין הרשאה לסניף זה' });
      }
    }

    // Absence entries are an array of per-day decisions — merge by date so each
    // role only writes its own side (manager_approved vs accounting_approved),
    // preventing one role from flipping the other's approval.
    if (Object.prototype.hasOwnProperty.call(body, 'absence_entries')) {
      const incoming = Array.isArray(body.absence_entries) ? body.absence_entries : [];
      const prevDoc = await PayrollMonth.findOne({ employee_id: employeeId, month })
        .select('manual.absence_entries').lean();
      const prevByDate = new Map((prevDoc?.manual?.absence_entries || []).map(e => [e.date, e]));
      setObj['manual.absence_entries'] = incoming.map(inc => {
        const prev = prevByDate.get(inc.date) || {};
        const base = {
          date: inc.date,
          category: inc.category ?? prev.category ?? 'unpaid',
          note: inc.note ?? prev.note ?? '',
          manager_approved: !!prev.manager_approved,
          accounting_approved: !!prev.accounting_approved,
        };
        if (role === 'branch_manager' || role === 'system_admin') base.manager_approved = !!inc.manager_approved;
        if (role === 'accountant'     || role === 'system_admin') base.accounting_approved = !!inc.accounting_approved;
        return base;
      });
    }

    for (const k of allowed) {
      if (k === 'absence_entries') continue; // handled above
      if (!Object.prototype.hasOwnProperty.call(body, k)) continue;
      if (k === 'supplement_manager_approved' && !canSetManagerApproval) {
        return res.status(403).json({ error: 'רק מנהל סניף יכול לאשר את חלק המנהל' });
      }
      if (k === 'supplement_accounting_approved' && !canSetAccountingApproval) {
        return res.status(403).json({ error: 'רק הנהלת חשבונות יכולה לאשר את חלק ההנה״ח' });
      }
      setObj[`manual.${k}`] = body[k];
    }

    const row = await PayrollMonth.findOneAndUpdate(
      { employee_id: employeeId, month },
      {
        $set: setObj,
        $setOnInsert: { branch_id: emp.branch_id, employee_id: employeeId, month },
      },
      { new: true, upsert: true },
    ).populate('manual.advance_deduction_preset_id');

    // Auto-bump usage_count for the chosen preset (helps sort by popularity)
    if (body.advance_deduction_preset_id) {
      await PayrollPresetOption.findByIdAndUpdate(
        body.advance_deduction_preset_id,
        { $inc: { usage_count: 1 } },
      );
    }

    res.json({ ok: true, entry: row });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/:month/finalize?branch=<id>
 *
 * Freezes a month: each in-scope row gets status='finalized' and its
 * auto_snapshot is persisted. Once finalized the auto numbers won't be
 * recomputed even if punches change.
 */
async function finalizeMonth(req, res, next) {
  try {
    const { month } = req.params;
    const { branch } = req.query;

    const filter = {};
    if (branch) filter.branch_id = branch;

    const employees = await Employee.find({ ...filter, is_active: true })
      .populate('amuta_distribution.amuta_id', 'name short_name')
      .lean();

    const allBranches = await Branch.find({}).select('_id amuta_id').lean();
    const branchAmutaMap = new Map(
      allBranches.filter(b => b.amuta_id).map(b => [String(b._id), String(b.amuta_id)])
    );

    const { from, to } = parseMonthRange(month);
    const punches = await Punch.find({
      employee_id: { $in: employees.map(e => e._id) },
      timestamp: { $gte: from, $lt: to },
      ignored: { $ne: true },
    }).sort({ timestamp: 1 }).lean();
    const punchesByEmp = new Map();
    for (const p of punches) {
      const k = String(p.employee_id);
      if (!punchesByEmp.has(k)) punchesByEmp.set(k, []);
      punchesByEmp.get(k).push(p);
    }

    // Load each employee's manual toggles so the frozen snapshot honours the
    // completion toggle and the supplement approvals (was previously ignored).
    const existingDocs = await PayrollMonth.find({
      employee_id: { $in: employees.map(e => e._id) }, month,
    }).select('employee_id manual').lean();
    const manualByEmp = new Map(existingDocs.map(d => [String(d.employee_id), d.manual || {}]));

    // Commitments → committed-day count for the absence daily rate.
    const finCommitments = await EmployeeCommitment.find({
      employee_id: { $in: employees.map(e => e._id) },
    }).lean();
    const finCommitByEmp = new Map(finCommitments.map(c => [String(c.employee_id), c]));

    let updated = 0;
    for (const emp of employees) {
      const empPunches = punchesByEmp.get(String(emp._id)) || [];
      const m = manualByEmp.get(String(emp._id)) || {};
      // Approved deductible absence days × uniform daily rate.
      const ci = analyzeCommitment(finCommitByEmp.get(String(emp._id)), empPunches, month);
      const committedDays = ci.committed_dates.length;
      const tekenSalary = Number(emp.amuta_distribution?.[0]?.global_salary) || 0;
      const dailyRate = (emp.salary_type === 'global' && committedDays > 0 && tekenSalary > 0)
        ? tekenSalary / committedDays : 0;
      const deductibleDays = (Array.isArray(m.absence_entries) ? m.absence_entries : []).filter(e =>
        DEDUCTIBLE_ABSENCE.has(e.category || 'unpaid')
        && e.manager_approved === true && e.accounting_approved === true,
      ).length;
      const snapshot = calculateMonthlySalary(emp, empPunches, month, {
        branchAmutaMap,
        include_salary_completion: m.include_salary_completion !== false,
        pay_excess_supplement: false, // RETIRED — see getMonth
        absence_deduction: Math.round(deductibleDays * dailyRate * 100) / 100,
        // Mirror the live view exactly so finalizing never shifts the teken
        // hourly value: committed clock hours for display/threshold, OT-weighted
        // committed hours for the base hourly value.
        required_hours_override: ci.has_commitment ? ci.committed_hours : null,
        committed_weighted_override: ci.has_commitment ? ci.committed_weighted_hours : null,
        travel_override: m.travel_override,
      });
      await PayrollMonth.findOneAndUpdate(
        { employee_id: emp._id, month },
        {
          $set: {
            auto_snapshot: snapshot,
            status: 'finalized',
            finalized_at: new Date(),
            finalized_by: req.user.id,
          },
          $setOnInsert: { branch_id: emp.branch_id, employee_id: emp._id, month },
        },
        { upsert: true },
      );
      updated++;
    }

    res.json({ ok: true, updated });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/:month/reopen?branch=<id>
 * Sets status back to 'draft' so admin can keep editing.
 */
async function reopenMonth(req, res, next) {
  try {
    const { month } = req.params;
    const { branch } = req.query;
    const filter = { month };
    if (branch) filter.branch_id = branch;
    const result = await PayrollMonth.updateMany(filter, {
      $set: { status: 'draft', finalized_at: null, finalized_by: null },
    });
    res.json({ ok: true, modified: result.modifiedCount });
  } catch (err) { next(err); }
}

// ── Preset options CRUD ───────────────────────────────────────────────

async function listPresets(req, res, next) {
  try {
    const { field_name } = req.query;
    const filter = { is_active: true };
    if (field_name) filter.field_name = field_name;
    const options = await PayrollPresetOption.find(filter).sort({ usage_count: -1, label: 1 }).lean();
    res.json({ options: options.map(o => ({ ...o, id: String(o._id) })) });
  } catch (err) { next(err); }
}

async function createPreset(req, res, next) {
  try {
    const { field_name, label, action, action_params } = req.body;
    if (!field_name || !label) return res.status(400).json({ error: 'field_name and label are required' });
    const existing = await PayrollPresetOption.findOne({ field_name, label });
    if (existing) {
      return res.json({ option: { ...existing.toObject(), id: String(existing._id) }, existed: true });
    }
    const opt = await PayrollPresetOption.create({
      field_name,
      label,
      action: action || 'custom',
      action_params: action_params || {},
      created_by: req.user.id,
    });
    res.json({ option: { ...opt.toObject(), id: String(opt._id) }, existed: false });
  } catch (err) { next(err); }
}

async function updatePreset(req, res, next) {
  try {
    const { id } = req.params;
    const { label, action, action_params, is_active } = req.body;
    const opt = await PayrollPresetOption.findByIdAndUpdate(
      id,
      { $set: { ...(label != null && { label }), ...(action && { action }), ...(action_params && { action_params }), ...(is_active != null && { is_active }) } },
      { new: true },
    );
    if (!opt) return res.status(404).json({ error: 'option not found' });
    res.json({ option: { ...opt.toObject(), id: String(opt._id) } });
  } catch (err) { next(err); }
}

async function deletePreset(req, res, next) {
  try {
    const { id } = req.params;
    await PayrollPresetOption.findByIdAndUpdate(id, { $set: { is_active: false } });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// ── Amuta-branch mapping admin ───────────────────────────────────────

async function listAmutot(req, res, next) {
  try {
    const amutot = await Amuta.find({}).sort({ name: 1 }).lean();
    const branches = await Branch.find({}).select('_id name amuta_id').sort({ name: 1 }).lean();
    res.json({
      amutot: amutot.map(a => ({ ...a, id: String(a._id) })),
      branches: branches.map(b => ({ ...b, id: String(b._id) })),
    });
  } catch (err) { next(err); }
}

async function upsertAmuta(req, res, next) {
  try {
    const { id } = req.params;
    const { name, short_name, tax_id, is_active } = req.body;
    if (id === 'new') {
      const amuta = await Amuta.create({ name, short_name, tax_id });
      return res.json({ amuta: { ...amuta.toObject(), id: String(amuta._id) } });
    }
    const amuta = await Amuta.findByIdAndUpdate(
      id,
      { $set: { ...(name && { name }), ...(short_name != null && { short_name }), ...(tax_id != null && { tax_id }), ...(is_active != null && { is_active }) } },
      { new: true },
    );
    if (!amuta) return res.status(404).json({ error: 'amuta not found' });
    res.json({ amuta: { ...amuta.toObject(), id: String(amuta._id) } });
  } catch (err) { next(err); }
}

// ── Salary adjustments CRUD ─────────────────────────────────────────

async function listAdjustments(req, res, next) {
  try {
    const { month, employee_id, branch } = req.query;
    const filter = { status: { $ne: 'rejected' } };
    if (month) filter.month = month;
    if (employee_id) filter.employee_id = employee_id;
    if (branch && branch !== 'all') filter.branch_id = branch;
    const list = await SalaryAdjustment.find(filter)
      .populate('employee_id', 'full_name israeli_id')
      .populate('created_by', 'full_name')
      .sort({ created_at: -1 })
      .lean();
    res.json({ adjustments: list.map(a => ({ ...a, id: String(a._id) })) });
  } catch (err) { next(err); }
}

async function createAdjustment(req, res, next) {
  try {
    const { employee_id, month, type, amount, hours, reason } = req.body;
    if (!employee_id || !month || !type) {
      return res.status(400).json({ error: 'employee_id, month, type are required' });
    }
    const emp = await Employee.findById(employee_id).select('branch_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const adj = await SalaryAdjustment.create({
      employee_id,
      branch_id: emp.branch_id,
      month,
      type,
      amount: Number(amount) || 0,
      hours: Number(hours) || 0,
      reason: reason || '',
      created_by: req.user.id,
      status: 'approved', // branch managers' entries auto-approve
      decided_by: req.user.id,
      decided_at: new Date(),
    });
    res.json({ adjustment: { ...adj.toObject(), id: String(adj._id) } });
  } catch (err) { next(err); }
}

async function updateAdjustment(req, res, next) {
  try {
    const { id } = req.params;
    const setObj = {};
    ['amount', 'hours', 'reason', 'type', 'status'].forEach(k => {
      if (req.body[k] != null) setObj[k] = req.body[k];
    });
    const adj = await SalaryAdjustment.findByIdAndUpdate(id, { $set: setObj }, { new: true });
    if (!adj) return res.status(404).json({ error: 'adjustment not found' });
    res.json({ adjustment: { ...adj.toObject(), id: String(adj._id) } });
  } catch (err) { next(err); }
}

async function deleteAdjustment(req, res, next) {
  try {
    await SalaryAdjustment.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// ── Custom columns CRUD ─────────────────────────────────────────────

async function listCustomColumns(req, res, next) {
  try {
    const { month } = req.query;
    const filter = { is_active: true };
    if (month) filter.$or = [{ month }, { month: '*' }];
    const cols = await PayrollCustomColumn.find(filter).sort({ position: 1, created_at: 1 }).lean();
    res.json({ columns: cols.map(c => ({ ...c, id: String(c._id) })) });
  } catch (err) { next(err); }
}

async function createCustomColumn(req, res, next) {
  try {
    const { month, label, kind, position, persistent } = req.body;
    if (!month || !label) return res.status(400).json({ error: 'month and label are required' });
    if (!['text', 'number', 'number_or_text'].includes(kind)) {
      return res.status(400).json({ error: 'invalid kind' });
    }
    const col = await PayrollCustomColumn.create({
      month: persistent ? '*' : month,
      label: label.trim(),
      kind,
      position: position || 0,
      created_by: req.user.id,
    });
    res.json({ column: { ...col.toObject(), id: String(col._id) } });
  } catch (err) { next(err); }
}

async function updateCustomColumn(req, res, next) {
  try {
    const { id } = req.params;
    const { label, kind, position, is_active, month } = req.body;
    const setObj = {};
    if (label != null) setObj.label = String(label).trim();
    if (kind && ['text', 'number', 'number_or_text'].includes(kind)) setObj.kind = kind;
    if (position != null) setObj.position = Number(position);
    if (is_active != null) setObj.is_active = !!is_active;
    if (month) setObj.month = month;
    const col = await PayrollCustomColumn.findByIdAndUpdate(id, { $set: setObj }, { new: true });
    if (!col) return res.status(404).json({ error: 'column not found' });
    res.json({ column: { ...col.toObject(), id: String(col._id) } });
  } catch (err) { next(err); }
}

async function deleteCustomColumn(req, res, next) {
  try {
    const { id } = req.params;
    await PayrollCustomColumn.findByIdAndUpdate(id, { $set: { is_active: false } });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/:month/apply-auto-holidays?branch=<id>
 *
 * Bulk-applies the auto-computed דמי חגים value into manual.holiday_pay
 * for every eligible hourly employee in scope. Only writes when:
 *   - employee.salary_type === 'hourly'
 *   - holiday_pay_auto > 0
 *   - manual.holiday_pay is currently 0 / empty (we do NOT overwrite
 *     manager overrides)
 *
 * Returns { updated, skipped_already_set, skipped_not_eligible }.
 */
async function applyAutoHolidays(req, res, next) {
  try {
    const { month } = req.params;
    const { branch } = req.query;

    const branchFilter = { is_active: true };
    if (branch && branch !== 'all') branchFilter.branch_id = branch;

    // Same scope enforcement as getMonth
    const role = req.user?.role;
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length > 0 ? managed : fallback;
      if (branchFilter.branch_id && !allowed.includes(String(branchFilter.branch_id))) {
        return res.json({ updated: 0, skipped_already_set: 0, skipped_not_eligible: 0 });
      }
      if (!branchFilter.branch_id) branchFilter.branch_id = { $in: allowed };
    }

    const employees = await Employee.find(branchFilter).lean();
    const empIds = employees.map(e => e._id);

    const { from, to } = parseMonthRange(month);
    const punches = await Punch.find({
      employee_id: { $in: empIds },
      timestamp: { $gte: from, $lt: to },
      ignored: { $ne: true },
    }).sort({ timestamp: 1 }).lean();
    const punchesByEmp = new Map();
    for (const p of punches) {
      const k = String(p.employee_id);
      if (!punchesByEmp.has(k)) punchesByEmp.set(k, []);
      punchesByEmp.get(k).push(p);
    }

    const commitments = await EmployeeCommitment.find({ employee_id: { $in: empIds } }).lean();
    const commitmentByEmp = new Map(commitments.map(c => [String(c.employee_id), c]));

    const existing = await PayrollMonth.find({ employee_id: { $in: empIds }, month }).lean();
    const existingByEmp = new Map(existing.map(r => [String(r.employee_id), r]));

    let updated = 0;
    let skippedAlreadySet = 0;
    let skippedNotEligible = 0;

    for (const emp of employees) {
      if (emp.salary_type !== 'hourly') { skippedNotEligible++; continue; }

      const empPunches = (punchesByEmp.get(String(emp._id)) || []).filter(p => {
        const s = p.approval_status || 'auto';
        return s === 'auto' || s === 'approved';
      });
      const hourlyRate = emp.amuta_distribution?.[0]?.hourly_rate || 0;
      const daysWorked = new Set(empPunches.map(p => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(p.timestamp)))).size;
      const totalMinutes = (() => {
        const byDay = new Map();
        for (const p of empPunches) {
          const k = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(p.timestamp));
          if (!byDay.has(k)) byDay.set(k, []);
          byDay.get(k).push(p);
        }
        let total = 0;
        for (const ps of byDay.values()) {
          const sorted = ps.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
          for (let i = 0; i + 1 < sorted.length; i += 2) {
            total += Math.max(0, Math.round((new Date(sorted[i + 1].timestamp) - new Date(sorted[i].timestamp)) / 60000));
          }
        }
        return total;
      })();
      const avgDailyHours = daysWorked > 0 ? (totalMinutes / 60 / daysWorked) : 8;

      const info = computeHolidayPay({
        employee: emp,
        monthYM: month,
        punches: empPunches,
        commitment: commitmentByEmp.get(String(emp._id)),
        hourlyRate,
        avgDailyHours,
      });

      if (info.total_pay <= 0) { skippedNotEligible++; continue; }

      const cur = Number(existingByEmp.get(String(emp._id))?.manual?.holiday_pay) || 0;
      if (cur > 0) { skippedAlreadySet++; continue; }

      await PayrollMonth.findOneAndUpdate(
        { employee_id: emp._id, month },
        {
          $set: { 'manual.holiday_pay': info.total_pay },
          $setOnInsert: { branch_id: emp.branch_id, employee_id: emp._id, month },
        },
        { upsert: true },
      );
      updated++;
    }

    res.json({ updated, skipped_already_set: skippedAlreadySet, skipped_not_eligible: skippedNotEligible });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/:month/apply-kindergarten-vacation?branch=<id>
 *
 * Sets manual.vacation_days = number-of-weekdays-in-kindergarten-holidays
 * for every employee in scope. Same idea as apply-auto-holidays but reads
 * the Holiday model instead of the statutory list. Skips employees that
 * already have a manager-entered value (vacation_days > 0).
 */
async function applyKindergartenVacationDays(req, res, next) {
  try {
    const { month } = req.params;
    const { branch } = req.query;

    const branchFilter = { is_active: true };
    if (branch && branch !== 'all') branchFilter.branch_id = branch;

    const role = req.user?.role;
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length > 0 ? managed : fallback;
      if (branchFilter.branch_id && !allowed.includes(String(branchFilter.branch_id))) {
        return res.json({ updated: 0, skipped_already_set: 0, no_kindergarten_holidays: 0 });
      }
      if (!branchFilter.branch_id) branchFilter.branch_id = { $in: allowed };
    }

    const employees = await Employee.find(branchFilter).lean();
    const empIds = employees.map(e => e._id);
    const branchIds = [...new Set(employees.map(e => String(e.branch_id)))];

    const [yy, mm] = month.split('-').map(Number);
    const monthStart = new Date(Date.UTC(yy, mm - 1, 1));
    const monthEnd = new Date(Date.UTC(yy, mm, 0, 23, 59, 59));
    const holidays = await Holiday.find({
      branch_id: { $in: branchIds },
      start_date: { $lte: monthEnd },
      end_date: { $gte: monthStart },
    }).lean();
    const holidaysByBranch = new Map();
    for (const h of holidays) {
      const k = String(h.branch_id);
      if (!holidaysByBranch.has(k)) holidaysByBranch.set(k, []);
      holidaysByBranch.get(k).push(h);
    }

    const commitments = await EmployeeCommitment.find({ employee_id: { $in: empIds } }).lean();
    const commitmentByEmp = new Map(commitments.map(c => [String(c.employee_id), c]));

    const existing = await PayrollMonth.find({ employee_id: { $in: empIds }, month }).lean();
    const existingByEmp = new Map(existing.map(r => [String(r.employee_id), r]));

    let updated = 0;
    let skippedAlreadySet = 0;
    let noKindergartenHolidays = 0;

    const statutoryHolidayDates = new Set(getHolidaysInMonth(month).map(h => h.date));
    for (const emp of employees) {
      const empHolidays = holidaysByBranch.get(String(emp.branch_id)) || [];
      const info = computeKindergartenVacationDays(empHolidays, month, commitmentByEmp.get(String(emp._id)), statutoryHolidayDates);
      if (info.total <= 0) { noKindergartenHolidays++; continue; }
      const cur = Number(existingByEmp.get(String(emp._id))?.manual?.vacation_days) || 0;
      if (cur > 0) { skippedAlreadySet++; continue; }
      await PayrollMonth.findOneAndUpdate(
        { employee_id: emp._id, month },
        {
          $set: { 'manual.vacation_days': info.total },
          $setOnInsert: { branch_id: emp.branch_id, employee_id: emp._id, month },
        },
        { upsert: true },
      );
      updated++;
    }

    res.json({ updated, skipped_already_set: skippedAlreadySet, no_kindergarten_holidays: noKindergartenHolidays });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/:month/apply-vacation-requests?branch=<id>
 *
 * Retroactive sync: walks every approved EmployeeRequest with from_date
 * in the target month and applies it to manual.vacation_days. Idempotent
 * (vacation_request_ids tracks already-applied requests).
 */
async function applyVacationRequests(req, res, next) {
  try {
    const { month } = req.params;
    const { branch } = req.query;
    const { EmployeeRequest } = require('../models');

    const branchFilter = {};
    if (branch && branch !== 'all') branchFilter.branch_id = branch;

    const role = req.user?.role;
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length > 0 ? managed : fallback;
      if (branchFilter.branch_id && !allowed.includes(String(branchFilter.branch_id))) {
        return res.json({ updated: 0, skipped_already_applied: 0 });
      }
      if (!branchFilter.branch_id) branchFilter.branch_id = { $in: allowed };
    }

    const employees = await Employee.find({ is_active: true, ...branchFilter })
      .select('_id user_id branch_id').lean();
    const empByUser = new Map(employees.filter(e => e.user_id).map(e => [String(e.user_id), e]));
    const userIds = [...empByUser.keys()];

    const requests = await EmployeeRequest.find({
      user_id: { $in: userIds },
      type: 'vacation',
      status: 'approved',
      from_date: { $regex: `^${month}` },
    }).lean();

    function countWorkDays(fromYmd, toYmd) {
      const start = new Date(`${fromYmd}T12:00:00Z`);
      const end = new Date(`${toYmd}T12:00:00Z`);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
      let count = 0;
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const wd = d.getUTCDay();
        if (wd !== 6) count++;
      }
      return count;
    }

    let updated = 0;
    let skipped = 0;
    for (const r of requests) {
      const emp = empByUser.get(String(r.user_id));
      if (!emp) continue;
      const days = countWorkDays(r.from_date, r.to_date || r.from_date);
      if (days <= 0) continue;
      const existing = await PayrollMonth.findOne({ employee_id: emp._id, month }).lean();
      const alreadyApplied = (existing?.vacation_request_ids || []).map(String).includes(String(r._id));
      if (alreadyApplied) { skipped++; continue; }
      await PayrollMonth.findOneAndUpdate(
        { employee_id: emp._id, month },
        {
          $inc: { 'manual.vacation_days': days },
          $addToSet: { vacation_request_ids: r._id },
          $setOnInsert: { branch_id: emp.branch_id, employee_id: emp._id, month },
        },
        { upsert: true },
      );
      updated++;
    }

    res.json({ updated, skipped_already_applied: skipped, requests_examined: requests.length });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/import-cibus?month=YYYY-MM
 * multipart: { cibus_file: <xlsx|csv> }
 *
 * Parses an exported Pluxee/Cibus report and writes each employee's monthly
 * total into PayrollMonth.manual.cibus. Matches employees by israeli_id
 * first, falls back to fuzzy name match within the system.
 *
 * Response: { matched, unmatched, total_amount, details: [...] }
 */
async function importCibus(req, res, next) {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'month=YYYY-MM is required' });
    if (!req.file) return res.status(400).json({ error: 'נדרש קובץ סיבוס' });

    let report;
    try {
      report = parseCibusReport(req.file.buffer, req.file.originalname);
    } catch (err) {
      return res.status(400).json({ error: err.message || 'שגיאה בקריאת קובץ סיבוס' });
    }

    // Enforce per-user branch scope on the employee lookup
    const role = req.user?.role;
    const branchScope = {};
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length > 0 ? managed : fallback;
      branchScope.branch_id = { $in: allowed };
    }

    const allEmployees = await Employee.find({ is_active: true, ...branchScope })
      .select('_id full_name israeli_id branch_id')
      .lean();
    const byId = new Map(allEmployees.filter(e => e.israeli_id).map(e => [e.israeli_id, e]));
    const normalizeName = (s) => (s || '').replace(/[()‘’“”"'.,]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const normalized = allEmployees.map(e => ({ emp: e, tokens: normalizeName(e.full_name).split(' ').filter(Boolean) }));

    const matched = [];
    const unmatched = [];
    let totalAmount = 0;

    for (const row of report.rows || []) {
      let emp = row.id ? byId.get(row.id) : null;
      if (!emp && row.name) {
        const target = normalizeName(row.name).split(' ').filter(Boolean);
        if (target.length > 0) {
          let best = null;
          let bestScore = 0;
          for (const cand of normalized) {
            let common = 0;
            for (const t of target) if (cand.tokens.includes(t)) common++;
            const required = target.length === 1 ? 1 : 2;
            if (common >= required && common > bestScore) {
              best = cand.emp;
              bestScore = common;
            }
          }
          emp = best;
        }
      }
      const amount = Number(row.amount) || 0;
      totalAmount += amount;
      if (!emp) {
        unmatched.push({ name: row.name, id: row.id, amount });
        continue;
      }
      await PayrollMonth.findOneAndUpdate(
        { employee_id: emp._id, month },
        {
          $set: {
            'manual.cibus': { kind: 'number', amount, text: '' },
          },
          $setOnInsert: { branch_id: emp.branch_id, employee_id: emp._id, month },
        },
        { upsert: true },
      );
      matched.push({
        employee_id: String(emp._id),
        employee_name: emp.full_name,
        israeli_id: emp.israeli_id,
        amount,
      });
    }

    res.json({
      matched_count: matched.length,
      unmatched_count: unmatched.length,
      total_amount: Math.round(totalAmount * 100) / 100,
      matched,
      unmatched,
      detected_columns: report.detected_columns,
      warning: report.warning || null,
    });
  } catch (err) { next(err); }
}

async function setBranchAmuta(req, res, next) {
  try {
    const { branchId } = req.params;
    const { amuta_id } = req.body;
    const branch = await Branch.findByIdAndUpdate(
      branchId,
      { $set: { amuta_id: amuta_id || null } },
      { new: true },
    );
    if (!branch) return res.status(404).json({ error: 'branch not found' });
    res.json({ branch: { ...branch.toObject(), id: String(branch._id) } });
  } catch (err) { next(err); }
}

// ── Payroll change requests (branch-manager → accountant approval) ──────

const CHANGE_ALLOWED_FIELDS = [
  'sick_days', 'absence_days', 'vacation_days', 'holiday_pay',
  'advance_deduction_preset_id', 'advance_deduction_text',
  'gift_card', 'recreation', 'cibus', 'miluim',
  'travel_override', 'notes', 'custom_values', 'include_salary_completion',
];

/**
 * POST /api/payroll-month/change-requests
 * Body: { month, note?, changes: [{ employee_id, field, current_value,
 *         requested_value, field_label? }] }
 *
 * Branch managers stage their edits in the UI and submit them here as one
 * pending request. Accountants/admins review and apply.
 */
async function createChangeRequest(req, res, next) {
  try {
    const { month, note, changes } = req.body;
    if (!month || !Array.isArray(changes) || changes.length === 0) {
      return res.status(400).json({ error: 'month וגם changes (לא ריק) נדרשים' });
    }
    for (const c of changes) {
      if (!c.employee_id || !c.field) {
        return res.status(400).json({ error: 'כל שינוי חייב employee_id ו-field' });
      }
      if (!CHANGE_ALLOWED_FIELDS.includes(c.field)) {
        return res.status(400).json({ error: `שדה לא מורשה: ${c.field}` });
      }
    }

    // Enrich with employee + branch names
    const empIds = [...new Set(changes.map(c => String(c.employee_id)))];
    const emps = await Employee.find({ _id: { $in: empIds } })
      .populate('branch_id', 'name').select('full_name branch_id').lean();
    const empMap = new Map(emps.map(e => [String(e._id), e]));

    // Submitter's branch (first managed branch / their branch_id)
    const submitterBranchId = (req.user.managed_branch_ids?.[0]) || req.user.branch_id || null;
    let submitterBranchName = '';
    if (submitterBranchId) {
      const b = await Branch.findById(submitterBranchId).select('name').lean();
      submitterBranchName = b?.name || '';
    }

    const doc = await PayrollChangeRequest.create({
      month,
      requested_by: req.user.id,
      requested_by_name: req.user.full_name || '',
      branch_id: submitterBranchId,
      branch_name: submitterBranchName,
      note: note || '',
      changes: changes.map(c => {
        const emp = empMap.get(String(c.employee_id));
        return {
          employee_id: c.employee_id,
          employee_name: emp?.full_name || '',
          branch_id: emp?.branch_id?._id || emp?.branch_id || null,
          field: c.field,
          field_label: c.field_label || c.field,
          current_value: c.current_value ?? null,
          requested_value: c.requested_value ?? null,
        };
      }),
      change_decisions: changes.map(() => 'pending'),
      status: 'pending',
    });
    res.status(201).json({ request: doc });
  } catch (err) { next(err); }
}

/**
 * GET /api/payroll-month/change-requests?status=pending&mine=1
 * Admin/accountant: all requests. With mine=1 (or branch_manager role):
 * only the caller's own requests.
 */
async function listChangeRequests(req, res, next) {
  try {
    const { status, mine } = req.query;
    const role = req.user?.role;
    const filter = {};
    if (status) filter.status = status;
    const isReviewer = role === 'system_admin' || role === 'accountant';
    if (mine === '1' || !isReviewer) {
      filter.requested_by = req.user.id;
    }
    const list = await PayrollChangeRequest.find(filter)
      .sort({ created_at: -1 })
      .limit(200)
      .lean();
    const pendingCount = await PayrollChangeRequest.countDocuments({ status: 'pending' });
    res.json({ requests: list, pending_count: pendingCount });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/change-requests/:id/decide
 * Body: { decisions: ['approved'|'rejected'|'pending', ...] (index-aligned
 *         with changes), decision_note? }
 *
 * Applies every change marked 'approved' to PayrollMonth.manual, then sets
 * the request status (approved / rejected / partially_approved).
 */
async function decideChangeRequest(req, res, next) {
  try {
    const { id } = req.params;
    const { decisions, decision_note } = req.body;
    const doc = await PayrollChangeRequest.findById(id);
    if (!doc) return res.status(404).json({ error: 'בקשה לא נמצאה' });
    if (doc.status !== 'pending') {
      return res.status(400).json({ error: 'הבקשה כבר טופלה' });
    }
    const dec = Array.isArray(decisions) && decisions.length === doc.changes.length
      ? decisions
      : doc.changes.map(() => 'approved'); // default: approve all

    let appliedCount = 0;
    for (let i = 0; i < doc.changes.length; i++) {
      if (dec[i] !== 'approved') continue;
      const ch = doc.changes[i];
      const emp = await Employee.findById(ch.employee_id).select('branch_id').lean();
      if (!emp) continue;
      await PayrollMonth.findOneAndUpdate(
        { employee_id: ch.employee_id, month: doc.month },
        {
          $set: { [`manual.${ch.field}`]: ch.requested_value },
          $setOnInsert: { branch_id: emp.branch_id, employee_id: ch.employee_id, month: doc.month },
        },
        { upsert: true },
      );
      appliedCount++;
    }

    const anyApproved = dec.some(d => d === 'approved');
    const anyRejected = dec.some(d => d === 'rejected');
    doc.status = anyApproved && anyRejected ? 'partially_approved'
      : anyApproved ? 'approved' : 'rejected';
    doc.change_decisions = dec;
    doc.decided_by = req.user.id;
    doc.decided_by_name = req.user.full_name || '';
    doc.decided_at = new Date();
    if (decision_note != null) doc.decision_note = decision_note;
    await doc.save();

    res.json({ request: doc, applied: appliedCount });
  } catch (err) { next(err); }
}

// ── Send monthly salary table + supporting files to the accountant ──────

// Reuse getMonth's EXACT computation by invoking it with a captured response,
// so the emailed table matches the on-screen table (no duplicated salary logic).
function fetchMonthData(query, user) {
  return new Promise((resolve, reject) => {
    const req = { query, user };
    const res = {
      json: (data) => resolve(data),
      status: () => ({ json: (data) => resolve(data) }),
    };
    getMonth(req, res, reject);
  });
}

function mimeFromName(name = '') {
  const ext = String(name).split('.').pop()?.toLowerCase();
  const map = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  return map[ext] || 'application/octet-stream';
}
function extOf(name = '', mime = '') {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(name));
  if (m) return '.' + m[1].toLowerCase();
  const rev = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
  return rev[mime] || '';
}
const safeName = (s) => String(s || '').replace(/[\/\\:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);

// Per-gan marker colours — mirror of client GAN_MARKERS so the accountant PDF
// matches the on-screen branch colours. Matched by substring of the branch name.
const ACCT_GAN_MARKERS = [
  { match: ['תל אביב', 'תל-אביב', 'ת"א'], strip: '#ef4444', stripText: '#ffffff', tint: '#fef2f2', accent: '#dc2626' },
  { match: ['הרצליה'],                      strip: '#facc15', stripText: '#3f2d00', tint: '#fefce8', accent: '#eab308' },
  { match: ['משה דיין'],                    strip: '#f97316', stripText: '#ffffff', tint: '#fff7ed', accent: '#ea580c' },
  { match: ['קפלן'],                         strip: '#ec4899', stripText: '#ffffff', tint: '#fdf2f8', accent: '#db2777' },
];
const acctMarker = (name) => ACCT_GAN_MARKERS.find(g => g.match.some(m => (name || '').includes(m)))
  || { strip: '#475569', stripText: '#ffffff', tint: '#f8fafc', accent: '#334155' };

// One print-ready PDF for the accountant: a card per employee with every field
// needed to build a payslip, grouped by branch with matching gan colours.
function buildAccountantHtml(month, rows) {
  const f = (n) => '₪' + Math.round(Number(n) || 0).toLocaleString('he-IL');
  const n1 = (n) => (Math.round((Number(n) || 0) * 10) / 10).toLocaleString('he-IL');
  const nt = (field) => {
    if (!field || field.kind === 'empty') return '';
    if (field.kind === 'number') return field.amount != null ? f(field.amount) : '';
    return field.text || '';
  };
  const grand = rows.reduce((s, r) => s + (r.breakdown?.estimated_total || 0), 0);

  // Group rows by branch, preserving a stable alphabetical branch order.
  const byBranch = new Map();
  for (const r of rows) {
    const key = r.branch_name || '—';
    if (!byBranch.has(key)) byBranch.set(key, []);
    byBranch.get(key).push(r);
  }
  const branchNames = [...byBranch.keys()].sort((a, b) => a.localeCompare(b, 'he'));

  // A single labelled field cell (label over value). Empty values render muted.
  const cell = (label, value, opts = {}) => {
    const has = value !== '' && value != null && value !== '—';
    const valColor = opts.color || (has ? '#0f172a' : '#cbd5e1');
    return `<td style="border:1px solid #e2e8f0;padding:4px 6px;vertical-align:top;width:${opts.w || '16.6%'}">
      <div style="font-size:8.5px;color:#64748b;font-weight:700">${label}</div>
      <div style="font-size:11px;font-weight:${opts.bold ? 800 : 600};color:${valColor}">${has ? value : '—'}</div>
    </td>`;
  };

  const card = (r) => {
    const b = r.breakdown || {}, c = b.components || {}, d = b.deductions || {}, h = b.hours || {};
    const tb = c.teken_breakdown || {};
    const isGlobal = r.salary_type === 'global';
    const m = acctMarker(r.branch_name);
    const sickPay = r.sick_info?.pay || 0;
    const sickDays = Number(r.manual?.sick_days) || 0;
    const holiday = Number(r.manual?.holiday_pay) > 0 ? Number(r.manual.holiday_pay) : (r.holiday_pay_auto?.total_pay || 0);
    const vac = r.vacation_eff_days != null ? r.vacation_eff_days : (Number(r.manual?.vacation_days) || 0);
    const bonus = r.bonus?.effective || 0;
    const completion = isGlobal && (r.manual?.include_salary_completion !== false) ? (tb.completion || 0) : 0;
    const paDed = r.partial_absence?.deduction || 0;
    const paExtra = r.partial_absence?.extra_pay || 0;
    const totalDed = (d.loans || 0) + (d.absence || 0) + paDed;
    const advance = r.manual?.advance_deduction_preset?.label || r.manual?.advance_deduction_text || '';
    const rateCell = isGlobal
      ? cell('שכר תקן' + (r.salary_is_net ? ' (נטו)' : ''), b.rates?.global_salary ? f(b.rates.global_salary) : '')
      : cell('תעריף שעה', b.rates?.hourly_rate ? f(b.rates.hourly_rate) : '');
    const notes = [r.permanent_note, r.manual?.notes].filter(Boolean).join(' · ');
    const bank = [r.bank_number, r.bank_branch, r.bank_account].some(Boolean);

    return `<table style="width:100%;border-collapse:collapse;border:2px solid ${m.accent};margin:0 0 8px;page-break-inside:avoid;border-radius:6px;overflow:hidden">
      <tr style="background:${m.tint}">
        <td style="padding:6px 8px;border-bottom:1px solid ${m.accent}">
          <span style="font-size:14px;font-weight:800;color:#0f172a">${r.full_name}</span>
          ${r.employee_number ? `<span style="font-size:10px;color:#475569"> · מס׳ ${r.employee_number}</span>` : ''}
          <span style="font-size:10px;color:#475569"> · ת״ז ${r.israeli_id || '—'}</span>
          ${r.position ? `<span style="font-size:10px;color:#475569"> · ${r.position}</span>` : ''}
          <span style="display:inline-block;margin-right:6px;padding:1px 7px;border-radius:9px;background:${m.strip};color:${m.stripText};font-size:9px;font-weight:700">${isGlobal ? 'תקן' : 'שעתי'}</span>
        </td>
        <td style="padding:6px 8px;text-align:left;border-bottom:1px solid ${m.accent};white-space:nowrap">
          <span style="font-size:9px;color:#64748b">סה״כ משוער</span>
          <span style="font-size:16px;font-weight:800;color:${m.accent}">${f(b.estimated_total)}</span>
        </td>
      </tr>
      <tr><td colspan="2" style="padding:0">
        <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif">
          <tr>
            ${cell('ימי עבודה', n1(h.days_worked))}
            ${cell('סה״כ שעות', n1(h.total))}
            ${cell('רגילות', n1(h.regular))}
            ${cell('שע״נ 125%', h.ot_125 ? n1(h.ot_125) : '')}
            ${cell('שע״נ 150%', h.ot_150 ? n1(h.ot_150) : '')}
            ${rateCell}
          </tr>
          <tr>
            ${cell('שכר בסיס', f(c.base_salary), { bold: true })}
            ${cell('השלמת שכר', completion ? f(completion) : '')}
            ${cell('נסיעות', c.travel ? f(c.travel) : '')}
            ${cell('דמי חגים', holiday ? f(holiday) : '')}
            ${cell('בונוס', bonus ? f(bonus) : '')}
            ${cell('מחלה', sickDays ? `${n1(sickDays)} ימים${sickPay ? ` · ${f(sickPay)}` : ''}` : '')}
          </tr>
          <tr>
            ${cell('חופשה', vac ? `${n1(vac)} ימים` : '')}
            ${cell('מילואים', nt(r.manual?.miluim))}
            ${cell('GIFT CARD', nt(r.manual?.gift_card))}
            ${cell('הבראה', nt(r.manual?.recreation))}
            ${cell('סיבוס', nt(r.manual?.cibus))}
            ${cell('תוספת שעות', paExtra ? f(paExtra) : '', { color: '#15803d' })}
          </tr>
          <tr>
            ${cell('קיזוז מקדמה', advance)}
            ${cell('הלוואות', d.loans ? '−' + f(d.loans) : '', { color: '#b91c1c' })}
            ${cell('קיזוז היעדרות', paDed ? '−' + f(paDed) : '', { color: '#b91c1c' })}
            ${cell('קיזוז ימי היעדרות', d.absence ? '−' + f(d.absence) : '', { color: '#b91c1c' })}
            ${cell('סה״כ ניכויים', totalDed ? '−' + f(totalDed) : '', { color: '#b91c1c', bold: true })}
            ${cell('', '')}
          </tr>
          ${bank ? `<tr>
            ${cell('בנק', r.bank_number || '')}
            ${cell('סניף בנק', r.bank_branch || '')}
            ${cell('חשבון בנק', r.bank_account || '')}
            <td colspan="3" style="border:1px solid #e2e8f0;padding:4px 6px;vertical-align:top">
              <div style="font-size:8.5px;color:#64748b;font-weight:700">הערות</div>
              <div style="font-size:10px;color:#334155">${notes || '—'}</div></td>
          </tr>` : (notes ? `<tr><td colspan="6" style="border:1px solid #e2e8f0;padding:4px 6px">
              <span style="font-size:8.5px;color:#64748b;font-weight:700">הערות: </span>
              <span style="font-size:10px;color:#334155">${notes}</span></td></tr>` : '')}
        </table>
      </td></tr>
    </table>`;
  };

  const sections = branchNames.map(name => {
    const list = byBranch.get(name);
    const m = acctMarker(name);
    const subtotal = list.reduce((s, r) => s + (r.breakdown?.estimated_total || 0), 0);
    return `<div style="page-break-inside:avoid">
      <table style="width:100%;border-collapse:collapse;margin:14px 0 8px">
        <tr style="background:${m.strip}">
          <td style="padding:6px 10px;color:${m.stripText};font-size:14px;font-weight:800;border-radius:5px 0 0 5px">${name}</td>
          <td style="padding:6px 10px;color:${m.stripText};font-size:11px;text-align:left;border-radius:0 5px 5px 0">${list.length} עובדים · ${f(subtotal)}</td>
        </tr>
      </table>
    </div>${list.map(card).join('')}`;
  }).join('');

  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<style>@page{size:A4 portrait;margin:9mm}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;box-sizing:border-box}
body{font-family:Arial,sans-serif;color:#111;margin:0;padding:4px}
h1{font-size:17px;text-align:center;margin:0 0 2px}
.sub{text-align:center;color:#475569;font-size:11px;margin:0 0 4px}</style></head>
<body>
<h1>כרטיסי שכר עובדים — ${month}</h1>
<div class="sub">גן החלומות · ${rows.length} עובדים · סה״כ לתשלום ${f(grand)}</div>
${sections}
</body></html>`;
}

/**
 * POST /api/payroll-month/:month/send-accountant?branch=<id|all>
 * Body: { email? }  — emails the month's salary table (same data as the screen),
 * per-employee notes, and every supporting file for the month (sick certificates
 * + uploaded documents) to the accountant.
 */
const OFFICE_CC_DEFAULT = 'tofy10.office@gmail.com';

// Shared read of the saved accountant recipient list + office copy address.
async function readAccountantRecipients() {
  let toList = [];
  const listDoc = await Setting.findOne({ key: 'accountant_emails' }).lean();
  if (Array.isArray(listDoc?.value)) toList = listDoc.value.map(e => String(e).trim()).filter(Boolean);
  if (toList.length === 0) {
    const single = await Setting.findOne({ key: 'accountant_email' }).lean();
    if (single?.value) toList = [String(single.value).trim()].filter(Boolean);
  }
  const officeDoc = await Setting.findOne({ key: 'office_cc_email' }).lean();
  const officeCc = (officeDoc && typeof officeDoc.value === 'string' && officeDoc.value.trim())
    ? officeDoc.value.trim() : OFFICE_CC_DEFAULT;
  return { toList, officeCc };
}

// GET the accountant contact list + the office copy address.
async function getAccountantContacts(req, res, next) {
  try {
    const listDoc = await Setting.findOne({ key: 'accountant_emails' }).lean();
    let emails = Array.isArray(listDoc?.value) ? listDoc.value.map(e => String(e).trim()).filter(Boolean) : [];
    if (emails.length === 0) {
      const single = await Setting.findOne({ key: 'accountant_email' }).lean();
      if (single?.value) emails = [String(single.value).trim()].filter(Boolean);
    }
    const officeDoc = await Setting.findOne({ key: 'office_cc_email' }).lean();
    const office_cc = (officeDoc && typeof officeDoc.value === 'string' && officeDoc.value.trim())
      ? officeDoc.value.trim() : OFFICE_CC_DEFAULT;
    res.json({ accountant_emails: emails, office_cc });
  } catch (err) { next(err); }
}

// PUT the accountant contact list (and optionally the office copy address).
async function setAccountantContacts(req, res, next) {
  try {
    const emails = Array.isArray(req.body?.accountant_emails)
      ? [...new Set(req.body.accountant_emails.map(e => String(e).trim()).filter(Boolean))] : [];
    await Setting.findOneAndUpdate({ key: 'accountant_emails' }, { value: emails }, { upsert: true });
    if (typeof req.body?.office_cc === 'string') {
      await Setting.findOneAndUpdate({ key: 'office_cc_email' }, { value: req.body.office_cc.trim() }, { upsert: true });
    }
    res.json({ ok: true, accountant_emails: emails });
  } catch (err) { next(err); }
}

// Build the accountant PDF HTML WITHOUT sending — drives the preview dialog.
// Returns the rendered cards + the default recipients + supporting-file count.
async function previewAccountant(req, res, next) {
  try {
    const { month } = req.params;
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM נדרש' });
    const branch = req.query.branch || 'all';
    const data = await fetchMonthData({ month, branch }, req.user);
    const rows = (data.rows || []).filter(r => !r.is_freelancer);
    if (rows.length === 0) return res.status(400).json({ error: 'אין עובדים לשליחה בחודש זה' });
    const html = buildAccountantHtml(month, rows);
    const { toList, officeCc } = await readAccountantRecipients();
    // Count the supporting files that would be attached (certs + month docs).
    const empIds = rows.map(r => r.employee_id);
    const emps = await Employee.find({ _id: { $in: empIds } }).select('_id user_id').lean();
    const userIds = emps.filter(e => e.user_id).map(e => e.user_id);
    const certCount = await EmployeeRequest.countDocuments({
      type: { $in: ['sick', 'vacation'] }, status: 'approved',
      from_date: { $regex: `^${month}` }, medical_file_data: { $ne: null },
      $or: [{ employee_id: { $in: empIds } }, ...(userIds.length ? [{ user_id: { $in: userIds } }] : [])],
    });
    const docCount = await EmployeeDocument.countDocuments({ employee_id: { $in: empIds }, month });
    res.json({ html, employees: rows.length, attachments: certCount + docCount, accountant_emails: toList, office_cc: officeCc });
  } catch (err) { next(err); }
}

async function sendToAccountant(req, res, next) {
  try {
    const { month } = req.params;
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM נדרש' });
    const branch = req.query.branch || 'all';

    // Recipients: the saved contact list, OR an explicit per-send selection from
    // the preview dialog (one-off — does NOT overwrite the saved defaults; edit
    // those via the contacts dialog). The office always gets a copy.
    const saved = await readAccountantRecipients();
    let toList = saved.toList;
    if (Array.isArray(req.body?.emails) && req.body.emails.length) {
      toList = [...new Set(req.body.emails.map(e => String(e).trim()).filter(Boolean))];
    }
    if (toList.length === 0) return res.status(400).json({ error: 'מייל רואה חשבון לא מוגדר' });
    const to = toList;
    const cc = saved.officeCc ? [saved.officeCc] : [];

    // Respond immediately — building 84 cards into a print-ready PDF and sending
    // up to ~25MB of attachments through GAS takes far longer than the client's
    // 30s HTTP timeout. Do the heavy work in the background and report "started".
    res.json({ ok: true, queued: true, sent_to: to.join(', '), cc: cc.join(', ') });

    // ----- background send (not awaited; never throws to the request) -----
    void (async () => {
    try {
    // Exact same table data as the screen.
    const data = await fetchMonthData({ month, branch }, req.user);
    const rows = (data.rows || []).filter(r => !r.is_freelancer);
    if (rows.length === 0) { console.warn('accountant send: no employees for', month); return; }
    const html = buildAccountantHtml(month, rows);

    // Gather supporting files for the month: sick/vacation certificates + uploads.
    const empIds = rows.map(r => r.employee_id);
    const emps = await Employee.find({ _id: { $in: empIds } }).select('_id full_name user_id').lean();
    const nameById = new Map(emps.map(e => [String(e._id), e.full_name]));
    const userIds = emps.filter(e => e.user_id).map(e => e.user_id);
    const userToEmp = new Map(emps.filter(e => e.user_id).map(e => [String(e.user_id), String(e._id)]));

    const fileAttachments = [];
    const certs = await EmployeeRequest.find({
      type: { $in: ['sick', 'vacation'] }, status: 'approved',
      from_date: { $regex: `^${month}` }, medical_file_data: { $ne: null },
      $or: [{ employee_id: { $in: empIds } }, ...(userIds.length ? [{ user_id: { $in: userIds } }] : [])],
    }).select('employee_id user_id type from_date medical_file_data medical_file_name').lean();
    for (const c of certs) {
      const eid = c.employee_id ? String(c.employee_id) : userToEmp.get(String(c.user_id));
      const nm = nameById.get(eid) || 'עובד';
      const label = c.type === 'sick' ? 'אישור מחלה' : 'אישור חופשה';
      fileAttachments.push({
        filename: safeName(`${nm} - ${label} ${c.from_date}`) + extOf(c.medical_file_name),
        contentBase64: c.medical_file_data,
        contentType: mimeFromName(c.medical_file_name),
      });
    }
    const docs = await EmployeeDocument.find({ employee_id: { $in: empIds }, month })
      .select('employee_id name file_data file_name file_mimetype').lean();
    for (const d of docs) {
      const nm = nameById.get(String(d.employee_id)) || 'עובד';
      fileAttachments.push({
        filename: safeName(`${nm} - ${d.name}`) + extOf(d.file_name, d.file_mimetype),
        contentBase64: d.file_data,
        contentType: d.file_mimetype || mimeFromName(d.file_name),
      });
    }

    // Email size: Gmail/GAS caps a whole message at ~25MB. Pack the supporting
    // files into batches under a budget so a heavy month never bounces — the
    // cards PDF goes in email #1, extra files follow in additional emails.
    const FILE_BUDGET = 18 * 1024 * 1024; // base64 chars per email
    const batches = [];
    let cur = [], curSize = 0;
    for (const fa of fileAttachments) {
      const sz = (fa.contentBase64 || '').length;
      if (cur.length && curSize + sz > FILE_BUDGET) { batches.push(cur); cur = []; curSize = 0; }
      cur.push(fa); curSize += sz;
    }
    if (cur.length) batches.push(cur);
    if (batches.length === 0) batches.push([]); // at least the cards email

    const intro = `<div dir="rtl" style="font-family:Arial,sans-serif">
      <p>שלום,</p>
      <p>מצורף קובץ PDF מוכן להדפסה עם <b>כרטיס שכר לכל עובד</b> לחודש <b>${month}</b> (${rows.length} עובדים),
         מחולק לפי סניפים וצבעים, הכולל את כל הנתונים הנדרשים להפקת התלושים.</p>
      <p>מצורפים גם ${fileAttachments.length} מסמכים תומכים לאותו חודש (אישורי מחלה, מילואים וכו')${
        batches.length > 1 ? `, מחולקים ל-${batches.length} מיילים בשל גודלם` : ''}.</p>
    </div><hr>`;

    let provider = null;
    for (let i = 0; i < batches.length; i++) {
      const first = i === 0;
      const r = await dispatchEmail({
        to,
        cc,
        subject: first
          ? `כרטיסי שכר ${month} — גן החלומות`
          : `מסמכים תומכים (${i + 1}/${batches.length}) — שכר ${month} · גן החלומות`,
        html: first
          ? intro + html
          : `<div dir="rtl" style="font-family:Arial,sans-serif"><p>המשך — מסמכים תומכים לחודש <b>${month}</b> (חלק ${i + 1} מתוך ${batches.length}).</p></div>`,
        attachments: first ? [{ name: `כרטיסי שכר ${month}`, html }] : [], // GAS → print-ready PDF (first email only)
        fileAttachments: batches[i],
      });
      provider = r?.provider || provider;
    }
    console.log(`accountant send complete: ${month} → ${to.join(', ')} · ${rows.length} emp · ${batches.length} emails · ${provider}`);
    } catch (e) {
      console.error('accountant send (bg) failed:', e.message, JSON.stringify(e.detail || e.code || ''));
      // Notify the office so a silent failure doesn't go unnoticed.
      try {
        await dispatchEmail({
          to: cc.length ? cc : to,
          subject: `⚠️ שליחת טבלת שכר ${month} לרו״ח נכשלה`,
          html: `<div dir="rtl" style="font-family:Arial,sans-serif"><p>השליחה האוטומטית של טבלת השכר לחודש <b>${month}</b> לרו״ח נכשלה.</p><p>פרטי השגיאה: ${e.message}</p><p>נסו שוב מהמערכת.</p></div>`,
        });
      } catch (e2) { console.error('accountant failure-notice email also failed:', e2.message); }
    }
    })();
  } catch (err) {
    console.error('sendToAccountant setup failed:', err.message);
    return res.status(502).json({ error: `שגיאה בשליחה: ${err.message}` });
  }
}

module.exports = {
  getMonth,
  sendToAccountant,
  previewAccountant,
  getAccountantContacts,
  setAccountantContacts,
  upsertEntry,
  createChangeRequest,
  listChangeRequests,
  decideChangeRequest,
  finalizeMonth,
  reopenMonth,
  listPresets,
  createPreset,
  updatePreset,
  deletePreset,
  listAmutot,
  upsertAmuta,
  setBranchAmuta,
  listCustomColumns,
  createCustomColumn,
  updateCustomColumn,
  deleteCustomColumn,
  listAdjustments,
  createAdjustment,
  updateAdjustment,
  deleteAdjustment,
  importCibus,
  applyAutoHolidays,
  applyVacationRequests,
  applyKindergartenVacationDays,
  // Internal helper reused by the per-employee hours report so it shows the
  // SAME authoritative shortfall/extra numbers as the salary table.
  fetchMonthData,
  buildAccountantHtml,
};
