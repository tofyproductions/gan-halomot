/**
 * Payroll calculator — estimate a single employee's salary for a given month
 * from their configured rates, their actual punches, and their static extras.
 *
 * This is NOT a legal-grade payroll engine. It deliberately DOES NOT:
 *   - Compute income tax (מס הכנסה) or bituach leumi
 *   - Apply pension/savings deductions beyond the flat flags already stored
 *   - Distinguish night hours, Shabbat hours, holiday premiums
 *   - Split across the three amutot (we roll everything under the primary)
 *
 * What it DOES do (good enough for a live "expected salary" column):
 *   - Pair punches into in/out sessions per day (Asia/Jerusalem timezone)
 *   - Compute total worked hours; split into regular / OT 125% / OT 150%
 *     using the standard Israeli split: first 8h/day = regular, next 2h = 125%,
 *     above 10h = 150%
 *   - Hourly employees:  gross = regular × rate + OT125 × rate × 1.25 + OT150 × rate × 1.5
 *   - Global employees:  gross = global_salary + (overtime_hours × global_ot_rate)
 *                        flagged "חסרות שעות" if hours_worked < required_hours
 *   - Add monthly extras (travel, meal vouchers, pro-rated recreation)
 *   - Subtract active loan installments for this month
 *   - Add active per-hour bonuses × hours_worked, per-day bonuses × days_worked,
 *     fixed bonuses once per month
 *   - Return a breakdown the UI can render + an estimated total
 */

const IL_TZ = 'Asia/Jerusalem';

function israelDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IL_TZ }).format(date);
}

/**
 * Pair a sorted array of punches into in/out sessions and return total
 * worked minutes. Odd punch count → last one is a "trailing" punch we treat
 * as 0 minutes and flag the day as incomplete.
 */
function pairDayMinutes(dayPunches) {
  const sorted = [...dayPunches].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  let total = 0;
  for (let i = 0; i + 1 < sorted.length; i += 2) {
    const inT = new Date(sorted[i].timestamp).getTime();
    const outT = new Date(sorted[i + 1].timestamp).getTime();
    const diff = Math.max(0, Math.round((outT - inT) / 60000));
    total += diff;
  }
  const incomplete = sorted.length % 2 === 1;
  return { minutes: total, incomplete };
}

/**
 * Split a day's worked minutes into regular / OT125 / OT150 buckets.
 * Standard Israel rule: first 8h regular, next 2h at 125%, above 10h at 150%.
 */
function splitDayOvertime(totalMinutes) {
  const reg = Math.min(totalMinutes, 8 * 60);
  const after8 = Math.max(0, totalMinutes - 8 * 60);
  const ot125 = Math.min(after8, 2 * 60);
  const ot150 = Math.max(0, after8 - 2 * 60);
  return { reg, ot125, ot150 };
}

/**
 * For a loan to be deducted this month:
 *   - installments_paid < installments_total
 *   - (optional) started_at ≤ this month
 * We don't yet track month-by-month payment history — `installments_paid` is
 * the caller's responsibility to advance. This function just tells you how
 * much to deduct THIS run.
 */
function loanDeductionThisMonth(loan) {
  if (!loan) return 0;
  if ((loan.installments_paid || 0) >= (loan.installments_total || 0)) return 0;
  return Number(loan.installment_amount) || 0;
}

function bonusAmountThisMonth(bonus, { hoursWorked, daysWorked, refDate }) {
  if (!bonus || bonus.active === false) return 0;
  if (bonus.effective_from && new Date(bonus.effective_from) > refDate) return 0;
  if (bonus.effective_to && new Date(bonus.effective_to) < refDate) return 0;
  const amt = Number(bonus.amount) || 0;
  switch (bonus.type) {
    case 'per_hour': return amt * hoursWorked;
    case 'per_day':  return amt * daysWorked;
    case 'fixed':
    default:         return amt;
  }
}

function primaryRates(employee) {
  const dist = Array.isArray(employee.amuta_distribution) ? employee.amuta_distribution : [];
  const first = dist.find(d => d.hourly_rate || d.global_salary) || dist[0] || {};
  // amuta_id may be either a raw ObjectId or a populated document — normalize to a string id.
  const rawAmutaId = first.amuta_id;
  const amutaIdStr = rawAmutaId
    ? String(rawAmutaId._id || rawAmutaId)
    : null;
  return {
    hourly_rate:    Number(first.hourly_rate) || 0,
    global_salary:  Number(first.global_salary) || 0,
    global_ot_rate: Number(first.global_ot_rate) || 0,
    required_hours: Number(first.required_hours) || 0,
    primary_amuta_id: amutaIdStr,
  };
}

/**
 * Returns an empty per-amuta breakdown bucket.
 */
function emptyAmutaBucket() {
  return {
    days_worked: 0,
    regular_hours: 0,
    ot_125_hours: 0,
    ot_150_hours: 0,
    hourly_rate: 0,
    global_salary: 0,
    global_ot_rate: 0,
  };
}

/**
 * Split per-day hours into per-amuta buckets.
 *
 * Branches→amuta mapping comes from `branchAmutaMap`: a Map<branch_id_string, amuta_id_string>.
 * For each day, each punch's branch is resolved to an amuta; if all punches that
 * day are in the same amuta, the entire day's regular/OT hours go to that amuta.
 * If punches mix amutot (rare), we fall back to splitting by minute-share.
 *
 * Employees with no amuta mapping for a branch fall back to their primary amuta.
 */
/**
 * Same as splitDayIntoAmutas but bucketed by branch_id of the in-punch.
 * Used for the per-branch column groups in the monthly payroll UI.
 */
function splitDayIntoBranches(dayPunches) {
  const sorted = [...dayPunches].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const perBranchMinutes = new Map();
  for (let i = 0; i + 1 < sorted.length; i += 2) {
    const inP = sorted[i];
    const outP = sorted[i + 1];
    const inT = new Date(inP.timestamp).getTime();
    const outT = new Date(outP.timestamp).getTime();
    const minutes = Math.max(0, Math.round((outT - inT) / 60000));
    if (minutes <= 0) continue;
    const branchId = String(inP.branch_id);
    perBranchMinutes.set(branchId, (perBranchMinutes.get(branchId) || 0) + minutes);
  }
  return perBranchMinutes;
}

function splitDayIntoAmutas(dayPunches, branchAmutaMap, fallbackAmutaId) {
  const sorted = [...dayPunches].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  // Build sessions of (in,out) pairs and attribute the minutes to the in-punch's amuta
  const perAmutaMinutes = new Map(); // amutaIdStr → minutes
  for (let i = 0; i + 1 < sorted.length; i += 2) {
    const inP = sorted[i];
    const outP = sorted[i + 1];
    const inT = new Date(inP.timestamp).getTime();
    const outT = new Date(outP.timestamp).getTime();
    const minutes = Math.max(0, Math.round((outT - inT) / 60000));
    if (minutes <= 0) continue;
    const branchId = String(inP.branch_id);
    const amutaId = branchAmutaMap.get(branchId) || fallbackAmutaId || 'unmapped';
    perAmutaMinutes.set(amutaId, (perAmutaMinutes.get(amutaId) || 0) + minutes);
  }
  return perAmutaMinutes;
}

/**
 * @param {Object} employee  — a plain Employee object (or Mongoose lean)
 * @param {Array}  punches   — Punch records for this employee in the month
 * @param {String} monthYM   — "YYYY-MM"
 * @param {Object} opts      — optional overrides
 * @param {Boolean} opts.force_full_global — if true, global employees get full
 *   salary even if they didn't complete required hours. If false (default),
 *   the salary is pro-rated: (hours_worked / required_hours) × global_salary.
 *   The admin can toggle this per employee from the UI.
 * @returns breakdown object
 */
function calculateMonthlySalary(employee, punches, monthYM, opts = {}) {
  const forceFullGlobal = opts.force_full_global || false;
  const branchAmutaMap = opts.branchAmutaMap || new Map();

  // Salary excludes any punch that is pending review or has been rejected by
  // the branch manager. Punches with no approval_status (legacy) are treated
  // as 'auto' (counted). Approved manual punches count.
  const countablePunches = punches.filter(p => {
    const s = p.approval_status || 'auto';
    return s === 'auto' || s === 'approved';
  });

  // Bucket by Israel-local day
  const byDay = new Map();
  for (const p of countablePunches) {
    const key = israelDateKey(new Date(p.timestamp));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(p);
  }

  // Per-amuta buckets — populated alongside total counters below
  const amutaBuckets = new Map();   // amutaIdStr → bucket
  const branchBuckets = new Map();  // branchIdStr → bucket

  const rates = primaryRates(employee);
  const fallbackAmutaId = rates.primary_amuta_id;

  const days = [];
  let totalMinutes = 0;
  let regMinutes = 0, ot125Minutes = 0, ot150Minutes = 0;
  let incompleteDays = 0;
  for (const [date, dayPunches] of [...byDay.entries()].sort()) {
    const pair = pairDayMinutes(dayPunches);
    const split = splitDayOvertime(pair.minutes);
    totalMinutes += pair.minutes;
    regMinutes += split.reg;
    ot125Minutes += split.ot125;
    ot150Minutes += split.ot150;
    if (pair.incomplete) incompleteDays++;
    days.push({ date, minutes: pair.minutes, incomplete: pair.incomplete, ...split });

    // Per-amuta + per-branch attribution: each in-punch contributes minutes
    // to its own branch's bucket and to that branch's amuta bucket.
    const dayAmutaMinutes = splitDayIntoAmutas(dayPunches, branchAmutaMap, fallbackAmutaId);
    const dayTotal = pair.minutes;

    // Compute per-branch minute share within this day too.
    const dayBranchMinutes = splitDayIntoBranches(dayPunches);

    if (dayTotal > 0) {
      for (const [amutaId, minutes] of dayAmutaMinutes) {
        const share = minutes / dayTotal;
        if (!amutaBuckets.has(amutaId)) amutaBuckets.set(amutaId, emptyAmutaBucket());
        const bk = amutaBuckets.get(amutaId);
        bk._minutes_total = (bk._minutes_total || 0) + minutes;
        bk._minutes_regular = (bk._minutes_regular || 0) + split.reg * share;
        bk._minutes_ot125 = (bk._minutes_ot125 || 0) + split.ot125 * share;
        bk._minutes_ot150 = (bk._minutes_ot150 || 0) + split.ot150 * share;
        bk._day_minute_map = bk._day_minute_map || new Map();
        bk._day_minute_map.set(date, (bk._day_minute_map.get(date) || 0) + minutes);
      }
      for (const [branchId, minutes] of dayBranchMinutes) {
        const share = minutes / dayTotal;
        if (!branchBuckets.has(branchId)) branchBuckets.set(branchId, emptyAmutaBucket());
        const bk = branchBuckets.get(branchId);
        bk._minutes_total = (bk._minutes_total || 0) + minutes;
        bk._minutes_regular = (bk._minutes_regular || 0) + split.reg * share;
        bk._minutes_ot125 = (bk._minutes_ot125 || 0) + split.ot125 * share;
        bk._minutes_ot150 = (bk._minutes_ot150 || 0) + split.ot150 * share;
        bk._day_minute_map = bk._day_minute_map || new Map();
        bk._day_minute_map.set(date, (bk._day_minute_map.get(date) || 0) + minutes);
      }
    }
  }
  const hoursWorked  = Math.round((totalMinutes / 60) * 100) / 100;
  const regHours     = Math.round((regMinutes / 60) * 100) / 100;
  const ot125Hours   = Math.round((ot125Minutes / 60) * 100) / 100;
  const ot150Hours   = Math.round((ot150Minutes / 60) * 100) / 100;
  const daysWorked   = days.length;

  const finalizeBuckets = (buckets, applyRatesTo = null) => {
    const dayWinner = new Map(); // date → winning key
    for (const [key, bk] of buckets) {
      if (!bk._day_minute_map) continue;
      for (const [date, minutes] of bk._day_minute_map) {
        const cur = dayWinner.get(date);
        if (!cur || minutes > cur.minutes) dayWinner.set(date, { key, minutes });
      }
    }
    for (const [key, bk] of buckets) {
      bk.regular_hours = Math.round((bk._minutes_regular || 0) / 60 * 100) / 100;
      bk.ot_125_hours  = Math.round((bk._minutes_ot125 || 0) / 60 * 100) / 100;
      bk.ot_150_hours  = Math.round((bk._minutes_ot150 || 0) / 60 * 100) / 100;
      bk.days_worked   = [...dayWinner.entries()].filter(([, v]) => v.key === key).length;
      if (applyRatesTo === key) {
        bk.hourly_rate = rates.hourly_rate;
        bk.global_salary = rates.global_salary;
        bk.global_ot_rate = rates.global_ot_rate;
      }
      delete bk._minutes_total;
      delete bk._minutes_regular;
      delete bk._minutes_ot125;
      delete bk._minutes_ot150;
      delete bk._day_minute_map;
    }
  };

  finalizeBuckets(amutaBuckets, fallbackAmutaId);
  // Each branch the employee worked at gets the employee's standard rates —
  // hours at any branch are paid at the same hourly_rate / global_salary.
  const primaryBranchId = employee.branch_id ? String(employee.branch_id._id || employee.branch_id) : null;
  finalizeBuckets(branchBuckets, primaryBranchId);
  // Fall back: even if employee has no punches anywhere else, make sure their
  // home branch has rate columns populated so the UI shows the rate values.
  if (primaryBranchId && !branchBuckets.has(primaryBranchId)) {
    const bk = emptyAmutaBucket();
    bk.hourly_rate = rates.hourly_rate;
    bk.global_salary = rates.global_salary;
    bk.global_ot_rate = rates.global_ot_rate;
    branchBuckets.set(primaryBranchId, bk);
  }
  // Also populate rates for every branch where the employee did work (so the
  // table shows the same hourly/global figure under each branch they punched at).
  for (const [bId, bk] of branchBuckets) {
    if (bk.hourly_rate === 0 && bk.global_salary === 0) {
      bk.hourly_rate = rates.hourly_rate;
      bk.global_salary = rates.global_salary;
      bk.global_ot_rate = rates.global_ot_rate;
    }
  }

  // --- Base pay ---
  let baseSalary = 0;
  const warnings = [];
  if (employee.salary_type === 'hourly') {
    baseSalary = regHours * rates.hourly_rate
               + ot125Hours * rates.hourly_rate * 1.25
               + ot150Hours * rates.hourly_rate * 1.5;
    if (rates.hourly_rate === 0) warnings.push('אין תעריף שעתי מוגדר');
  } else { // global
    let globalProrateRatio = 1; // default: full salary
    if (rates.required_hours > 0 && hoursWorked >= rates.required_hours) {
      // Met or exceeded requirements → full salary + overtime
      baseSalary = rates.global_salary;
      const overtimeHours = hoursWorked - rates.required_hours;
      if (overtimeHours > 0 && rates.global_ot_rate > 0) {
        baseSalary += overtimeHours * rates.global_ot_rate;
      }
    } else if (rates.required_hours > 0 && hoursWorked < rates.required_hours) {
      // Did NOT meet requirements
      if (forceFullGlobal) {
        // Admin chose to pay full salary anyway
        baseSalary = rates.global_salary;
      } else {
        // Pro-rate: (hours_worked / required_hours) × global_salary
        globalProrateRatio = hoursWorked / rates.required_hours;
        baseSalary = rates.global_salary * globalProrateRatio;
        warnings.push(`חסרות שעות: ${hoursWorked}h מתוך ${rates.required_hours}h — שכר יחסי (${Math.round(globalProrateRatio * 100)}%)`);
      }
    } else {
      // No required_hours set → full salary
      baseSalary = rates.global_salary;
    }
    if (rates.global_salary === 0) warnings.push('אין שכר גלובלי מוגדר');
  }

  // --- Extras ---
  // Travel: prefer the new per_day/monthly_flat fields. Legacy employees
  // (created before the travel_mode field existed) default to 16 ₪/day if
  // they have no travel_allowance configured.
  //
  // Cap: in per_day mode the result never exceeds the monthly free-pass
  // price (315₪). monthly_flat is treated as an explicit override and
  // skips the cap.
  const TRAVEL_PER_DAY_CAP = 315;
  let travel = 0;
  const mode = employee.travel_mode || 'per_day';
  if (mode === 'per_day') {
    const perDay = (employee.travel_per_day != null && employee.travel_per_day !== '')
      ? Number(employee.travel_per_day)
      : 16;
    travel = Math.min(perDay * daysWorked, TRAVEL_PER_DAY_CAP);
  } else if (mode === 'monthly_flat') {
    travel = Number(employee.travel_monthly_flat) || Number(employee.travel_allowance) || 0;
  } else {
    travel = Number(employee.travel_allowance) || 0;
  }
  const meal       = Number(employee.meal_vouchers) || 0;
  const recreation = (Number(employee.recreation_annual) || 0) / 12; // pro-rate annually

  // --- Loan deductions ---
  const loans = Array.isArray(employee.loans) ? employee.loans : [];
  let loanDeductions = 0;
  const loanDetails = [];
  for (const l of loans) {
    const amt = loanDeductionThisMonth(l);
    if (amt > 0) {
      loanDeductions += amt;
      loanDetails.push({
        installment_amount: amt,
        paid_so_far: l.installments_paid || 0,
        total_installments: l.installments_total || 0,
        notes: l.notes || '',
      });
    }
  }

  // --- Bonuses ---
  const refDate = new Date(`${monthYM}-15T12:00:00Z`);
  const bonuses = Array.isArray(employee.bonuses) ? employee.bonuses : [];
  let bonusTotal = 0;
  const bonusDetails = [];
  for (const b of bonuses) {
    const amt = bonusAmountThisMonth(b, { hoursWorked, daysWorked, refDate });
    if (amt > 0) {
      bonusTotal += amt;
      bonusDetails.push({ type: b.type, amount: amt, reason: b.reason || '' });
    }
  }

  // --- Absence / incomplete flags ---
  if (incompleteDays > 0) warnings.push(`${incompleteDays} ימים עם החתמה חסרה`);
  if (daysWorked === 0) warnings.push('אין נתוני החתמה כלל החודש');

  // --- Final total (this is NOT net pay — no tax/pension withholding) ---
  const grossBeforeDeductions =
    baseSalary + travel + meal + recreation + bonusTotal;
  const estimatedTotal = Math.round((grossBeforeDeductions - loanDeductions) * 100) / 100;

  return {
    month: monthYM,
    employee_id: employee._id || employee.id,
    employee_name: employee.full_name,
    salary_type: employee.salary_type,
    salary_is_net: !!employee.salary_is_net,
    force_full_global: forceFullGlobal,
    hours: {
      total: hoursWorked,
      regular: regHours,
      ot_125: ot125Hours,
      ot_150: ot150Hours,
      days_worked: daysWorked,
      incomplete_days: incompleteDays,
    },
    rates,
    components: {
      base_salary:    Math.round(baseSalary * 100) / 100,
      travel,
      meal_vouchers:  meal,
      recreation_monthly: Math.round(recreation * 100) / 100,
      bonuses:        Math.round(bonusTotal * 100) / 100,
      bonus_details:  bonusDetails,
    },
    deductions: {
      loans:        Math.round(loanDeductions * 100) / 100,
      loan_details: loanDetails,
    },
    estimated_total: estimatedTotal,
    warnings,
    days,
    // Per-amuta breakdown (keyed by amuta_id string).
    per_amuta: Object.fromEntries([...amutaBuckets.entries()]),
    // Per-branch breakdown (keyed by branch_id string). Drives the per-branch
    // column groups in the monthly payroll table (each branch gets its own colour).
    per_branch: Object.fromEntries([...branchBuckets.entries()]),
  };
}

module.exports = { calculateMonthlySalary };
