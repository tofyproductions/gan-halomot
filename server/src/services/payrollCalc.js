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
  const first = dist.find(d => d.hourly_rate || d.global_salary) || {};
  return {
    hourly_rate:    Number(first.hourly_rate) || 0,
    global_salary:  Number(first.global_salary) || 0,
    global_ot_rate: Number(first.global_ot_rate) || 0,
    required_hours: Number(first.required_hours) || 0,
  };
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
  // Bucket by Israel-local day
  const byDay = new Map();
  for (const p of punches) {
    const key = israelDateKey(new Date(p.timestamp));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(p);
  }

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
  }
  const hoursWorked  = Math.round((totalMinutes / 60) * 100) / 100;
  const regHours     = Math.round((regMinutes / 60) * 100) / 100;
  const ot125Hours   = Math.round((ot125Minutes / 60) * 100) / 100;
  const ot150Hours   = Math.round((ot150Minutes / 60) * 100) / 100;
  const daysWorked   = days.length;

  const rates = primaryRates(employee);

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
  const travel     = Number(employee.travel_allowance) || 0;
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
  };
}

module.exports = { calculateMonthlySalary };
