/**
 * Controller for the monthly payroll table — the one with per-amuta column
 * groups and manual fields (sick, vacation, gift card, etc.). Backed by the
 * `PayrollMonth` collection plus on-the-fly recomputation via payrollCalc.
 */
const {
  PayrollMonth, PayrollPresetOption, PayrollCustomColumn, SalaryAdjustment,
  Employee, Branch, Amuta, Punch, EmployeeCommitment, Holiday, SpecialDay,
  PayrollChangeRequest, EmployeeRequest, EmployeeDocument, Setting, PunchResolution,
  User, PunchEntryTask, PayrollRollup,
} = require('../models');
const { calculateMonthlySalary } = require('../services/payrollCalc');
const {
  materializeMonth: materializeFixedSchedule,
  conflictsForMonth: fixedScheduleConflicts,
  markDayOff: markFixedScheduleDayOff,
  ilDateTime: ilDateTimeOf,
} = require('../services/fixedSchedule');
const ISR_DAY = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const ISR_HHMM = (ts) => new Date(ts).toLocaleTimeString('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });

/**
 * Suggest how to label a >2-punch day, so the accountant usually just confirms.
 *
 * The key signal is WHEN EACH RECORD WAS CREATED (`created_at`), not the punch
 * time. Two real scenarios:
 *   • manual entered first, the Pi synced later → the manual was a stand-in for
 *     a clock that hadn't reported yet; the real clock data supersedes it.
 *   • the Pi punches already existed and a manual was added after → the
 *     accountant saw the real data and deliberately corrected it; the manual wins.
 * A day with no manual punches at all (a clock double-read) falls back to
 * first=in / last=out with the middles ignored.
 *
 * Returns { labels:[{punch_id, role}], reason }. Advisory only — the accountant
 * still approves.
 */
function suggestPunchLabels(sortedPunches) {
  const manual = sortedPunches.filter(p => p.timestamp_source === 'manual');
  const real = sortedPunches.filter(p => p.timestamp_source !== 'manual');
  const created = (p) => new Date(p.created_at || p.timestamp).getTime();
  const label = (keep, drop, reason) => {
    const labels = [];
    for (const p of drop) labels.push({ punch_id: String(p._id), role: 'ignore' });
    keep.forEach((p, i) => labels.push({
      punch_id: String(p._id),
      role: i === 0 ? 'in' : i === keep.length - 1 ? 'out' : 'ignore',
    }));
    return { labels, reason };
  };

  if (manual.length && real.length) {
    const lastManual = Math.max(...manual.map(created));
    const lastReal = Math.max(...real.map(created));
    if (lastReal > lastManual) {
      return label(real, manual,
        'ההחתמות מהשעון הגיעו אחרי העדכון הידני — הידני היה מילוי זמני, ולכן מוצע להתעלם ממנו ולהשתמש בהחתמות השעון.');
    }
    return label(manual, real,
      'העדכון הידני נעשה אחרי שהחתמות השעון כבר היו במערכת — כלומר הנה״ח ראתה אותן ותיקנה במכוון, ולכן מוצע להשתמש בעדכון הידני.');
  }
  return label(sortedPunches, [],
    manual.length
      ? 'כל ההחתמות ידניות — מוצע הראשונה ככניסה והאחרונה כיציאה.'
      : 'קריאה כפולה של השעון — מוצע הראשונה ככניסה והאחרונה כיציאה.');
}
const { analyzeCommitment, datesInMonth, workingWeekdays } = require('../services/commitmentAnalysis');
const { computeHolidayPay, getHolidaysInMonth } = require('../services/israeliHolidays');
const { applyCibusReport } = require('../services/cibusImport');
const { computeSickPay, availableBalance, accruedBalance } = require('../services/sickPay');
const { dispatchEmail } = require('../services/email.service');

// Absence categories that REDUCE pay (the rest — sick/vacation/reserve — are paid).
// 'maternity' (חופשת לידה) and 'pregnancy_bedrest' (שמירת הריון) are JUSTIFIED but
// not employer-paid: she is paid pro-rata for the days she actually worked, and
// ביטוח לאומי pays her separately. They deduct like an unpaid day but carry their
// own label so the accountant sees the reason (and bedrest never touches the
// sick-day balance, unlike 'sick').
const DEDUCTIBLE_ABSENCE = new Set(['unpaid', 'other', 'maternity', 'pregnancy_bedrest']);

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
 *   - A day the gan was CLOSED on paper but she actually came in and worked
 *
 * That last one is the point of `workedDates`. A closure she worked through is
 * not a vacation day: she is paid for the hours she actually did, and the day
 * must NOT be drawn from her balance — otherwise she pays for the closure twice,
 * once by working it and once by losing the day. Those days come back in
 * `worked_on_holiday` so the month still shows that she worked a day the
 * calendar says the gan was shut.
 *
 * Returns { total, details: [{date, name, value}], worked_on_holiday: [...] }.
 */
function computeKindergartenVacationDays(holidays, monthYM, commitment, statutoryDates, workedDates) {
  // Only days she was supposed to WORK count as paid vacation. With a commitment
  // that means a required weekday; a closure on her off-day / a non-work weekday
  // gives no vacation pay.
  const requiredWeekdays = new Set();
  const hasCommitment = !!(commitment && Array.isArray(commitment.days) && commitment.days.length);
  if (hasCommitment) {
    for (const d of commitment.days) if (!d.is_off) requiredWeekdays.add(d.day);
  }
  const statutory = statutoryDates instanceof Set ? statutoryDates : new Set(statutoryDates || []);
  const worked = workedDates instanceof Set ? workedDates : new Set(workedDates || []);
  const result = { total: 0, details: [], worked_on_holiday: [] };
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
      // She came in on a day the gan was listed as closed: pay the hours, keep
      // the vacation day, and flag it.
      if (worked.has(ymd)) {
        result.worked_on_holiday.push({ date: ymd, name: h.name });
        continue;
      }
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

    // Fill in any missing fixed-hours punches for employees who don't clock in.
    // Idempotent and bounded by today, so running it on every load simply keeps
    // the month current without ever inventing future hours. A failure here must
    // not take the salary table down with it.
    try {
      await materializeFixedSchedule(month, { branchIds, userId: req.user?.id || null });
    } catch (e) {
      console.error('[payrollMonth] fixed-schedule fill failed:', e.message);
    }

    // Date window for the month (used for punches + inactive-relevance).
    const { from, to } = parseMonthRange(month);

    // Active employees are always shown. Inactive employees are shown ONLY if
    // they had activity this month (punches or a payroll record), so a just-
    // deactivated employee stays visible with their reason — without listing
    // everyone who ever left.
    // Unpaid role-holders (receives_salary:false) are deliberately absent from
    // the whole table — not a zero row. There is nothing to compute for them,
    // and a name sitting in the salary screen is an invitation to pay it.
    const activeEmps = await Employee.find({
      branch_id: { $in: branchIds }, is_active: true, receives_salary: { $ne: false },
    })
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
      branch_id: { $in: branchIds }, is_active: false, receives_salary: { $ne: false },
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

    // Accountant decisions for days with >2 punches. Keyed employee → date →
    // resolution; a day without one stays provisional (span) and is flagged.
    // Only APPROVED ones bill — a branch manager's proposal is not pay.
    const resolutionDocs = await PunchResolution.find({
      employee_id: { $in: employees.map(e => e._id) },
      date: { $regex: `^${month}` },
      status: 'approved',
    }).lean();
    const resByEmp = new Map();
    for (const r of resolutionDocs) {
      const k = String(r.employee_id);
      if (!resByEmp.has(k)) resByEmp.set(k, new Map());
      resByEmp.get(k).set(r.date, r);
    }

    // Attached files still awaiting the accountant's acknowledgement — shown as
    // "📎 … ממתין בקבצים" in each employee's notes cell so files aren't missed.
    // BOTH sources count: documents uploaded from the notes column AND the
    // medical certificates carried by sick / vacation / pregnancy-exam requests.
    // The certificate is the more common case, so leaving it out made attached
    // files look captionless in the table.
    const empIdList = employees.map(e => e._id);
    const userIdList = employees.map(e => e.user_id).filter(Boolean);
    // Fetched unfiltered by acknowledgement so the same read also yields the
    // total file count behind each row's "קבצים" chip (metadata only — the
    // base64 payloads are never selected).
    const [allDocs, allCerts] = await Promise.all([
      EmployeeDocument.find({ employee_id: { $in: empIdList } })
        .select('employee_id name file_name created_at acknowledged').sort({ created_at: -1 }).lean(),
      EmployeeRequest.find({
        $or: [
          { employee_id: { $in: empIdList } },
          ...(userIdList.length ? [{ user_id: { $in: userIdList } }] : []),
        ],
        medical_file_data: { $ne: null },
      }).select('employee_id user_id type from_date to_date medical_file_name created_at cert_acknowledged')
        .sort({ created_at: -1 }).lean(),
    ]);
    const pendingDocs = allDocs.filter(d => d.acknowledged !== true);
    const pendingCerts = allCerts.filter(c => c.cert_acknowledged !== true);
    // Certificates filed through a login carry user_id only — map back to the employee.
    const empByUserId = new Map(employees.filter(e => e.user_id).map(e => [String(e.user_id), String(e._id)]));
    const CERT_LABEL = { sick: 'אישור מחלה', vacation: 'אישור חופשה', pregnancy_exam: 'אישור בדיקת הריון' };
    const pendingDocsByEmp = new Map();
    const push = (empKey, entry) => {
      if (!empKey) return;
      if (!pendingDocsByEmp.has(empKey)) pendingDocsByEmp.set(empKey, []);
      pendingDocsByEmp.get(empKey).push(entry);
    };
    for (const d of pendingDocs) {
      push(String(d.employee_id), { id: String(d._id), source: 'document', name: d.name || d.file_name || 'קובץ' });
    }
    for (const c of pendingCerts) {
      const empKey = c.employee_id ? String(c.employee_id) : empByUserId.get(String(c.user_id));
      const span = c.to_date && c.to_date !== c.from_date ? `${c.from_date}–${c.to_date}` : c.from_date;
      push(empKey, { id: String(c._id), source: 'request', name: `${CERT_LABEL[c.type] || 'אישור'} ${span}` });
    }
    // Total attached files per employee — drives the count on the "קבצים" chip
    // so a row always shows that files exist, acknowledged or not.
    const docsTotalByEmp = new Map();
    const bump = (k) => { if (k) docsTotalByEmp.set(k, (docsTotalByEmp.get(k) || 0) + 1); };
    for (const d of allDocs) bump(String(d.employee_id));
    for (const c of allCerts) bump(c.employee_id ? String(c.employee_id) : empByUserId.get(String(c.user_id)));

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

    // Employer-declared one-off closures (מסיבת סיום, יום צוות). branch_id null
    // means every branch. Unlike a Holiday these do NOT draw a vacation day —
    // see models/SpecialDay.js.
    const specialDays = await SpecialDay.find({
      date: { $regex: `^${month}` },
      $or: [{ branch_id: null }, { branch_id: { $in: branchIds } }],
    }).lean();
    const specialDaysByBranch = new Map();
    for (const b of branchIds) {
      specialDaysByBranch.set(String(b), specialDays.filter(
        d => !d.branch_id || String(d.branch_id) === String(b),
      ));
    }
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
      // Employer-declared closures. For a global employee a day marked
      // `pay_global` joins holidayDates, which is what stops the month reading
      // it as an unexplained absence and deducting a daily rate. Hourly staff
      // are handled below as a credit — adding their day here would do nothing,
      // since an hourly employee is never "absent" to begin with.
      const empSpecialDays = specialDaysByBranch.get(String(emp.branch_id)) || [];
      const isTekenEmp = emp.salary_type === 'global';
      for (const sd of empSpecialDays) {
        if (isTekenEmp && sd.pay_global) holidayDates.add(sd.date);
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
      // Approved whole-day-absence ↔ extra-hours offsets: the absence day is not
      // deducted and (below) the matched extra day is not paid.
      const offsetEntries = isTeken && Array.isArray(existingManual.absence_offset_entries) ? existingManual.absence_offset_entries : [];
      const offsetAbsenceDates = new Set(offsetEntries.filter(o => o.approved).map(o => o.absence_date));
      const offsetExtraDates = new Set(offsetEntries.filter(o => o.approved).map(o => o.extra_date));
      // A committed day missed because the gan was closed (holiday) or for
      // approved leave is NOT an absence — it's vacation/leave, handled in those
      // columns. Only truly-unexplained missed days are absences.
      // Maternity window: from the birth date (or the recorded leave start) until
      // the leave end, if set — otherwise open-ended. Missed committed days inside
      // it are justified maternity leave: still employer-unpaid (she is paid
      // pro-rata for the days she worked), but flagged so the accountant sees the
      // reason instead of a bare "unexplained absence".
      const matStartRaw = emp.gave_birth_date || emp.maternity_leave_from;
      const matStart = matStartRaw ? new Date(matStartRaw).toISOString().slice(0, 10) : null;
      const matEnd = emp.maternity_leave_to ? new Date(emp.maternity_leave_to).toISOString().slice(0, 10) : null;
      const inMaternityWindow = (ymd) => {
        if (!matStart) return false;
        if (!emp.on_maternity_leave && !emp.gave_birth_date) return false;
        if (ymd < matStart) return false;
        if (matEnd && ymd > matEnd) return false;
        return true;
      };
      const absenceDays = isTeken
        ? commitmentInfo.absent_dates
            .filter(d => !holidayDates.has(d) && !leaveDates.has(d))
            .map(d => ({
              date: d,
              source: 'unknown',
              // Pre-selects the category in the absence dialog; the accountant
              // still confirms — we never auto-decide pay.
              suggested_category: inMaternityWindow(d)
                ? 'maternity'
                : (emp.on_pregnancy_bedrest ? 'pregnancy_bedrest' : null),
            }))
        : [];
      // Default = DEDUCT (like היעדרות שעות). An unexplained absent day is deducted
      // at the daily rate; it is NOT deducted only when given a non-deductible
      // reason (מאושר/מחלה/חופשה/מילואים) or offset against extra hours. No manager/
      // accounting approval gate — the reason itself is the decision.
      const deductibleDates = absenceDays.filter(a => {
        if (offsetAbsenceDates.has(a.date)) return false;
        const e = entryByDate.get(a.date);
        return DEDUCTIBLE_ABSENCE.has((e && e.category) || 'unpaid');
      }).map(a => a.date);
      const deductibleDays = deductibleDates.length;
      const unknownCount = absenceDays.length;
      const justifiedCount = 0;
      const absenceDeduction = Math.round(deductibleDays * dailyRate * 100) / 100;

      // RETIRED — the old beyond-commitment "תוספת שכר" supplement is disabled.
      // Extra hours above commitment are now paid via the partial-absence /
      // extra-hours mechanism (partial_extra_entries, flat × hourly value).
      const payExcessSupplement = false;
      const empResolutions = resByEmp.get(String(emp._id)) || new Map();
      let breakdown = calculateMonthlySalary(emp, empPunches, month, {
        branchAmutaMap,
        resolutions: empResolutions,
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
      // Days she actually clocked in this month — a closure she worked through
      // must not also be billed to her vacation balance.
      const workedDates = new Set((punchesByEmp.get(String(emp._id)) || [])
        .filter(p => ['auto', 'approved'].includes(p.approval_status || 'auto'))
        .map(p => ISR_DAY(p.timestamp)));
      const vacationAutoInfo = computeKindergartenVacationDays(
        kgHolidays, month, commitmentByEmp.get(String(emp._id)), statutoryHolidayDates, workedDates,
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

      // --- Employer-declared closures paid to hourly staff -----------------
      // She punched nothing that day because the gan was shut by decision, so
      // there are no hours to pay from. Credit the day at her rate — by her own
      // average working day when no fixed number is set, which is fairer to a
      // part-timer than a flat 8. This draws NO vacation day: it is the
      // employer's closure, not her leave.
      const specialDayLines = [];
      let specialDayPay = 0;
      for (const sd of empSpecialDays) {
        const applies = isTeken ? sd.pay_global : sd.pay_hourly;
        if (!applies) continue;
        const hours = isTeken
          ? 0
          : (Number(sd.hourly_hours) > 0 ? Number(sd.hourly_hours) : (Number(avgDailyHours) || 8));
        const pay = isTeken ? 0 : Math.round(hours * (Number(hourlyRate) || 0) * 100) / 100;
        specialDayPay += pay;
        specialDayLines.push({
          date: sd.date, name: sd.name, hours: Math.round(hours * 100) / 100, pay,
          basis: isTeken ? 'לא מנוכה מהשכר' : (Number(sd.hourly_hours) > 0 ? 'שעות שהוגדרו ליום' : 'ממוצע יום עבודה שלה'),
        });
      }
      if (specialDayPay) breakdown.estimated_total = (breakdown.estimated_total || 0) + specialDayPay;

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

      // --- דמי מחלה come FIRST, the completion fills what is left ----------
      //
      // For a תקן employee the completion tops her up to the full agreed salary
      // whatever caused the shortfall — including being sick. Paying sick pay
      // on top of that paid the same days twice: קרן בן שבת worked 40 of 149
      // committed hours, was topped up ₪8,017 to her full ₪11,000, and was then
      // paid a further ₪5,000 for the days that top-up had already covered.
      //
      // Suppressing the sick pay would fix the total but is the wrong way
      // round: דמי מחלה are statutory and must be PAID, and they have to appear
      // on the payslip as דמי מחלה — that is the employee's record of having
      // used them. So sick pay stands, and the completion is reduced by it. The
      // total lands on the same agreed salary; only the composition is right.
      //
      // If the statutory sick pay is larger than the gap the completion was
      // filling, the completion goes to zero and she is paid the excess: the
      // law wins over the top-up, which is what "ימי המחלה חזקים על ההשלמה"
      // means.
      const tb = breakdown.components?.teken_breakdown;
      let completionOffset = 0;
      if (isTeken && tb && tb.include_completion !== false && sickPay > 0 && (tb.completion || 0) > 0) {
        completionOffset = Math.min(tb.completion, sickPay);
        tb.completion = Math.round((tb.completion - completionOffset) * 100) / 100;
        tb.completion_reduced_by_sick = Math.round(completionOffset * 100) / 100;
        breakdown.components.base_salary =
          Math.round((Number(breakdown.components.base_salary || 0) - completionOffset) * 100) / 100;
        // pay_split decomposes base_salary — the completion it names is the one
        // just reduced, so it has to shrink with it or the parts stop summing.
        if (breakdown.components.pay_split) {
          breakdown.components.pay_split.completion =
            Math.round((Number(breakdown.components.pay_split.completion || 0) - completionOffset) * 100) / 100;
        }
        breakdown.estimated_total = Math.round((breakdown.estimated_total - completionOffset) * 100) / 100;
      }

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
      // Monthly committed vs actually worked. The net deficit that caps the
      // deduction is computed BELOW, once approved-paid extra hours are known —
      // those are excluded from the "made up on other days" pool (see there).
      const paCommittedH = Math.round((commitmentInfo.committed_hours || 0) * 100) / 100;
      const paWorkedH = Math.round((breakdown.hours?.total || 0) * 100) / 100;
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
        offset_used: offsetExtraDates.has(c.date), // consumed by an approved absence offset → not paid
      }));
      // Offset-consumed extra days are never paid (they cancelled a whole-day absence).
      const paExtraApprovedHours = Math.round(paExtraCandidates.filter(c => c.approved && !c.offset_used).reduce((s, c) => s + c.hours, 0) * 100) / 100;
      const paExtraPay = Math.round(paExtraApprovedHours * paHourlyValue * 100) / 100;

      // Net deficit EXCLUDES approved-paid extra hours from the make-up pool:
      // hours approved for payment are paid separately, so they must NOT also
      // cancel the shortfall (that would double-credit the employee). Extra hours
      // that are NOT approved still make up the shortfall (no pay, no deduction).
      const paMakeUpWorked = Math.round((paWorkedH - paExtraApprovedHours) * 100) / 100;
      const paNetDeficit = paHasCommitment ? Math.max(0, Math.round((paCommittedH - paMakeUpWorked) * 100) / 100) : 0;
      // Overtime-beyond-commitment is meaningful only for תקן — hourly staff are
      // paid per hour worked, so "extra vs commitment" is not shown for them.
      const paSurplus = (paHasCommitment && isTeken) ? Math.max(0, Math.round((paWorkedH - paCommittedH) * 100) / 100) : 0;
      const paEffectiveHours = isTeken ? Math.min(paDeductGross, paNetDeficit) : 0;
      const paDeduction = Math.round(paEffectiveHours * paHourlyValue * 100) / 100;
      const paMadeUp = isTeken && paCandidatesRaw.length > 0 && paNetDeficit <= 0;

      if (paExtraPay) breakdown.estimated_total = (breakdown.estimated_total || 0) + paExtraPay;
      if (paDeduction) breakdown.estimated_total = (breakdown.estimated_total || 0) - paDeduction;

      // Suggested whole-day-absence ↔ extra-hours offsets (day-to-day, ±1h). For
      // each missed committed day, pair an extra day of a similar size so the
      // accountant can approve cancelling them out (absence not deducted, extra
      // not paid). Already-approved offsets keep their saved pairing.
      const offHhmm = (s) => { if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return 0; const [h, m] = s.split(':').map(Number); return (h || 0) + (m || 0) / 60; };
      const offByWd = new Map((commitmentByEmp.get(String(emp._id))?.days || []).map(d => [Number(d.day), d]));
      const committedHoursForDate = (date) => {
        const cd = offByWd.get(new Date(`${date}T12:00:00Z`).getUTCDay());
        return cd && !cd.is_off ? Math.max(0, offHhmm(cd.end_hhmm) - offHhmm(cd.start_hhmm)) : 0;
      };
      const offUsedExtra = new Set(offsetExtraDates);
      const offsetSuggestions = [];
      for (const a of absenceDays) {
        const committedH = Math.round(committedHoursForDate(a.date) * 100) / 100;
        if (committedH <= 0) continue;
        const appr = offsetEntries.find(o => o.absence_date === a.date && o.approved);
        if (appr) {
          const m = paExtraCandidates.find(c => c.date === appr.extra_date);
          offsetSuggestions.push({ absence_date: a.date, committed_h: committedH, extra_date: appr.extra_date, extra_h: m ? m.hours : null, approved: true });
          continue;
        }
        const m = paExtraCandidates.find(c => !offUsedExtra.has(c.date) && Math.abs(c.hours - committedH) <= 1);
        if (m) { offUsedExtra.add(m.date); offsetSuggestions.push({ absence_date: a.date, committed_h: committedH, extra_date: m.date, extra_h: m.hours, approved: false }); }
      }

      return {
        employee_id: String(emp._id),
        full_name: emp.full_name,
        israeli_id: emp.israeli_id || '',
        employee_number: emp.employee_number || '',
        is_freelancer: !!emp.is_freelancer,
        payslip_paid: !!existingRow?.payslip_paid,            // payslip sent to employee (אושר ושולם)
        payslip_paid_at: existingRow?.payslip_paid_at || null,
        // Bank details only for accounting/admin (sensitive).
        ...(canSeeBank ? {
          bank_number: emp.bank_number || '',
          bank_branch: emp.bank_branch || '',
          bank_account: emp.bank_account || '',
          bank_account_holder: emp.bank_account_holder || '',
          pension_fund: emp.pension_fund || '',
          education_fund: emp.education_fund || '',
        } : {}),
        branch_id: String(emp.branch_id),
        branch_name: branchNameById.get(String(emp.branch_id)) || '',
        position: emp.position || '',
        permanent_note: emp.permanent_note || '',
        is_active: emp.is_active !== false,
        inactive_reason: emp.inactive_reason || '',
        // Uploaded files awaiting the accountant's acknowledgement.
        pending_docs: pendingDocsByEmp.get(String(emp._id)) || [],
        docs_total: docsTotalByEmp.get(String(emp._id)) || 0,
        // Days with MORE THAN TWO punches — every one needs an accountant/admin
        // decision on how to pair them. Unresolved days are billed provisionally
        // (first→last span) and flagged red until approved.
        punch_review: (() => {
          const byDate = new Map();
          for (const p of empPunches) {
            const s = p.approval_status || 'auto';
            if (s !== 'auto' && s !== 'approved') continue;
            const d = ISR_DAY(p.timestamp);
            if (d.slice(0, 7) !== month) continue;
            if (!byDate.has(d)) byDate.set(d, []);
            byDate.get(d).push(p);
          }
          const out = [];
          for (const [date, list] of [...byDate.entries()].sort()) {
            if (list.length <= 2) continue;
            const res = empResolutions.get(date);
            const sortedList = list.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            const suggestion = suggestPunchLabels(sortedList);
            const suggestedRole = new Map(suggestion.labels.map(l => [l.punch_id, l.role]));
            out.push({
              date,
              punches: sortedList.map(p => ({
                id: String(p._id),
                hhmm: ISR_HHMM(p.timestamp),
                is_manual: p.timestamp_source === 'manual',
                role: res ? (res.labels || []).find(l => String(l.punch_id) === String(p._id))?.role || 'ignore' : null,
                suggested_role: suggestedRole.get(String(p._id)) || 'ignore',
              })),
              suggestion_reason: suggestion.reason,
              status: res ? 'approved' : 'pending',
              minutes: res ? res.minutes : null,
            });
          }
          return out;
        })(),
        // Pregnancy status for the accountant-facing badge (display/alert only —
        // no pay effect). `protected` = pregnant with ≥6 months seniority, when
        // §9 חוק עבודת נשים bars unilateral pay/scope cuts without a permit.
        pregnancy: (() => {
          const seniorityMonths = emp.start_date
            ? (monthEnd.getFullYear() - new Date(emp.start_date).getFullYear()) * 12
              + (monthEnd.getMonth() - new Date(emp.start_date).getMonth())
            : null;
          const active = !!emp.is_pregnant || !!emp.on_maternity_leave || !!emp.on_pregnancy_bedrest;
          return active ? {
            is_pregnant: !!emp.is_pregnant,
            on_maternity_leave: !!emp.on_maternity_leave,
            on_pregnancy_bedrest: !!emp.on_pregnancy_bedrest,
            due_date: emp.due_date || null,
            gave_birth_date: emp.gave_birth_date || null,
            protected: !!emp.is_pregnant && seniorityMonths != null && seniorityMonths >= 6,
          } : null;
        })(),
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
          travel_note: manual.travel_note || '',
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
          deductible_dates: deductibleDates,         // ymd[] of the days being deducted
          unknown_count: unknownCount,               // days needing the manager's reason
          justified_count: justifiedCount,           // holiday / approved-leave days
          offset_suggestions: offsetSuggestions,     // [{absence_date, committed_h, extra_date, extra_h, approved}]
          offset_entries: offsetEntries,             // saved offset decisions
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
          const hasSchedule = (l) => Array.isArray(l.payments) && l.payments.length > 0;
          // This month's scheduled deduction (per-month payments[] is the source of
          // truth; legacy loans fall back to the count-based rule).
          const monthAmt = (l) => {
            if (hasSchedule(l)) { const p = l.payments.find(x => x.month === month); return p ? Math.max(0, Number(p.amount) || 0) : 0; }
            if ((l.installments_paid || 0) >= (l.installments_total || 0)) return 0;
            return Math.max(0, Number(l.installment_amount) || 0);
          };
          const deductedThrough = (l) => hasSchedule(l)
            ? l.payments.filter(p => p.month <= month).reduce((s, p) => s + (Number(p.amount) || 0), 0)
            : (Number(l.installments_paid) || 0) * (Number(l.installment_amount) || 0);
          const monthDeduction = list.reduce((s, l) => s + monthAmt(l), 0);
          return {
            count: list.filter(l => ((Number(l.total_amount) || 0) - deductedThrough(l)) > 0).length,
            month_deduction: Math.round(monthDeduction * 100) / 100,
            loans: list.map(l => {
              const total = Number(l.total_amount) || 0;
              const ded = deductedThrough(l);
              const sched = hasSchedule(l);
              const p = sched ? l.payments.find(x => x.month === month) : null;
              // month-aware installment number: how many paying installments through THIS month
              const payingTotal = sched
                ? l.payments.filter(x => (Number(x.amount) || 0) > 0).length
                : (Number(l.installments_total) || 0);
              const idxThrough = sched
                ? l.payments.filter(x => x.month <= month && (Number(x.amount) || 0) > 0).length
                : Math.min(Number(l.installments_paid) || 0, Number(l.installments_total) || 0);
              return {
                id: String(l._id),
                total_amount: total,
                installment_amount: l.installment_amount,
                installments_total: l.installments_total,
                installments_paid: l.installments_paid || 0,
                start_month: l.start_month || '',
                started_at: l.started_at || null,
                notes: l.notes || '',
                payments: sched ? l.payments.map(x => ({ month: x.month, amount: Number(x.amount) || 0, paused: !!x.paused })) : [],
                installment_index: idxThrough,        // which paying installment this month is (month-aware)
                paying_installments: payingTotal,      // denominator for "X of Y"
                month_amount: Math.round(monthAmt(l) * 100) / 100,   // this month's deduction
                deducted_through: Math.round(ded * 100) / 100,
                remaining: Math.round(Math.max(0, total - ded) * 100) / 100,
                paused: !!(p && p.paused),                            // this month is a paused (skipped) month
                active: (total - ded) > 0,
              };
            }),
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
          // Closures she worked through: paid as ordinary hours, NOT drawn from
          // her balance, and surfaced so the month shows she came in on a day
          // the gan was listed as shut.
          worked_on_holiday: vacationAutoInfo.worked_on_holiday,
        },
        vacation_pay: vacationPay,        // paid for hourly (0 for תקן — covered by salary)
        special_days: { pay: specialDayPay, lines: specialDayLines },
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
          // How much of the salary completion this sick pay replaced — the
          // accountant needs to see that the two are linked, not additive.
          completion_offset: Math.round(completionOffset * 100) / 100,
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

    // The same totals, split per branch and kept, so that anybody above a
    // branch can be answered by addition instead of by this computation.
    //
    // Written from `rows` rather than recomputed: a district that disagrees
    // with the branches under it is a wrong number nobody can explain, and two
    // implementations of Israeli payroll maths kept in step by hand is how that
    // happens. Whoever opens a branch pays for it once and everybody above them
    // reads the result.
    //
    // Deliberately not awaited. This is a cache for somebody else's screen; it
    // must never be the reason the branch screen is slower or fails.
    try {
      const perBranch = new Map();
      for (const r of rows) {
        const bid = r.branch_id;
        if (!bid) continue;
        const t = perBranch.get(bid) || { employees: 0, hours: 0, base: 0 };
        t.employees += 1;
        t.hours += r.breakdown?.hours?.total || 0;
        t.base += r.breakdown?.components?.base_salary || 0;
        perBranch.set(bid, t);
      }
      if (perBranch.size) {
        PayrollRollup.bulkWrite([...perBranch].map(([bid, t]) => ({
          updateOne: {
            filter: { month, branch_id: bid },
            update: { $set: { ...t, computed_at: new Date() } },
            upsert: true,
          },
        })), { ordered: false }).catch(() => {});
      }
    } catch { /* a stale rollup is worse than none, but neither is worth a 500 */ }

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
      'travel_override', 'travel_note', 'bonus', 'notes', 'custom_values',
      'include_salary_completion',
      'supplement_manager_approved', 'supplement_accounting_approved',
      'vacation_pay_confirmed',
      'absence_entries', 'partial_absence_entries', 'partial_extra_entries',
      'absence_offset_entries',
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
      // Paying vacation without remaining balance is a deliberate accounting
      // decision — no one else may flip it.
      if (k === 'vacation_pay_confirmed' && !canSetAccountingApproval) {
        return res.status(403).json({ error: 'רק הנהלת חשבונות יכולה לאשר תשלום חופשה ללא יתרה' });
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

/** Does this user get the final word, or does their entry wait for review? */
function decidesPayroll(user) {
  return user?.role === 'system_admin' || user?.role === 'accountant';
}

/** The branches a non-accountant user is allowed to touch. */
function managedBranchIds(user) {
  const managed = (user?.managed_branch_ids || []).map(String);
  const fallback = user?.branch_id ? [String(user.branch_id)] : [];
  return managed.length > 0 ? managed : fallback;
}

/**
 * GET /payroll-month/adjustments
 *
 * A branch manager sees her own branches only — including her PENDING rows,
 * which is the point: she has to be able to watch what she filed move.
 * `status=pending` is what the accountant's review queue asks for.
 */
async function listAdjustments(req, res, next) {
  try {
    const { month, employee_id, branch, status } = req.query;
    const filter = {};
    // 'rejected' is excluded unless asked for by name — a refused row should
    // not quietly reappear in the month's list.
    if (status && status !== 'all') filter.status = status;
    else filter.status = { $ne: 'rejected' };
    if (month) filter.month = month;
    if (employee_id) filter.employee_id = employee_id;
    if (branch && branch !== 'all') filter.branch_id = branch;

    if (!decidesPayroll(req.user)) {
      const allowed = managedBranchIds(req.user);
      if (filter.branch_id && !allowed.includes(String(filter.branch_id))) {
        return res.json({ adjustments: [] });
      }
      if (!filter.branch_id) filter.branch_id = { $in: allowed };
    }

    const list = await SalaryAdjustment.find(filter)
      .populate('employee_id', 'full_name israeli_id')
      .populate('branch_id', 'name')
      .populate('created_by', 'full_name')
      .populate('decided_by', 'full_name')
      .sort({ created_at: -1 })
      .lean();
    res.json({
      adjustments: list.map(a => ({
        ...a,
        id: String(a._id),
        employee_name: a.employee_id?.full_name || '',
        branch_name: a.branch_id?.name || '',
        created_by_name: a.created_by?.full_name || '',
        decided_by_name: a.decided_by?.full_name || '',
      })),
      pending_count: await SalaryAdjustment.countDocuments(
        decidesPayroll(req.user)
          ? { status: 'pending', ...(month ? { month } : {}) }
          : { status: 'pending', branch_id: { $in: managedBranchIds(req.user) }, ...(month ? { month } : {}) },
      ),
    });
  } catch (err) { next(err); }
}

/**
 * POST /payroll-month/adjustments
 *
 * A branch manager may file anything here for her own staff. What she files is
 * `pending` and stays out of the salary until an accountant approves it — she
 * is never blocked from recording something, and never able to change what the
 * month pays on her own.
 */
async function createAdjustment(req, res, next) {
  try {
    const { employee_id, month, type, amount, hours, reason } = req.body;
    if (!employee_id || !month || !type) {
      return res.status(400).json({ error: 'employee_id, month, type are required' });
    }
    const emp = await Employee.findById(employee_id).select('branch_id full_name').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const isFinal = decidesPayroll(req.user);
    if (!isFinal) {
      const allowed = managedBranchIds(req.user);
      if (!allowed.includes(String(emp.branch_id))) {
        return res.status(403).json({ error: 'ניתן להוסיף עדכוני שכר רק לעובדי הסניפים שבניהולך' });
      }
    }

    const adj = await SalaryAdjustment.create({
      employee_id,
      branch_id: emp.branch_id,
      month,
      type,
      amount: Number(amount) || 0,
      hours: Number(hours) || 0,
      reason: reason || '',
      created_by: req.user.id,
      created_by_role: req.user.role || '',
      status: isFinal ? 'approved' : 'pending',
      decided_by: isFinal ? req.user.id : null,
      decided_at: isFinal ? new Date() : null,
    });
    // An accountant's own entry is approved on the spot, so it lands in its
    // column on the spot too — the same path a manager's takes on approval.
    let applied = null;
    if (isFinal) {
      try { applied = await applyApprovedAdjustment(adj); }
      catch (e) { console.error('applyApprovedAdjustment failed:', e.message); }
    }

    res.json({
      adjustment: { ...adj.toObject(), id: String(adj._id) },
      pending: !isFinal,
      applied,
    });
  } catch (err) { next(err); }
}

/**
 * Where an approved adjustment lands in the salary table.
 *
 * Approving used to change nothing at all. `adj_totals` was computed, shipped
 * to the client and rendered in its own column — and never added to
 * `estimated_total`. Every bonus, reimbursement and loan ever entered was
 * decoration: not in the month's total, not in the accountant's PDF. The row
 * has to land in the column that already knows how to pay it.
 *
 *   תוספת כספית / החזר קניות / אחר → בונוס
 *   ניכוי כספי                      → בונוס שלילי (there is no deductions column)
 *   תוספת נסיעות                    → נסיעות, on top of what the month already pays
 *   בקשת מקדמה                      → קיזוז מקדמה (a directive, as it is today)
 *   בקשת הלוואה                     → Employee.loans[], which is what the הלוואות column reads
 *
 * Hours types are deliberately absent: hours come from the clock, so an hours
 * correction is a punch correction, and those already reach the accountant as
 * "בעיות בהחתמה". Legacy hours rows keep showing in the adjustments column and
 * move no money — the same as before, and now honestly so.
 */
const BONUS_TYPES = new Set(['money_add', 'purchase_reimburse', 'other']);

async function applyApprovedAdjustment(adj, cache = {}) {
  const month = adj.month;
  const employeeId = adj.employee_id;
  const amount = Number(adj.amount) || 0;
  const reason = (adj.reason || '').trim();

  const stamp = (base, line) => [base, line].filter(Boolean).join(' · ').slice(0, 500);

  if (BONUS_TYPES.has(adj.type) || adj.type === 'money_deduct') {
    // A deduction is a negative bonus: the column already adds its value to the
    // total, so a negative one subtracts. There is no deductions column to use.
    const delta = adj.type === 'money_deduct' ? -Math.abs(amount) : amount;
    const row = await PayrollMonth.findOne({ employee_id: employeeId, month }).select('manual.bonus').lean();
    const prev = row?.manual?.bonus || {};
    const base = prev.override_amount != null ? Number(prev.override_amount) : 0;
    await PayrollMonth.findOneAndUpdate(
      { employee_id: employeeId, month },
      {
        $set: {
          'manual.bonus.override_amount': Math.round((base + delta) * 100) / 100,
          'manual.bonus.note': stamp(prev.note, reason || 'עדכון שכר מאושר'),
          'manual.bonus.disabled': false,
        },
      },
      { upsert: true },
    );
    return { field: 'bonus', delta };
  }

  if (adj.type === 'travel_add') {
    // travel_override is absolute, so the addition has to sit on top of what
    // the month would otherwise pay — not replace it.
    const row = await PayrollMonth.findOne({ employee_id: employeeId, month }).select('manual.travel_override').lean();
    let base = row?.manual?.travel_override;
    if (base == null) {
      if (cache.autoTravel === undefined) {
        const emp = await Employee.findById(employeeId).select('branch_id').lean();
        const data = await fetchMonthData({ month, branch: String(emp?.branch_id || '') }, { role: 'system_admin' });
        const r = (data.rows || []).find(x => String(x.employee_id) === String(employeeId));
        cache.autoTravel = r?.breakdown?.components?.travel ?? 0;
      }
      base = cache.autoTravel;
    }
    await PayrollMonth.findOneAndUpdate(
      { employee_id: employeeId, month },
      { $set: { 'manual.travel_override': Math.round((Number(base) + amount) * 100) / 100 } },
      { upsert: true },
    );
    return { field: 'travel_override', delta: amount };
  }

  if (adj.type === 'advance_request') {
    const row = await PayrollMonth.findOne({ employee_id: employeeId, month }).select('manual.advance_deduction_text').lean();
    const line = `מקדמה ₪${Math.abs(amount).toLocaleString('he-IL')}${reason ? ` — ${reason}` : ''}`;
    await PayrollMonth.findOneAndUpdate(
      { employee_id: employeeId, month },
      { $set: { 'manual.advance_deduction_text': stamp(row?.manual?.advance_deduction_text, line) } },
      { upsert: true },
    );
    return { field: 'advance_deduction_text', delta: 0 };
  }

  if (adj.type === 'loan_request') {
    // The הלוואות column reads Employee.loans[]. A single-instalment loan
    // starting this month is the honest translation of "advance me X" — the
    // accountant re-spreads it if it was meant to be paid over months.
    const total = Math.abs(amount);
    if (total > 0) {
      await Employee.findByIdAndUpdate(employeeId, {
        $push: {
          loans: {
            total_amount: total,
            installment_amount: total,
            installments_total: 1,
            start_month: month,
            payments: [{ month, amount: total, paused: false }],
            started_at: new Date(),
            notes: stamp('נוצר מאישור עדכון שכר', reason),
          },
        },
      });
    }
    return { field: 'loans', delta: total };
  }

  // Hours types (and anything new) move no money on their own.
  return { field: null, delta: 0 };
}

/**
 * POST /payroll-month/adjustments/:id/decide   { approve: bool, note?: string }
 *
 * The accountant's answer. Approving is what puts the row into the salary;
 * rejecting keeps it on the record with a reason rather than deleting it, so
 * the manager sees what happened to what she filed instead of watching it
 * vanish.
 */
async function decideAdjustment(req, res, next) {
  try {
    const adj = await SalaryAdjustment.findById(req.params.id);
    if (!adj) return res.status(404).json({ error: 'עדכון לא נמצא' });

    const approve = req.body?.approve !== false;
    const wasPending = adj.status === 'pending';
    adj.status = approve ? 'approved' : 'rejected';
    adj.decided_by = req.user.id;
    adj.decided_at = new Date();
    adj.decided_note = String(req.body?.note || '').slice(0, 500);
    await adj.save();

    // Approving is what moves the money. Guarded on `wasPending` so approving
    // an already-approved row twice cannot add the same bonus twice.
    let applied = null;
    if (approve && wasPending) {
      try { applied = await applyApprovedAdjustment(adj); }
      catch (e) { console.error('applyApprovedAdjustment failed:', e.message); }
    }

    res.json({ adjustment: { ...adj.toObject(), id: String(adj._id) }, applied });
  } catch (err) { next(err); }
}

/**
 * POST /payroll-month/adjustments/decide-bulk   { ids: [], approve, note? }
 * A month's queue is approved in one pass far more often than one row at a time.
 */
async function decideAdjustmentsBulk(req, res, next) {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ error: 'לא נבחרו עדכונים' });
    const approve = req.body?.approve !== false;
    // Read the rows BEFORE flipping them: only the ones that were actually
    // pending may move money, and after updateMany that is no longer knowable.
    const pending = await SalaryAdjustment.find({ _id: { $in: ids }, status: 'pending' }).lean();

    const result = await SalaryAdjustment.updateMany(
      { _id: { $in: ids }, status: 'pending' },
      {
        $set: {
          status: approve ? 'approved' : 'rejected',
          decided_by: req.user.id,
          decided_at: new Date(),
          decided_note: String(req.body?.note || '').slice(0, 500),
        },
      },
    );

    let applied = 0;
    if (approve) {
      // One cache per employee+month, so a month's travel is computed once
      // rather than once per row.
      const caches = new Map();
      for (const adj of pending) {
        const key = `${adj.employee_id}|${adj.month}`;
        if (!caches.has(key)) caches.set(key, {});
        try { await applyApprovedAdjustment(adj, caches.get(key)); applied += 1; }
        catch (e) { console.error('applyApprovedAdjustment failed:', e.message); }
      }
    }
    res.json({ ok: true, decided: result.modifiedCount || 0, applied });
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

    // Enforce per-user branch scope on the employee lookup.
    const role = req.user?.role;
    const branchFilter = {};
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      branchFilter.branch_id = { $in: managed.length > 0 ? managed : fallback };
    }

    let result;
    try {
      // Same code path as the scheduled mailbox import — see services/cibusImport.js.
      result = await applyCibusReport(req.file.buffer, req.file.originalname, month, { branchFilter });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'שגיאה בקריאת קובץ סיבוס' });
    }
    res.json(result);
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

/**
 * GET /payroll-month/my-updates?month=YYYY-MM[&branch=<id>]
 *
 * The branch manager's own view: her staff, and only what she is allowed to
 * file about them.
 *
 * She used to reach all of this through the monthly salary table, which meant
 * that to add one bonus she was looking at everybody's rate, everybody's
 * global salary and everybody's net — none of which is hers to see, and none
 * of which she needs. This returns names, the updates already filed, the
 * handful of salary-table fields she may request a change to, and their
 * current values. No rates, no totals, no net.
 *
 * Accountants and admins get the same shape for whichever branch they ask
 * about, so the screen is one screen rather than two.
 */
async function myPayrollUpdates(req, res, next) {
  try {
    const month = (req.query.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'נדרש חודש (YYYY-MM)' });

    const isFinal = decidesPayroll(req.user);
    const empFilter = { is_active: true };
    if (req.query.branch && req.query.branch !== 'all') empFilter.branch_id = req.query.branch;
    if (!isFinal) {
      const allowed = managedBranchIds(req.user);
      // "No branches assigned" and "no employees in your branches" look the
      // same on screen and have completely different fixes, so say which.
      if (allowed.length === 0) {
        return res.json({ month, employees: [], branches: [], scope_branch_count: 0 });
      }
      if (empFilter.branch_id && !allowed.includes(String(empFilter.branch_id))) {
        return res.json({
          month, employees: [], branches: [],
          scope_branch_count: allowed.length,
          out_of_scope_branch: true,
        });
      }
      if (!empFilter.branch_id) empFilter.branch_id = { $in: allowed };
    }

    const employees = await Employee.find(empFilter)
      .populate('branch_id', 'name')
      .select('full_name branch_id israeli_id')
      .sort({ full_name: 1 })
      .lean();
    const empIds = employees.map(e => e._id);

    const [adjustments, rows, changeRequests] = await Promise.all([
      SalaryAdjustment.find({ employee_id: { $in: empIds }, month })
        .populate('created_by', 'full_name')
        .populate('decided_by', 'full_name')
        .sort({ created_at: -1 })
        .lean(),
      // Only the manual fields she may request; the rest of the row stays here.
      PayrollMonth.find({ employee_id: { $in: empIds }, month }).select('employee_id manual').lean(),
      PayrollChangeRequest.find({ month, status: 'pending', 'changes.employee_id': { $in: empIds } })
        .select('changes requested_by_name created_at status')
        .lean(),
    ]);

    const adjByEmp = new Map();
    for (const a of adjustments) {
      const k = String(a.employee_id);
      if (!adjByEmp.has(k)) adjByEmp.set(k, []);
      adjByEmp.get(k).push({
        id: String(a._id),
        type: a.type,
        amount: a.amount,
        hours: a.hours,
        reason: a.reason,
        status: a.status,
        created_by_name: a.created_by?.full_name || '',
        created_by_role: a.created_by_role || '',
        decided_by_name: a.decided_by?.full_name || '',
        decided_note: a.decided_note || '',
        created_at: a.created_at,
      });
    }

    const rowByEmp = new Map(rows.map(r => [String(r.employee_id), r.manual || {}]));

    // Field changes already awaiting a decision, so the manager doesn't file
    // the same one twice while the first is still in the queue.
    const pendingFieldsByEmp = new Map();
    for (const cr of changeRequests) {
      for (const ch of cr.changes || []) {
        const k = String(ch.employee_id);
        if (!pendingFieldsByEmp.has(k)) pendingFieldsByEmp.set(k, []);
        pendingFieldsByEmp.get(k).push({
          field: ch.field,
          field_label: ch.field_label || ch.field,
          requested_value: ch.requested_value,
          requested_by_name: cr.requested_by_name || '',
          created_at: cr.created_at,
        });
      }
    }

    const branches = [...new Map(employees
      .filter(e => e.branch_id)
      .map(e => [String(e.branch_id._id || e.branch_id), {
        id: String(e.branch_id._id || e.branch_id),
        name: e.branch_id.name || '',
      }])).values()];

    res.json({
      month,
      can_decide: isFinal,
      branches,
      scope_branch_count: isFinal ? null : managedBranchIds(req.user).length,
      // The salary-table fields a manager may ask to change, with the labels
      // the screen shows. Kept server-side so the two lists cannot drift.
      requestable_fields: MANAGER_REQUESTABLE_FIELDS,
      leave_kinds: MANAGER_LEAVE_KINDS,
      employees: employees.map(e => {
        const manual = rowByEmp.get(String(e._id)) || {};
        const mine = adjByEmp.get(String(e._id)) || [];
        return {
          employee_id: String(e._id),
          full_name: e.full_name,
          branch_id: String(e.branch_id?._id || e.branch_id || ''),
          branch_name: e.branch_id?.name || '',
          adjustments: mine,
          pending_count: mine.filter(a => a.status === 'pending').length,
          field_values: Object.fromEntries(
            MANAGER_REQUESTABLE_FIELDS.map(f => [f.field, manual[f.field] ?? null]),
          ),
          pending_fields: pendingFieldsByEmp.get(String(e._id)) || [],
        };
      }),
    });
  } catch (err) { next(err); }
}

/**
 * GET /payroll-month/my-updates/absences?month=YYYY-MM&employee_id=…
 *
 * One employee's absence days for the month, so a manager can say what each
 * one was before the accountant decides whether it costs anything.
 *
 * Whole-day absences and partial ones (showed up, left more than an hour
 * short) are different records with different consequences, so both are
 * returned and labelled rather than folded together. The decisions themselves
 * are written back through PATCH /payroll-month/:employeeId, which already
 * merges each role into its OWN approval flag — a manager cannot set the
 * accounting side and vice versa.
 *
 * Loaded on demand rather than with the employee list: it recomputes the
 * month, which is the expensive part of payroll.
 */
async function myUpdateAbsences(req, res, next) {
  try {
    const month = (req.query.month || '').trim();
    const employeeId = String(req.query.employee_id || '');
    if (!/^\d{4}-\d{2}$/.test(month) || !employeeId) {
      return res.status(400).json({ error: 'נדרשים חודש ומזהה עובד' });
    }

    const emp = await Employee.findById(employeeId).select('branch_id full_name').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });
    if (!decidesPayroll(req.user)) {
      const allowed = managedBranchIds(req.user);
      if (!allowed.includes(String(emp.branch_id))) {
        return res.status(403).json({ error: 'העובד/ת אינו/ה בסניפים שבניהולך' });
      }
    }

    const data = await fetchMonthData({ month, branch: String(emp.branch_id || '') }, req.user);
    const row = (data.rows || []).find(r => String(r.employee_id) === employeeId);
    if (!row) return res.json({ month, employee_id: employeeId, absences: [], partial: [] });

    const abs = row.absence || {};
    const entryByDate = new Map((abs.entries || []).map(e => [e.date, e]));

    res.json({
      month,
      employee_id: employeeId,
      employee_name: emp.full_name,
      // `source` says why the day is on the list: a known leave, a kindergarten
      // holiday, or nothing the system can explain — the last is the only kind
      // that actually needs the manager to say what happened.
      absences: (abs.days || []).map((d) => {
        const e = entryByDate.get(d.date) || {};
        return {
          date: d.date,
          source: d.source || 'unknown',
          category: e.category || 'unpaid',
          note: e.note || '',
          manager_approved: !!e.manager_approved,
          accounting_approved: !!e.accounting_approved,
        };
      }),
      partial: (row.partial_absence?.candidates || []).map(c => ({
        date: c.date,
        committed_hours: c.committed_h ?? null,
        worked_hours: c.worked_h ?? null,
        shortfall_hours: c.shortfall_h ?? null,
        excused: !!c.excused,
        reason: c.reason || '',
      })),
    });
  } catch (err) { next(err); }
}

/**
 * GET /payroll-month/my-updates/punches?month=YYYY-MM&employee_id=…
 *
 * One employee's clock days for the month, with the problems marked.
 *
 * This replaces "תיקון דיווח שעות" as an adjustment type. Hours come from the
 * clock, so a number typed into a form was never the fix — it hid the missing
 * punch instead of correcting it, and the accountant got a figure with no way
 * to check it. The manager sees the actual days here; a correction goes in as a
 * punch, which already arrives at the accountant as a pending clock issue.
 */
async function myUpdatePunches(req, res, next) {
  const IL = 'Asia/Jerusalem';
  const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: IL }).format(d);
  const timeHHMM = (d) => new Intl.DateTimeFormat('he-IL', {
    timeZone: IL, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  try {
    const month = (req.query.month || '').trim();
    const employeeId = String(req.query.employee_id || '');
    if (!/^\d{4}-\d{2}$/.test(month) || !employeeId) {
      return res.status(400).json({ error: 'נדרשים חודש ומזהה עובד' });
    }

    const emp = await Employee.findById(employeeId).select('branch_id full_name').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });
    if (!decidesPayroll(req.user)) {
      const allowed = managedBranchIds(req.user);
      if (!allowed.includes(String(emp.branch_id))) {
        return res.status(403).json({ error: 'העובד/ת אינו/ה בסניפים שבניהולך' });
      }
    }

    const [y, m] = month.split('-').map(Number);
    // The window is widened by three hours on each side because a punch is
    // stored in UTC and read in Israel time — a 23:xx punch on the 1st belongs
    // to the month, and a 00:xx punch on the 1st of next month does not.
    const from = new Date(Date.UTC(y, m - 1, 1) - 3 * 3600 * 1000);
    const to = new Date(Date.UTC(y, m, 2));

    const punches = await Punch.find({
      employee_id: employeeId,
      timestamp: { $gte: from, $lt: to },
      ignored: { $ne: true },
    }).sort({ timestamp: 1 }).lean();

    const branchNames = new Map(
      (await Branch.find({ _id: { $in: [...new Set(punches.map(p => String(p.branch_id)))] } })
        .select('name').lean()).map(b => [String(b._id), b.name]),
    );

    const PENDING = new Set(['pending', 'pending_manager', 'pending_accountant']);
    const byDate = new Map();
    for (const p of punches) {
      const key = dayKey(new Date(p.timestamp));
      if (!byDate.has(key)) {
        byDate.set(key, {
          date: key, times: [], punches: [], branches: new Set(), pending: false, stage: null,
        });
      }
      const day = byDate.get(key);
      day.times.push(timeHHMM(new Date(p.timestamp)));
      // The individual records, so the screen can offer to change or remove
      // one rather than only to complete a day. A time is not editable without
      // knowing which of the day's punches it belongs to.
      day.punches.push({
        id: String(p._id),
        time: timeHHMM(new Date(p.timestamp)),
        source: p.timestamp_source,
        status: p.approval_status,
        counts: ['auto', 'approved'].includes(p.approval_status),
        // A change already asked for and not yet decided — shown beside the
        // current time so the manager does not ask for it twice.
        pending_time: p.pending_edit?.timestamp ? timeHHMM(new Date(p.pending_edit.timestamp)) : null,
      });
      day.branches.add(branchNames.get(String(p.branch_id)) || '');
      if (PENDING.has(p.approval_status)) {
        day.pending = true;
        day.stage = p.approval_status === 'pending_accountant' ? 'accountant' : 'manager';
      }
    }

    const days = [...byDate.values()].map((d) => {
      // Three problems, three different fixes: a lone punch needs the missing
      // side, an odd count above two means somebody punched in or out twice,
      // and a day already waiting on a decision must not be "fixed" again.
      const incomplete = d.times.length === 1;
      const tooMany = d.times.length > 2;
      return {
        date: d.date,
        times: d.times,
        punches: d.punches,
        in_time: d.times[0] || null,
        out_time: d.times.length >= 2 ? d.times[d.times.length - 1] : null,
        branch: [...d.branches].filter(Boolean).join(' + '),
        pending_approval: d.pending,
        approval_stage: d.stage,
        incomplete,
        too_many: tooMany,
        has_problem: incomplete || tooMany,
      };
    }).sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      month,
      employee_id: employeeId,
      employee_name: emp.full_name,
      home_branch_id: String(emp.branch_id || ''),
      days,
      problem_count: days.filter(d => d.has_problem).length,
      pending_count: days.filter(d => d.pending_approval).length,
    });
  } catch (err) { next(err); }
}

// ── Payroll change requests (branch-manager → accountant approval) ──────

/**
 * The salary-table fields a branch manager may request a change to, and how
 * they are entered. A subset of CHANGE_ALLOWED_FIELDS: the ones that describe
 * something the branch actually knows about — a gift card handed out, days of
 * reserve duty — rather than an accounting decision.
 */
const MANAGER_REQUESTABLE_FIELDS = [
  // `input` is what the screen renders. It is NOT the same as the stored type:
  // גיפט קארד holds a number and a reason in one numberOrText value, and
  // מילואים holds a day count with the dates written into its text — so the
  // accountant sees the dates behind the number instead of a bare figure.
  { field: 'gift_card', label: 'גיפט קארד', kind: 'number_or_text', input: 'amount_reason' },
  { field: 'miluim', label: 'מילואים', kind: 'number_or_text', input: 'date_range' },
  { field: 'recreation', label: 'דמי הבראה', kind: 'number_or_text', input: 'text' },
  { field: 'cibus', label: 'סיבוס', kind: 'number_or_text', input: 'text' },
  // The manager writes prose; the accountant turns it into the figure.
  // travel_override itself stays a Number the salary engine reads directly —
  // prose in THAT field would silently zero the travel component.
  { field: 'travel_note', label: 'נסיעות', kind: 'text', input: 'text' },
  { field: 'notes', label: 'הערות נוספות', kind: 'text', input: 'text' },
];

/**
 * The leave surfaces a manager files through instead of a change request.
 *
 * ימי מחלה / ימי חופשה are EmployeeRequests: they carry dates, a certificate,
 * and an approval chain that already ends at the accountant and already
 * applies itself to payroll on approval. Writing the day COUNT straight into
 * the salary table would skip all of that and lose the dates.
 *
 * ימי היעדרות are per-day decisions on PayrollMonth.manual.absence_entries,
 * where manager and accounting each hold their own approval flag.
 */
const MANAGER_LEAVE_KINDS = [
  { kind: 'sick', label: 'ימי מחלה', needs_certificate: true },
  { kind: 'vacation', label: 'ימי חופשה', needs_certificate: false },
  { kind: 'absence', label: 'ימי היעדרות', needs_certificate: false },
];

const CHANGE_ALLOWED_FIELDS = [
  'sick_days', 'absence_days', 'vacation_days', 'holiday_pay',
  'advance_deduction_preset_id', 'advance_deduction_text',
  'gift_card', 'recreation', 'cibus', 'miluim',
  'travel_override', 'travel_note', 'notes', 'custom_values', 'include_salary_completion',
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

    // A manager files for her own staff. The route let any authenticated
    // manager name any employee_id, which the review screen would then show as
    // a request from the wrong branch about someone she has never met.
    if (!decidesPayroll(req.user)) {
      const allowed = managedBranchIds(req.user);
      const outsider = emps.find(e => !allowed.includes(String(e.branch_id?._id || e.branch_id)));
      if (outsider) {
        return res.status(403).json({ error: `ניתן לבקש שינוי רק לעובדי הסניפים שבניהולך (${outsider.full_name})` });
      }
    }

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
/** "יום חופשה אחד" / "חצי יום חופשה" / "3 ימי חופשה" — the note is read by a
 *  person, and "1 ימי חופשה" reads as a bug in the report. */
function vacDaysText(n) {
  if (n === 0.5) return 'חצי יום חופשה';
  if (n === 1) return 'יום חופשה אחד';
  return `${n} ימי חופשה`;
}

function buildAccountantHtml(month, rows, branchNameById = new Map()) {
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
    // Extra-hours-beyond-commitment shown in HOURS (not ₪); the salary total
    // already carries the pay. Commitment hours are shown per teken employee.
    const paExtraHrs = r.partial_absence?.extra_approved_hours || 0;
    const commitHrs = tb?.required_hours || r.partial_absence?.committed_hours || 0;
    const totalDed = (d.loans || 0) + (d.absence || 0) + paDed;
    // Absence deductions in the accountant PDF show the QUANTITY to offset — total
    // days (whole-day) / total hours (hourly) — NOT the ₪ amount (the accountant
    // applies the rate themselves). The specific dates are listed underneath.
    const ddmm = (ymd) => { const p = String(ymd).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}` : ymd; };
    const subLine = (s) => `<div style="font-size:8px;color:#64748b;font-weight:600;margin-top:1px">${s}</div>`;
    const absDates = r.absence?.deductible_dates || [];
    const absDays = r.absence?.deductible_days || 0;
    const absVal = absDays > 0
      ? `${absDays} ${absDays === 1 ? 'יום' : 'ימים'}` + (absDates.length ? subLine(absDates.map(ddmm).join(' · ')) : '')
      : '';
    // Partial-absence (hourly): total HOURS to offset (effective, after excused +
    // made-up cap), with the unexcused short days + hours listed underneath.
    const paDedDays = (r.partial_absence?.candidates || []).filter(c => !c.excused);
    const paEffHours = r.partial_absence?.effective_hours || 0;
    const paDedVal = paEffHours > 0
      ? `${n1(paEffHours)} ש׳` + (paDedDays.length ? subLine(paDedDays.map(c => `${ddmm(c.date)}(${n1(c.shortfall_h)}ש)`).join(' · ')) : '')
      : '';
    const advance = r.manual?.advance_deduction_preset?.label || r.manual?.advance_deduction_text || '';
    const rateCell = isGlobal
      ? cell('שכר תקן' + (r.salary_is_net ? ' (נטו)' : ''), b.rates?.global_salary ? f(b.rates.global_salary) : '')
      : cell('תעריף שעה', b.rates?.hourly_rate ? f(b.rates.hourly_rate) : '');
    const notes = [r.permanent_note, r.manual?.notes].filter(Boolean).join(' · ');
    const bank = [r.bank_number, r.bank_branch, r.bank_account].some(Boolean);
    // Inactive employees (left / maternity / ended) stay on the report so the
    // accountant sees them, but must be clearly flagged with their reason.
    // Precompute the badge + note row as strings to avoid deep template nesting.
    const inactive = r.is_active === false;
    const inactiveReason = r.inactive_reason || '';
    const borderColor = inactive ? '#dc2626' : m.accent;
    const inactiveReasonTxt = inactiveReason ? ` — ${inactiveReason}` : ' (לא נרשמה סיבה)';
    const inactiveBadge = inactive
      ? `<span style="display:inline-block;margin-right:6px;padding:1px 7px;border-radius:9px;background:#fee2e2;color:#b91c1c;font-size:9px;font-weight:800">לא פעיל</span>`
      : '';
    const inactiveNoteRow = inactive
      ? `<tr><td colspan="6" style="padding:4px 8px;background:#fef2f2;border-bottom:1px solid ${borderColor};font-size:10px;font-weight:700;color:#b91c1c">⛔ עובד לא פעיל${inactiveReasonTxt}</td></tr>`
      : '';

    const sickVal = sickDays ? `${n1(sickDays)} ימים${sickPay ? ` · ${f(sickPay)}` : ''}` : '';
    // Teken salary split — same columns as the salary table: שכר בסיס (regular) +
    // שכר שע״נ 125% + שכר שע״נ 150% + השלמת שכר, which sum to the agreed teken
    // salary. Only for teken; hourly staff keep a single שכר בסיס below.
    const tekenSplitRow = (isGlobal && tb.teken_salary) ? `<tr style="background:#f6f9ff">
        ${cell('שכר בסיס', tb.regular_pay != null ? f(tb.regular_pay) : '', { bold: true })}
        ${cell('שכר שע״נ 125%', tb.ot125_pay ? f(tb.ot125_pay) : '')}
        ${cell('שכר שע״נ 150%', tb.ot150_pay ? f(tb.ot150_pay) : '')}
        ${cell('השלמת שכר', completion ? f(completion) : '')}
        ${cell('סה״כ שכר תקן', f((tb.regular_pay || 0) + (tb.ot125_pay || 0) + (tb.ot150_pay || 0) + (completion || 0)), { bold: true })}
        ${cell('', '')}
      </tr>` : '';
    // The pay row: teken already showed base/OT/completion above, so it only lists
    // allowances; hourly shows its single base + completion here.
    const payRow = isGlobal
      ? `${cell('נסיעות', c.travel ? f(c.travel) : '')}${cell('דמי חגים', holiday ? f(holiday) : '')}${cell('בונוס', bonus ? f(bonus) : '')}${cell('מחלה', sickVal)}${cell('', '')}${cell('', '')}`
      : `${cell('שכר בסיס', f(c.base_salary), { bold: true })}${cell('השלמת שכר', completion ? f(completion) : '')}${cell('נסיעות', c.travel ? f(c.travel) : '')}${cell('דמי חגים', holiday ? f(holiday) : '')}${cell('בונוס', bonus ? f(bonus) : '')}${cell('מחלה', sickVal)}`;

    // Per-branch payment detail — hourly staff who worked at >1 branch (or a
    // single branch at a non-standard rate), so the accountant sees exactly what
    // to pay for each branch's hours at that branch's rate (mirrors the table).
    let branchDetailRow = '';
    if (r.salary_type === 'hourly') {
      const pb = r.breakdown?.per_branch || {};
      const stdRate = r.breakdown?.rates?.hourly_rate || 0;
      const r1 = (x) => Math.round((x || 0) * 10) / 10;
      const lines = [];
      for (const [bid, bk] of Object.entries(pb)) {
        const reg = bk.regular_hours || 0, ot125 = bk.ot_125_hours || 0, ot150 = bk.ot_150_hours || 0;
        if (reg + ot125 + ot150 <= 0) continue;
        const rate = bk.hourly_rate || 0;
        const amount = Math.round(reg * rate + ot125 * rate * 1.25 + ot150 * rate * 1.5);
        lines.push({ name: branchNameById.get(String(bid)) || 'אחר', reg: r1(reg), ot125: r1(ot125), ot150: r1(ot150), rate, amount });
      }
      const informative = lines.length > 1 || (lines.length === 1 && lines[0].rate !== stdRate);
      if (informative && lines.length) {
        const parts = lines.map((o) => {
          const seg = [`רגיל ${o.reg}ש׳×₪${o.rate}`];
          if (o.ot125) seg.push(`שע״נ125% ${o.ot125}ש׳×₪${Math.round(o.rate * 1.25 * 100) / 100}`);
          if (o.ot150) seg.push(`שע״נ150% ${o.ot150}ש׳×₪${Math.round(o.rate * 1.5 * 100) / 100}`);
          return `<b>${o.name}</b>: ${seg.join(' + ')} = ₪${o.amount.toLocaleString('he-IL')}`;
        }).join(' &nbsp;·&nbsp; ');
        branchDetailRow = `<tr><td colspan="6" style="border:1px solid #e2e8f0;padding:4px 8px;background:#faf5ff">
          <span style="font-size:8.5px;color:#7e22ce;font-weight:800">פירוט תשלום לפי סניף: </span>
          <span style="font-size:10px;color:#334155">${parts}</span></td></tr>`;
      }
    }

    // Single fixed-layout table with a colgroup of 6 equal columns. A top-level
    // table is stretched to 100% by GAS's renderer (a NESTED one is not), so the
    // whole card — header + grid — fills the page width.
    const cg = '<colgroup>' + '<col style="width:16.66%"></col>'.repeat(6) + '</colgroup>';
    return `<table style="width:100%;table-layout:fixed;border-collapse:collapse;border:2px solid ${borderColor};margin:0 0 8px;page-break-inside:avoid">
      ${cg}
      <tr style="background:${inactive ? '#fef2f2' : m.tint}">
        <td colspan="4" style="padding:6px 8px;border-bottom:1px solid ${borderColor}">
          <span style="font-size:14px;font-weight:800;color:#0f172a">${r.full_name}</span>
          ${r.employee_number ? `<span style="font-size:10px;color:#475569"> · מס׳ ${r.employee_number}</span>` : ''}
          <span style="font-size:10px;color:#475569"> · ת״ז ${r.israeli_id || '—'}</span>
          ${r.position ? `<span style="font-size:10px;color:#475569"> · ${r.position}</span>` : ''}
          <span style="display:inline-block;margin-right:6px;padding:1px 7px;border-radius:9px;background:${m.strip};color:${m.stripText};font-size:9px;font-weight:700">${isGlobal ? 'תקן' : 'שעתי'}</span>
          ${inactiveBadge}
        </td>
        <td colspan="2" style="padding:6px 8px;text-align:left;border-bottom:1px solid ${borderColor};white-space:nowrap">
          <span style="font-size:9px;color:#64748b">סה״כ משוער</span>
          <span style="font-size:16px;font-weight:800;color:${m.accent}">${f(b.estimated_total)}</span>
        </td>
      </tr>
      ${inactiveNoteRow}
      <tr>
        ${cell('ימי עבודה', n1(h.days_worked))}
        ${cell('סה״כ שעות', isGlobal && commitHrs ? `${n1(h.total)}${subLine('התחייבות: ' + n1(commitHrs) + ' ש׳')}` : n1(h.total))}
        ${cell('רגילות', n1(h.regular))}
        ${cell('שע״נ 125%', h.ot_125 ? n1(h.ot_125) : '')}
        ${cell('שע״נ 150%', h.ot_150 ? n1(h.ot_150) : '')}
        ${rateCell}
      </tr>
      ${tekenSplitRow}
      <tr>
        ${payRow}
      </tr>
      <tr>
        ${cell('חופשה', vac ? `${n1(vac)} ימים` : '')}
        ${cell('מילואים', nt(r.manual?.miluim))}
        ${cell('GIFT CARD', nt(r.manual?.gift_card))}
        ${cell('הבראה', nt(r.manual?.recreation))}
        ${cell('סיבוס', nt(r.manual?.cibus))}
        ${cell('תוספת שעות (מעל התקן)', paExtraHrs ? `${n1(paExtraHrs)} ש׳` : '', { color: '#15803d' })}
      </tr>
      <tr>
        ${cell('קיזוז מקדמה', advance)}
        ${cell('הלוואות', d.loans ? '−' + f(d.loans) : '', { color: '#b91c1c' })}
        ${cell('קיזוז היעדרות', paDedVal, { color: '#b91c1c' })}
        ${cell('קיזוז ימי היעדרות', absVal, { color: '#b91c1c' })}
        ${cell('סה״כ ניכויים', totalDed ? '−' + f(totalDed) : '', { color: '#b91c1c', bold: true })}
        ${cell('', '')}
      </tr>
      ${(bank || r.pension_fund || r.education_fund) ? `<tr>
        ${cell('בנק', r.bank_number || '')}
        ${cell('סניף בנק', r.bank_branch || '')}
        ${cell('חשבון בנק', r.bank_account || '')}
        ${cell('בעל/ת החשבון', r.bank_account_holder || '')}
        ${cell('קופת פנסיה', r.pension_fund || '')}
        ${cell('קרן השתלמות', r.education_fund || '')}
        ${cell('', '')}
      </tr>` : ''}
      ${branchDetailRow}
      ${(isGlobal && r.sick_info?.completion_offset > 0) ? `<tr><td colspan="6" style="border:2px solid #2563eb;background:#eff6ff;padding:5px 9px">
          <span style="font-size:10.5px;color:#1d4ed8;font-weight:800">מחלה (תקן): </span>
          <span style="font-size:12px;color:#111827;font-weight:700">${n1(r.sick_info.days_used_this_month || 0)} ימי מחלה שולמו כדמי מחלה (${f(r.sick_info.pay)}), <u>והשלמת השכר הופחתה באותו סכום</u> (${f(r.sick_info.completion_offset)}) — כדי שלא ישולם פעמיים על אותם ימים. סה״כ המשכורת נשאר שכר התקן המלא. יש לנכות את הימים ממאזן המחלה.</span></td></tr>` : ''}
      ${(vac && isGlobal) ? `<tr><td colspan="6" style="border:2px solid #2563eb;background:#eff6ff;padding:5px 9px">
          <span style="font-size:10.5px;color:#1d4ed8;font-weight:800">חופשה (תקן): </span>
          <span style="font-size:12px;color:#111827;font-weight:700">לנצל ${vacDaysText(vac)} מיתרת ימי החופשה של העובדת בתלוש — <u>ללא תשלום נוסף</u>. השכר הגלובלי כבר כולל את התשלום עבור ${vac === 1 ? 'היום הזה' : 'הימים האלה'}, ולכן יש להוריד ${vac === 1 ? 'אותו' : 'אותם'} מהצבירה בלבד.</span></td></tr>` : ''}
      ${(vac && !isGlobal) ? (r.manual?.vacation_pay_confirmed
        ? `<tr><td colspan="6" style="border:2px solid #16a34a;background:#f0fdf4;padding:5px 9px">
            <span style="font-size:10.5px;color:#15803d;font-weight:800">חופשה — אישור הנה״ח: </span>
            <span style="font-size:12px;color:#111827;font-weight:700">הנהלת חשבונות אישרה לשלם את ימי החופשה גם ללא יתרת ימים לניצול.</span></td></tr>`
        : `<tr><td colspan="6" style="border:2px solid #f59e0b;background:#fffbeb;padding:5px 9px">
            <span style="font-size:10.5px;color:#92400e;font-weight:800">חופשה: </span>
            <span style="font-size:12px;color:#111827;font-weight:700">לתשלום רק אם נותרו לעובד/ת ימי חופשה לניצול בתלוש — אין יתרה, אין תשלום.</span></td></tr>`) : ''}
      ${notes ? `<tr><td colspan="6" style="border:2px solid #f59e0b;background:#fffbeb;padding:6px 9px">
          <span style="font-size:10.5px;color:#92400e;font-weight:800">הערות: </span>
          <span style="font-size:13px;color:#111827;font-weight:800">${notes}</span></td></tr>` : ''}
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
<style>@page{size:A4 portrait;margin:7mm}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:Arial,sans-serif;color:#111;width:100%}
table{width:100%}
h1{font-size:17px;text-align:center;margin:0 0 2px}
.sub{text-align:center;color:#475569;font-size:11px;margin:0 0 6px}</style></head>
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

/**
 * POST /api/payroll-month/punch-resolutions
 * Body: { employee_id, date, labels:[{punch_id, role:'in'|'out'|'ignore'}], note? }
 * The accountant/admin decides how a >2-punch day is paired. Billing walks the
 * labels chronologically and pays Σ(in→out) — never the out→in gaps — so a real
 * in-out-in-out day is handled correctly, as is a duplicate-punch day.
 */
async function resolvePunchDay(req, res, next) {
  try {
    const role = req.user?.role;
    // The branch manager is the one who was there — she labels the day. Her
    // decision is a proposal (`pending`) that bills nothing until accounting
    // confirms it; accounting and admins approve outright.
    const isApprover = role === 'system_admin' || role === 'accountant';
    if (!isApprover && role !== 'branch_manager') {
      return res.status(403).json({ error: 'אין הרשאה לאשר החתמות' });
    }
    const { employee_id, date, labels, note } = req.body || {};
    if (!employee_id || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !Array.isArray(labels)) {
      return res.status(400).json({ error: 'employee_id, date (YYYY-MM-DD) ו-labels נדרשים' });
    }
    const clean = labels
      .filter(l => l && l.punch_id && ['in', 'out', 'ignore'].includes(l.role))
      .map(l => ({ punch_id: l.punch_id, role: l.role }));

    // Compute the billed minutes from the labels (same walk the salary uses).
    const punches = await Punch.find({ _id: { $in: clean.map(l => l.punch_id) } })
      .select('timestamp branch_id').lean();
    const byId = new Map(punches.map(p => [String(p._id), p]));
    const ordered = clean
      .map(l => ({ ...l, p: byId.get(String(l.punch_id)) }))
      .filter(x => x.p)
      .sort((a, b) => new Date(a.p.timestamp) - new Date(b.p.timestamp));
    let minutes = 0, openIn = null;
    for (const x of ordered) {
      if (x.role === 'in') openIn = x.p;
      else if (x.role === 'out' && openIn) {
        minutes += Math.max(0, Math.round((new Date(x.p.timestamp) - new Date(openIn.timestamp)) / 60000));
        openIn = null;
      }
    }
    const branch_id = ordered[0]?.p?.branch_id || null;

    // A manager may only label her own branches' days — the day's branch comes
    // from the punches themselves, so this can't be spoofed from the request.
    if (!isApprover) {
      const scope = branchScopeOf(req) || [];
      if (!branch_id || !scope.map(String).includes(String(branch_id))) {
        return res.status(403).json({ error: 'אפשר לאשר רק ימים של הסניפים שבאחריותך' });
      }
      // Re-labelling a day accounting already approved would silently reopen
      // settled pay; that reversal is accounting's call.
      const existing = await PunchResolution.findOne({ employee_id, date }).select('status').lean();
      if (existing?.status === 'approved') {
        return res.status(409).json({ error: 'היום כבר אושר סופית על ידי הנהלת החשבונות' });
      }
    }

    const base = {
      employee_id, date, branch_id, labels: clean, minutes, note: note || '',
    };
    const doc = await PunchResolution.findOneAndUpdate(
      { employee_id, date },
      isApprover
        ? { ...base, status: 'approved', resolved_by: req.user?.id || null, resolved_at: new Date() }
        : {
            ...base,
            status: 'pending',
            proposed_by: req.user?.id || null,
            proposed_by_name: req.user?.full_name || '',
            proposed_at: new Date(),
            resolved_by: null,
            resolved_at: null,
          },
      { upsert: true, new: true },
    ).lean();
    res.json({ ok: true, minutes, resolution: doc, status: doc.status });
  } catch (err) { next(err); }
}

/** DELETE /api/payroll-month/punch-resolutions?employee_id=&date= — reopen a day. */
async function unresolvePunchDay(req, res, next) {
  try {
    const role = req.user?.role;
    if (role !== 'system_admin' && role !== 'accountant') {
      return res.status(403).json({ error: 'אין הרשאה' });
    }
    const { employee_id, date } = req.query;
    if (!employee_id || !date) return res.status(400).json({ error: 'employee_id ו-date נדרשים' });
    await PunchResolution.deleteOne({ employee_id, date });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// GET pregnancy-exam config: the 40h proration mode + the full-time week used
// for linear proration. DISPLAY-side config only (never auto-computes pay).
async function getPregnancySettings(req, res, next) {
  try {
    const modeDoc = await Setting.findOne({ key: 'pregnancy_exam_proration_mode' }).lean();
    const ftDoc = await Setting.findOne({ key: 'full_time_weekly_hours' }).lean();
    res.json({
      proration_mode: modeDoc?.value === 'statutory' ? 'statutory' : 'linear',
      full_time_weekly_hours: Number(ftDoc?.value) > 0 ? Number(ftDoc.value) : 42,
    });
  } catch (err) { next(err); }
}

// PUT pregnancy-exam config.
async function setPregnancySettings(req, res, next) {
  try {
    if (req.body?.proration_mode !== undefined) {
      const mode = req.body.proration_mode === 'statutory' ? 'statutory' : 'linear';
      await Setting.findOneAndUpdate({ key: 'pregnancy_exam_proration_mode' }, { value: mode }, { upsert: true });
    }
    if (req.body?.full_time_weekly_hours !== undefined) {
      const h = Number(req.body.full_time_weekly_hours);
      if (h > 0 && h <= 100) {
        await Setting.findOneAndUpdate({ key: 'full_time_weekly_hours' }, { value: h }, { upsert: true });
      }
    }
    res.json({ ok: true });
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
    const branchNameById = new Map((data.branches || []).map(b => [String(b.id), b.name]));
    const html = buildAccountantHtml(month, rows, branchNameById);
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

/**
 * Every day with more than two punches must carry a final accountant decision
 * before the month can leave the building. Scans ALL branches for the month
 * (not just the one on screen) and returns what is still unresolved.
 */
async function punchIssues(month) {
  const from = new Date(`${month}-01T00:00:00Z`);
  const to = new Date(from); to.setUTCMonth(to.getUTCMonth() + 1);
  const punches = await Punch.find({
    timestamp: { $gte: new Date(from.getTime() - 2 * 864e5), $lt: new Date(to.getTime() + 2 * 864e5) },
    ignored: { $ne: true },
  }).select('employee_id timestamp approval_status timestamp_source created_at branch_id').lean();

  const byDay = new Map(); // 'empId|date' → punches[]
  for (const p of punches) {
    if (!p.employee_id) continue;
    const s = p.approval_status || 'auto';
    if (s !== 'auto' && s !== 'approved') continue;
    const d = ISR_DAY(p.timestamp);
    if (d.slice(0, 7) !== month) continue;
    const k = String(p.employee_id) + '|' + d;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(p);
  }

  const dupKeys = [], missKeys = [], crossKeys = [];
  for (const [k, list] of byDay) {
    if (list.length > 2) dupKeys.push(k);
    else if (list.length === 1) missKeys.push(k); // a lone punch — the pair is incomplete
    else if (list.length === 2) {
      // Clocked in at one branch and out at another. The day looks complete, so
      // nothing else flags it — but the whole session is billed to the IN
      // punch's branch (payrollCalc.splitDayIntoBranches), and branches have
      // different rates and different amutot. She should have clocked out of
      // the first branch and into the second; until the day is split, part of
      // it is paid at the wrong rate and booked to the wrong legal entity.
      const [a, b] = list;
      if (a.branch_id && b.branch_id && String(a.branch_id) !== String(b.branch_id)) crossKeys.push(k);
    }
  }
  // A branch manager's proposal does NOT clear the day — it still shows and
  // still blocks the send — but it comes back with the day so accounting can
  // confirm it in one click instead of re-deciding from scratch.
  const resolutionDocs = await PunchResolution.find({ date: { $regex: `^${month}` } })
    .select('employee_id date status labels minutes note proposed_by_name proposed_at').lean();
  const resolved = new Set(resolutionDocs
    .filter(r => r.status === 'approved')
    .map(r => String(r.employee_id) + '|' + r.date));
  const proposalByKey = new Map(resolutionDocs
    .filter(r => r.status === 'pending')
    .map(r => [String(r.employee_id) + '|' + r.date, r]));
  const pendingDup = dupKeys.filter(k => !resolved.has(k));
  // A cross-branch day is cleared the same way as any other: once it carries an
  // approved resolution, a human has said how it should be billed.
  const pendingCross = crossKeys.filter(k => !resolved.has(k));

  const empIds = [...new Set([...pendingDup, ...missKeys, ...pendingCross].map(k => k.split('|')[0]))];
  const emps = await Employee.find({ _id: { $in: empIds } })
    .select('full_name branch_id receives_salary').populate('branch_id', 'name').lean();
  const empById = Object.fromEntries(emps.map(e => [String(e._id), e]));
  // An unpaid role-holder is not chased for punches: nothing is billed from
  // them, so a lone punch is not a problem anyone has to solve. Her punches are
  // still kept and still visible in the attendance grid.
  const isPaid = (k) => empById[k.split('|')[0]]?.receives_salary !== false;
  const meta = (k) => {
    const [empId, date] = k.split('|');
    const e = empById[empId] || {};
    return {
      employee_id: empId,
      full_name: e.full_name || '',
      // branch_id is what the UI groups by and what a reminder is addressed to;
      // the name alone can't identify the manager to notify.
      branch_id: e.branch_id?._id ? String(e.branch_id._id) : null,
      branch_name: e.branch_id?.name || '',
      date,
    };
  };
  const byName = (a, b) => a.full_name.localeCompare(b.full_name, 'he') || a.date.localeCompare(b.date);

  const duplicates = pendingDup.filter(isPaid).map(k => {
    const list = byDay.get(k).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const suggestion = suggestPunchLabels(list);
    const roleById = new Map(suggestion.labels.map(l => [l.punch_id, l.role]));
    // A manager's proposal beats the automatic suggestion — she was there.
    const proposal = proposalByKey.get(k);
    const proposedRoleById = new Map((proposal?.labels || []).map(l => [String(l.punch_id), l.role]));
    return {
      ...meta(k),
      punches: list.map(p => ({
        id: String(p._id), hhmm: ISR_HHMM(p.timestamp),
        is_manual: p.timestamp_source === 'manual',
        suggested_role: proposedRoleById.get(String(p._id))
          || roleById.get(String(p._id)) || 'ignore',
      })),
      suggestion_reason: suggestion.reason,
      pending_resolution: proposal ? {
        by: proposal.proposed_by_name || '',
        at: proposal.proposed_at,
        minutes: proposal.minutes,
        note: proposal.note || '',
      } : null,
    };
  }).sort(byName);

  // Branch names for both ends of a cross-branch day — the manager has to see
  // which two branches are involved to know where the transfer happened.
  const crossBranchIds = [...new Set(pendingCross.flatMap(k =>
    (byDay.get(k) || []).map(p => p.branch_id).filter(Boolean).map(String)))];
  const branchNameById = new Map((crossBranchIds.length
    ? await Branch.find({ _id: { $in: crossBranchIds } }).select('name').lean()
    : []).map(b => [String(b._id), b.name]));

  const cross_branch = pendingCross.filter(isPaid).map(k => {
    const list = byDay.get(k).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const [inP, outP] = list;
    return {
      ...meta(k),
      // meta() reports her HOME branch; the day itself happened across these two.
      in_branch_id: String(inP.branch_id),
      in_branch_name: branchNameById.get(String(inP.branch_id)) || '',
      in_hhmm: ISR_HHMM(inP.timestamp),
      out_branch_id: String(outP.branch_id),
      out_branch_name: branchNameById.get(String(outP.branch_id)) || '',
      out_hhmm: ISR_HHMM(outP.timestamp),
      minutes: Math.max(0, Math.round((new Date(outP.timestamp) - new Date(inP.timestamp)) / 60000)),
      pending_resolution: proposalByKey.has(k) ? {
        by: proposalByKey.get(k).proposed_by_name || '',
        at: proposalByKey.get(k).proposed_at,
      } : null,
    };
  }).sort(byName);

  const missing = missKeys.filter(isPaid).map(k => {
    const p = byDay.get(k)[0];
    return {
      ...meta(k),
      punch_hhmm: ISR_HHMM(p.timestamp),
      is_manual: p.timestamp_source === 'manual',
    };
  }).sort(byName);

  return { duplicates, missing, cross_branch };
}

/**
 * Branches this user is responsible for, or null for "everything" (accountant /
 * system_admin). A branch manager must only ever see — and be able to fix — the
 * punch problems of their own staff.
 */
function branchScopeOf(req) {
  const role = req.user?.role;
  if (role === 'system_admin' || role === 'accountant') return null;
  const managed = (req.user?.managed_branch_ids || []).map(String);
  const fallback = req.user?.branch_id ? [String(req.user.branch_id)] : [];
  return managed.length ? managed : fallback;
}

/** Keep only the issues belonging to `scope` (null = keep everything). */
function scopeIssues(list, scope) {
  if (!scope) return list;
  const allowed = new Set(scope.map(String));
  return list.filter(i => i.branch_id && allowed.has(String(i.branch_id)));
}

/**
 * Most logins carry a synthetic placeholder address (<ת"ז>@gan-halomot.local),
 * not an inbox. Mailing those silently drops the message while reporting
 * success, so they must never count as a reachable address.
 */
const isRealEmail = (e) => !!e && e.includes('@')
  && !/@gan-halomot\.local$/i.test(e) && !/@ganhalomot\.co\.il$/i.test(e);

/** Israeli mobile → intl for wa.me (0501234567 → 972501234567). */
const waNumber = (phone = '') => {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('972')) return digits;
  if (digits.startsWith('0')) return `972${digits.slice(1)}`;
  return digits;
};

/**
 * The manager(s) responsible for a branch — an explicit managed_branch_ids
 * entry, or a single-branch manager whose home branch is this one.
 *
 * A manager's phone usually lives on her Employee card rather than her login,
 * and without a number the WhatsApp reminder is dead, so we fall back to it.
 */
async function branchManagers(branchIds) {
  const ids = (Array.isArray(branchIds) ? branchIds : [branchIds]).filter(Boolean);
  if (!ids.length) return new Map();
  const users = await User.find({
    role: 'branch_manager',
    is_active: { $ne: false },
    $or: [{ managed_branch_ids: { $in: ids } }, { branch_id: { $in: ids } }],
  }).select('full_name email phone managed_branch_ids branch_id').lean();
  if (!users.length) return new Map();

  const empDocs = await Employee.find({ user_id: { $in: users.map(u => u._id) } })
    .select('user_id phone').lean();
  const phoneByUser = new Map(empDocs.filter(e => e.phone).map(e => [String(e.user_id), e.phone]));

  const byBranch = new Map(ids.map(id => [String(id), []]));
  for (const u of users) {
    const covers = (u.managed_branch_ids || []).map(String);
    if (!covers.length && u.branch_id) covers.push(String(u.branch_id));
    for (const bid of covers) {
      if (!byBranch.has(bid)) continue;
      byBranch.get(bid).push({
        id: String(u._id),
        name: u.full_name,
        email: isRealEmail(u.email) ? u.email : '',
        phone: u.phone || phoneByUser.get(String(u._id)) || '',
      });
    }
  }
  return byBranch;
}

/** The Hebrew nudge sent to a branch manager (also reused as the WhatsApp text). */
function buildReminderText(branchName, month, missing, duplicates) {
  const missLines = [...missing]
    .sort((a, b) => a.date.localeCompare(b.date) || a.full_name.localeCompare(b.full_name, 'he'))
    .map(m => `• ${m.date} — ${m.full_name} (החתמה יחידה ${m.punch_hhmm})`);
  const dupLines = [...duplicates]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => `• ${d.date} — ${d.full_name} (${d.punches.length} החתמות באותו יום)`);
  return [
    `שלום, נדרשת השלמת החתמות בסניף ${branchName} לחודש ${month}.`,
    '',
    ...(missing.length ? [`ימים עם החתמה חסרה (${missing.length}):`, ...missLines, ''] : []),
    ...(duplicates.length ? [`ימים עם החתמה כפולה הממתינים לבדיקה (${duplicates.length}):`, ...dupLines, ''] : []),
    'נא להיכנס למערכת → החתמות → להשלים את השעות החסרות. לאחר ההשלמה הן יגיעו לאישור הנהלת החשבונות.',
  ].join('\n');
}

/**
 * GET /api/payroll-month/:month/punch-issues
 * Everything wrong with the month's punches, across ALL branches, in one place:
 * unresolved >2-punch days (which BLOCK the accountant send) and days with a
 * single punch where the in/out pair never completed (shown to fix, not blocking).
 */
async function punchReviewStatus(req, res, next) {
  try {
    const { month } = req.params;
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM נדרש' });
    const scope = branchScopeOf(req);
    const [{ duplicates, missing, cross_branch: crossRaw }, conflictsRaw] = await Promise.all([
      punchIssues(month),
      // A fixed-hours employee who also clocked in that day: no hours were
      // generated for her, and someone has to say which reading counts.
      fixedScheduleConflicts(month, { branchIds: scope }).catch(() => []),
    ]);

    // The blocking gate is a NETWORK-WIDE fact — the accountant cannot send the
    // month while anything anywhere is unresolved — so it is counted before
    // scoping. The lists themselves are scoped to what this user may act on.
    const blockedCount = duplicates.length;
    const scopedDuplicates = scopeIssues(duplicates, scope);
    const scopedMissing = scopeIssues(missing, scope);
    const conflicts = scopeIssues(conflictsRaw, scope);
    // A cross-branch day belongs to BOTH branches, so a manager who owns
    // either end must see it — scoping on her home branch alone would hide the
    // days where she is the receiving branch.
    const crossBranch = (crossRaw || []).filter(i => !scope || scope.map(String)
      .some(b => b === String(i.in_branch_id) || b === String(i.out_branch_id)));

    // Branch directory for the per-branch tabs. Each entry carries its own
    // counts, its manager(s), and a ready WhatsApp link — so switching to a
    // branch tab immediately shows who is responsible and how to nudge them,
    // with no extra request and no need to press "send" first.
    //
    // EVERY branch in scope gets a tab, including the clean ones. Listing only
    // the branches that happen to have problems makes "this branch is fine"
    // and "this branch is hidden from you" look identical — an admin comparing
    // two months reads the shorter tab strip as lost access rather than as a
    // clean branch.
    const branchDocsAll = await Branch.find(scope ? { _id: { $in: scope } } : {}).select('name').lean();
    const branchIds = branchDocsAll.map(b => String(b._id));
    const [branchDocs, managersByBranch, entryTasks] = await Promise.all([
      branchDocsAll,
      branchManagers(branchIds),
      // Whether this branch was already told to fill its own gaps — and whether
      // the manager ever opened it. Without this the accountant re-sends blind.
      branchIds.length
        ? PunchEntryTask.find({ branch_id: { $in: branchIds }, month, status: 'open' }).lean()
        : [],
    ]);
    const taskByBranch = new Map(entryTasks.map(t => [String(t.branch_id), t]));
    const branches = branchDocs.map(bd => {
      const id = String(bd._id);
      const mine = (l) => l.filter(i => String(i.branch_id) === id);
      const bMissing = mine(scopedMissing);
      const bDups = mine(scopedDuplicates);
      const bCross = crossBranch.filter(i =>
        String(i.in_branch_id) === id || String(i.out_branch_id) === id);
      const text = buildReminderText(bd.name, month, bMissing, bDups);
      const task = taskByBranch.get(id);
      return {
        id,
        name: bd.name,
        duplicates_count: bDups.length,
        missing_count: bMissing.length,
        conflicts_count: mine(conflicts).length,
        cross_branch_count: bCross.length,
        reminder_text: text,
        entry_task: task ? {
          id: String(task._id),
          assigned_at: task.assigned_at,
          reminder_count: task.reminder_count,
          missing_count_at_assign: task.missing_count_at_assign,
          first_seen_at: task.first_seen_at,
          last_seen_at: task.last_seen_at,
          seen_count: task.seen_count,
        } : null,
        managers: (managersByBranch.get(id) || []).map(m => ({
          ...m,
          whatsapp_url: m.phone ? `https://wa.me/${waNumber(m.phone)}?text=${encodeURIComponent(text)}` : null,
        })),
      };
    }).sort((a, b) => a.name.localeCompare(b.name, 'he'));

    res.json({
      blocked: blockedCount > 0,
      count: blockedCount,
      // What this user can see (a manager sees only their own branches).
      duplicates_count: scopedDuplicates.length,
      missing_count: scopedMissing.length,
      conflicts_count: conflicts.length,
      cross_branch_count: crossBranch.length,
      // Network-wide totals, so a manager understands why the send is blocked
      // even when their own branch is clean.
      network_duplicates_count: duplicates.length,
      network_missing_count: missing.length,
      scoped: !!scope,
      duplicates: scopedDuplicates,
      missing: scopedMissing,
      conflicts,
      cross_branch: crossBranch,
      branches,
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/:month/punch-issues/fixed-conflict
 * Body: { employee_id, date, decision: 'clock' | 'fixed' }
 *
 * Resolves a day where a fixed-hours employee also clocked in.
 *   'clock' — the real reading wins; the day is marked as an exception so no
 *             fixed hours are ever generated for it.
 *   'fixed' — the standing hours win; the clock punches are marked ignored
 *             (kept for audit, excluded from pay) and the hours are generated.
 */
async function resolveFixedConflict(req, res, next) {
  try {
    const { employee_id, date, decision } = req.body || {};
    if (!employee_id || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return res.status(400).json({ error: 'employee_id ותאריך נדרשים' });
    }
    if (decision !== 'clock' && decision !== 'fixed') {
      return res.status(400).json({ error: 'decision חייב להיות clock או fixed' });
    }

    const dayFrom = ilDateTimeOf(date, '00:00');
    const dayTo = new Date(dayFrom.getTime() + 36 * 3600 * 1000);

    if (decision === 'clock') {
      await markFixedScheduleDayOff(employee_id, date, 'הוחלט לפי החתמת השעון');
      return res.json({ ok: true, decision });
    }

    await Punch.updateMany(
      {
        employee_id,
        timestamp: { $gte: dayFrom, $lt: dayTo },
        timestamp_source: { $ne: 'fixed_schedule' },
      },
      { $set: { ignored: true, ignored_reason: `הוחלט לשלם לפי שעות קבועות (${date})` } },
    );
    const result = await materializeFixedSchedule(date.slice(0, 7), {
      employeeIds: [employee_id], userId: req.user?.id || null,
    });
    res.json({ ok: true, decision, punches_created: result.created });
  } catch (err) { next(err); }
}

// --- ימים מיוחדים (employer-declared closures) ----------------------------

/** GET /api/payroll-month/special-days?month=YYYY-MM */
async function listSpecialDays(req, res, next) {
  try {
    const filter = {};
    if (/^\d{4}-\d{2}$/.test(String(req.query.month || ''))) filter.date = { $regex: `^${req.query.month}` };
    const days = await SpecialDay.find(filter).populate('branch_id', 'name').sort({ date: -1 }).lean();
    res.json({
      special_days: days.map(d => ({
        ...d, id: String(d._id),
        branch_name: d.branch_id?.name || 'כל הסניפים',
        branch_id: d.branch_id?._id ? String(d.branch_id._id) : null,
      })),
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/special-days
 * { name, date, branch_id?, pay_global, pay_hourly, hourly_hours?, note? }
 */
async function createSpecialDay(req, res, next) {
  try {
    const { name, date, branch_id, pay_global, pay_hourly, hourly_hours, note } = req.body || {};
    if (!String(name || '').trim()) return res.status(400).json({ error: 'יש להזין שם ליום' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return res.status(400).json({ error: 'תאריך נדרש (YYYY-MM-DD)' });
    const hours = Number(hourly_hours) || 0;
    if (hours < 0 || hours > 24) return res.status(400).json({ error: 'מספר שעות לא תקין' });
    // A day that pays nobody changes nothing — it would just sit in the list
    // looking as if it had been handled.
    if (pay_global === false && pay_hourly === false) {
      return res.status(400).json({ error: 'יש לבחור לפחות סוג עובד אחד שיקבל תשלום על היום' });
    }
    const doc = await SpecialDay.create({
      name: String(name).trim(),
      date,
      branch_id: branch_id || null,
      pay_global: pay_global !== false,
      pay_hourly: pay_hourly === true,
      hourly_hours: hours,
      note: note || '',
      created_by: req.user?.id || null,
      created_by_name: req.user?.full_name || '',
    });
    res.status(201).json({ special_day: { ...doc.toObject(), id: String(doc._id) } });
  } catch (err) { next(err); }
}

/** PATCH /api/payroll-month/special-days/:id */
async function updateSpecialDay(req, res, next) {
  try {
    const set = {};
    for (const k of ['name', 'date', 'note']) if (req.body[k] !== undefined) set[k] = req.body[k];
    if (req.body.branch_id !== undefined) set.branch_id = req.body.branch_id || null;
    if (req.body.pay_global !== undefined) set.pay_global = !!req.body.pay_global;
    if (req.body.pay_hourly !== undefined) set.pay_hourly = !!req.body.pay_hourly;
    if (req.body.hourly_hours !== undefined) set.hourly_hours = Number(req.body.hourly_hours) || 0;
    if (set.pay_global === false && set.pay_hourly === false) {
      return res.status(400).json({ error: 'יש לבחור לפחות סוג עובד אחד שיקבל תשלום על היום' });
    }
    const doc = await SpecialDay.findByIdAndUpdate(req.params.id, set, { new: true });
    if (!doc) return res.status(404).json({ error: 'יום לא נמצא' });
    res.json({ special_day: { ...doc.toObject(), id: String(doc._id) } });
  } catch (err) { next(err); }
}

/** DELETE /api/payroll-month/special-days/:id */
async function deleteSpecialDay(req, res, next) {
  try {
    await SpecialDay.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/:month/punch-issues/split-branch
 * { employee_id, date, transfer_time }
 *
 * She clocked in at one branch and out at another without closing the first.
 * The fix is the pair she should have punched: an OUT at the first branch and
 * an IN at the second, both at the moment she moved. That turns one mis-billed
 * session into two correctly-priced ones — the rates and the amuta follow the
 * in-punch's branch, so until the day is split the second branch's hours are
 * paid at the first branch's rate and booked to the wrong legal entity.
 *
 * Same two-stage rule as labelling a multi-punch day: a branch manager
 * proposes, accounting confirms.
 */
async function splitCrossBranchDay(req, res, next) {
  try {
    const role = req.user?.role;
    const isApprover = role === 'system_admin' || role === 'accountant';
    if (!isApprover && role !== 'branch_manager') {
      return res.status(403).json({ error: 'אין הרשאה' });
    }
    const { employee_id, date, transfer_time } = req.body || {};
    if (!employee_id || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
      return res.status(400).json({ error: 'employee_id ותאריך נדרשים' });
    }
    if (!/^\d{2}:\d{2}$/.test(String(transfer_time || ''))) {
      return res.status(400).json({ error: 'יש להזין שעת מעבר בפורמט HH:mm' });
    }

    const dayFrom = ilDateTimeOf(date, '00:00');
    const dayTo = new Date(dayFrom.getTime() + 36 * 3600 * 1000);
    const list = (await Punch.find({
      employee_id, timestamp: { $gte: dayFrom, $lt: dayTo }, ignored: { $ne: true },
    }).sort({ timestamp: 1 }).lean())
      .filter(p => ['auto', 'approved'].includes(p.approval_status || 'auto'));

    if (list.length !== 2) {
      return res.status(409).json({ error: 'היום כבר אינו יום דו-סניפי פשוט — יש לטפל בו כיום עם כפילויות' });
    }
    const [inP, outP] = list;
    if (String(inP.branch_id) === String(outP.branch_id)) {
      return res.status(409).json({ error: 'שתי ההחתמות באותו סניף — אין מה לפצל' });
    }

    const transferAt = ilDateTimeOf(date, transfer_time);
    if (transferAt <= new Date(inP.timestamp) || transferAt >= new Date(outP.timestamp)) {
      return res.status(400).json({ error: 'שעת המעבר חייבת להיות בין הכניסה ליציאה' });
    }

    const emp = await Employee.findById(employee_id).select('israeli_id branch_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    // A manager's entry is not pay until accounting signs off — the same chain
    // manual punches already use.
    const approvalStatus = isApprover ? 'approved' : 'pending_accountant';
    const baseSn = -Date.now();
    const note = `פיצול יום דו-סניפי (${date}) — מעבר בין סניפים בשעה ${transfer_time}`;
    // The OUT lands one second before the IN. Both are "the moment she moved",
    // but giving them the same instant leaves their order to chance — and every
    // reader that sorts a day chronologically (the grid, the salary walk) would
    // then be free to read it as in→in→out→out.
    const mk = (branchId, state, i, at) => Punch.create({
      branch_id: branchId,
      employee_id,
      israeli_id: emp.israeli_id || '',
      device_user_sn: baseSn - i,
      timestamp: at,
      timestamp_source: 'manual',
      state,
      verify_mode: 0,
      received_at: new Date(),
      agent_version: 'manual-entry',
      manual_note: note,
      created_by: req.user?.id || null,
      approval_status: approvalStatus,
      approval_decided_by: isApprover ? (req.user?.id || null) : null,
      approval_decided_at: isApprover ? new Date() : null,
      manager_approved_by: req.user?.id || null,
      manager_approved_at: new Date(),
    });
    // OUT of the branch she came from, IN to the branch she moved to.
    const outOfFirst = await mk(inP.branch_id, 1, 0, transferAt);
    const intoSecond = await mk(outP.branch_id, 0, 1, new Date(transferAt.getTime() + 1000));

    // The day now has four punches, which would otherwise resurface as a
    // ">2 punches" problem. Record the intended reading so it doesn't.
    const labels = [
      { punch_id: inP._id, role: 'in' },
      { punch_id: outOfFirst._id, role: 'out' },
      { punch_id: intoSecond._id, role: 'in' },
      { punch_id: outP._id, role: 'out' },
    ];
    const minutes = Math.max(0, Math.round((new Date(outP.timestamp) - new Date(inP.timestamp)) / 60000));
    await PunchResolution.findOneAndUpdate(
      { employee_id, date },
      {
        employee_id, date, branch_id: inP.branch_id, labels, minutes, note,
        ...(isApprover
          ? { status: 'approved', resolved_by: req.user?.id || null, resolved_at: new Date() }
          : {
              status: 'pending',
              proposed_by: req.user?.id || null,
              proposed_by_name: req.user?.full_name || '',
              proposed_at: new Date(),
              resolved_by: null, resolved_at: null,
            }),
      },
      { upsert: true, new: true },
    );

    res.json({ ok: true, status: isApprover ? 'approved' : 'pending', minutes });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/:month/punch-issues/remind
 * Body: { branch_id, kind?: 'missing'|'duplicates'|'all' }
 *
 * Filling in a missing punch is the BRANCH MANAGER's job — they know whether
 * the employee was actually there. This nudges them by email and hands back a
 * ready-made WhatsApp message per manager, so accounting chases rather than
 * invents hours.
 */
async function remindBranchManager(req, res, next) {
  try {
    const { month } = req.params;
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM נדרש' });
    const branchId = req.body?.branch_id;
    if (!branchId) return res.status(400).json({ error: 'branch_id נדרש' });

    const branch = await Branch.findById(branchId).select('name').lean();
    if (!branch) return res.status(404).json({ error: 'סניף לא נמצא' });

    const { duplicates, missing } = await punchIssues(month);
    const branchMissing = missing.filter(m => String(m.branch_id) === String(branchId));
    const branchDups = duplicates.filter(d => String(d.branch_id) === String(branchId));
    if (branchMissing.length === 0 && branchDups.length === 0) {
      return res.status(400).json({ error: 'אין בעיות פתוחות בסניף זה' });
    }

    const managers = (await branchManagers([branchId])).get(String(branchId)) || [];
    const summary = buildReminderText(branch.name, month, branchMissing, branchDups);
    const emails = managers.map(m => m.email).filter(Boolean);
    let emailed = 0;
    if (emails.length) {
      try {
        await dispatchEmail({
          to: emails,
          subject: `השלמת החתמות — ${branch.name} — ${month}`,
          text: summary,
          html: `<div dir="rtl" style="font-family:Arial,sans-serif;white-space:pre-wrap">${
            summary.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          }</div>`,
        });
        emailed = emails.length;
      } catch (e) {
        console.error('[punch-issues] reminder email failed:', e.message);
      }
    }

    res.json({
      ok: true,
      branch_name: branch.name,
      missing_count: branchMissing.length,
      duplicates_count: branchDups.length,
      emailed,
      message: summary,
      managers: managers.map(m => ({
        name: m.name,
        email: m.email,
        phone: m.phone,
        whatsapp_url: m.phone
          ? `https://wa.me/${waNumber(m.phone)}?text=${encodeURIComponent(summary)}`
          : null,
      })),
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/:month/punch-issues/assign
 * Body: { branch_id }
 *
 * Same nudge as `remind`, but it LEAVES A STANDING TASK: the manager meets it
 * on their next login (PunchEntryTaskGate) and accounting can see whether it
 * was opened. Re-assigning an open task refreshes its snapshot and bumps
 * `reminder_count` rather than piling up duplicate rows.
 */
async function assignPunchEntry(req, res, next) {
  try {
    const { month } = req.params;
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM נדרש' });
    const branchId = req.body?.branch_id;
    if (!branchId) return res.status(400).json({ error: 'branch_id נדרש' });

    const branch = await Branch.findById(branchId).select('name').lean();
    if (!branch) return res.status(404).json({ error: 'סניף לא נמצא' });

    const { duplicates, missing } = await punchIssues(month);
    const branchMissing = missing.filter(m => String(m.branch_id) === String(branchId));
    const branchDups = duplicates.filter(d => String(d.branch_id) === String(branchId));
    if (branchMissing.length === 0 && branchDups.length === 0) {
      return res.status(400).json({ error: 'אין בעיות פתוחות בסניף זה' });
    }

    const managers = (await branchManagers([branchId])).get(String(branchId)) || [];
    // A task nobody can open is worse than no task: it would sit "open" forever
    // and look handled. Say so instead.
    if (managers.length === 0) {
      return res.status(400).json({ error: `לא מוגדר מנהל לסניף ${branch.name} — אי אפשר להקצות משימה` });
    }

    const summary = `${buildReminderText(branch.name, month, branchMissing, branchDups)}\n\nנפתחה עבורך משימה במערכת — היא תופיע בכניסה הבאה שלך לאפליקציה.`;
    const emails = managers.map(m => m.email).filter(Boolean);
    let emailed = 0;
    if (emails.length) {
      try {
        await dispatchEmail({
          to: emails,
          subject: `נדרשת השלמת החתמות — ${branch.name} — ${month}`,
          text: summary,
          html: `<div dir="rtl" style="font-family:Arial,sans-serif;white-space:pre-wrap">${
            summary.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          }</div>`,
        });
        emailed = emails.length;
      } catch (e) {
        console.error('[punch-issues] assign email failed:', e.message);
      }
    }

    const snapshot = branchMissing.map(m => ({
      employee_id: m.employee_id, full_name: m.full_name, date: m.date, punch_hhmm: m.punch_hhmm,
    }));
    const existing = await PunchEntryTask.findOne({ branch_id: branchId, month, status: 'open' });
    let task;
    if (existing) {
      existing.missing_snapshot = snapshot;
      existing.missing_count_at_assign = branchMissing.length;
      existing.duplicates_count_at_assign = branchDups.length;
      existing.manager_user_ids = managers.map(m => m.id);
      existing.assigned_by = req.user?.id || req.user?._id || null;
      existing.assigned_at = new Date();
      existing.reminder_count = (existing.reminder_count || 1) + 1;
      existing.emailed = emailed;
      task = await existing.save();
    } else {
      task = await PunchEntryTask.create({
        branch_id: branchId,
        month,
        missing_snapshot: snapshot,
        missing_count_at_assign: branchMissing.length,
        duplicates_count_at_assign: branchDups.length,
        manager_user_ids: managers.map(m => m.id),
        assigned_by: req.user?.id || req.user?._id || null,
        emailed,
      });
    }

    res.json({
      ok: true,
      branch_name: branch.name,
      missing_count: branchMissing.length,
      duplicates_count: branchDups.length,
      emailed,
      resent: !!existing,
      reminder_count: task.reminder_count,
      message: summary,
      task_id: String(task._id),
      managers: managers.map(m => ({
        name: m.name,
        email: m.email,
        phone: m.phone,
        whatsapp_url: m.phone
          ? `https://wa.me/${waNumber(m.phone)}?text=${encodeURIComponent(summary)}`
          : null,
      })),
    });
  } catch (err) { next(err); }
}

/**
 * GET /api/payroll-month/punch-entry-tasks/mine
 *
 * The open assignments for the branches THIS user manages, each with the days
 * that are still missing right now — recomputed, never the frozen snapshot, so
 * a day the employee completed herself from האזור שלי disappears from the list
 * and a task whose branch is now clean closes itself.
 *
 * Reading the list is the read receipt: it stamps first/last seen.
 */
async function myPunchEntryTasks(req, res, next) {
  try {
    const scope = branchScopeOf(req);
    // Accounting is the sender, never the assignee — an unscoped user has none.
    if (!scope || scope.length === 0) return res.json({ tasks: [] });

    const open = await PunchEntryTask.find({ branch_id: { $in: scope }, status: 'open' })
      .sort({ assigned_at: 1 }).lean();
    if (open.length === 0) return res.json({ tasks: [] });

    const userId = req.user?.id || req.user?._id || null;
    const months = [...new Set(open.map(t => t.month))];
    const issuesByMonth = new Map();
    for (const m of months) issuesByMonth.set(m, await punchIssues(m));

    const branchDocs = await Branch.find({ _id: { $in: open.map(t => t.branch_id) } }).select('name').lean();
    const branchName = (id) => (branchDocs.find(b => String(b._id) === String(id)) || {}).name || '';

    const tasks = [];
    for (const t of open) {
      const { missing, duplicates } = issuesByMonth.get(t.month);
      const stillMissing = missing.filter(m => String(m.branch_id) === String(t.branch_id));
      const stillDups = duplicates.filter(d => String(d.branch_id) === String(t.branch_id));

      // Nothing left to do → close it without asking anyone.
      if (stillMissing.length === 0 && stillDups.length === 0) {
        await PunchEntryTask.updateOne({ _id: t._id }, {
          $set: { status: 'done', completed_at: new Date(), auto_completed: true },
        });
        continue;
      }

      await PunchEntryTask.updateOne({ _id: t._id }, {
        $set: { last_seen_at: new Date(), ...(t.first_seen_at ? {} : { first_seen_at: new Date() }) },
        $inc: { seen_count: 1 },
        ...(userId ? { $addToSet: { seen_by: userId } } : {}),
      });

      tasks.push({
        id: String(t._id),
        month: t.month,
        branch_id: String(t.branch_id),
        branch_name: branchName(t.branch_id),
        assigned_at: t.assigned_at,
        reminder_count: t.reminder_count,
        missing: stillMissing.map(m => ({
          employee_id: m.employee_id, full_name: m.full_name, date: m.date, punch_hhmm: m.punch_hhmm,
        })),
        duplicates_count: stillDups.length,
      });
    }

    res.json({ tasks });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/punch-entry-tasks/:id/done
 * Body: { note? }
 *
 * The manager declaring the branch handled. While days are still open a note is
 * REQUIRED — some lone punches can never be "completed" (the employee wasn't
 * there at all), and accounting needs to be told which, not left guessing.
 */
async function completePunchEntryTask(req, res, next) {
  try {
    const task = await PunchEntryTask.findById(req.params.id);
    if (!task || task.status !== 'open') return res.status(404).json({ error: 'משימה לא נמצאה' });

    const scope = branchScopeOf(req);
    if (scope && !scope.map(String).includes(String(task.branch_id))) {
      return res.status(403).json({ error: 'המשימה אינה של סניף שבאחריותך' });
    }

    const { missing } = await punchIssues(task.month);
    const left = missing.filter(m => String(m.branch_id) === String(task.branch_id)).length;
    const note = (req.body?.note || '').trim();
    if (left > 0 && !note) {
      return res.status(400).json({
        error: `נותרו ${left} ימים ללא השלמה — יש לכתוב הערה שמסבירה למה (למשל: העובדת לא עבדה באותו יום)`,
        remaining: left,
      });
    }

    task.status = 'done';
    task.completed_at = new Date();
    task.completed_by = req.user?.id || req.user?._id || null;
    task.completed_note = note;
    await task.save();
    res.json({ ok: true, remaining: left });
  } catch (err) { next(err); }
}

async function sendToAccountant(req, res, next) {
  try {
    const { month } = req.params;
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM נדרש' });
    const branch = req.query.branch || 'all';

    // HARD GATE: no month leaves while any >2-punch day anywhere is unapproved.
    // The response carries the FULL fix-list (duplicates + missing punches) so
    // the UI can show exactly what has to be sorted out.
    const issues = await punchIssues(month);
    if (issues.duplicates.length > 0) {
      return res.status(409).json({
        error: `לא ניתן לשלוח לרו״ח — ${issues.duplicates.length} ימים עם יותר מ-2 החתמות ממתינים לאישור הנה״ח (בכל הגנים).`,
        duplicates: issues.duplicates,
        missing: issues.missing,
      });
    }

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
    const branchNameById = new Map((data.branches || []).map(b => [String(b.id), b.name]));
    const html = buildAccountantHtml(month, rows, branchNameById);

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
    const FILE_BUDGET = 14 * 1024 * 1024; // base64 chars per email (headroom under GmailApp's 25MB)
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
          ? intro  // short body only — the 84 cards go as the attached PDF, not inline (GmailApp caps body size)
          : `<div dir="rtl" style="font-family:Arial,sans-serif"><p>המשך — מסמכים תומכים לחודש <b>${month}</b> (חלק ${i + 1} מתוך ${batches.length}).</p></div>`,
        attachments: first ? [{ name: `כרטיסי שכר ${month}`, html }] : [], // GAS → print-ready PDF (first email only)
        fileAttachments: batches[i],
      });
      provider = r?.provider || provider;
    }
    console.log(`accountant send complete: ${month} → ${to.join(', ')} · ${rows.length} emp · ${batches.length} emails · ${provider}`);
    try { await Setting.findOneAndUpdate({ key: 'last_accountant_send' }, { value: { at: new Date().toISOString(), ok: true, month, provider, emails: batches.length, employees: rows.length, files: fileAttachments.length, to } }, { upsert: true }); } catch (_) {}
    } catch (e) {
      console.error('accountant send (bg) failed:', e.message, JSON.stringify(e.detail || e.code || ''));
      // Record the failure so it can be diagnosed (read from the settings store).
      try { await Setting.findOneAndUpdate({ key: 'last_accountant_send' }, { value: { at: new Date().toISOString(), ok: false, month, message: e.message, code: e.code || null, responseCode: e.responseCode || null, detail: e.detail || null } }, { upsert: true }); } catch (_) {}
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
  getPregnancySettings,
  setPregnancySettings,
  resolvePunchDay,
  unresolvePunchDay,
  punchReviewStatus,
  remindBranchManager,
  assignPunchEntry,
  myPunchEntryTasks,
  completePunchEntryTask,
  resolveFixedConflict,
  splitCrossBranchDay,
  listSpecialDays,
  createSpecialDay,
  updateSpecialDay,
  deleteSpecialDay,
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
  decideAdjustment,
  decideAdjustmentsBulk,
  myPayrollUpdates,
  myUpdateAbsences,
  myUpdatePunches,
  importCibus,
  applyAutoHolidays,
  applyVacationRequests,
  applyKindergartenVacationDays,
  // Internal helper reused by the per-employee hours report so it shows the
  // SAME authoritative shortfall/extra numbers as the salary table.
  fetchMonthData,
  buildAccountantHtml,
};
