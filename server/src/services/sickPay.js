/**
 * Israeli statutory sick pay — חוק דמי מחלה (התשל"ו-1976).
 *
 * Core rules implemented here:
 *  - Each sick certificate is treated as its OWN spell ("אין רצף") — the day
 *    brackets restart for every certificate. Two certificates in the same month
 *    are NEVER merged into one continuous period, so the employee gets less than
 *    one long period would yield. This is deliberate, per the business rule.
 *  - Statutory brackets within a single spell of consecutive sick work-days:
 *        day 1      → 0%
 *        days 2-3   → 50%
 *        day 4+     → 100%
 *  - "Pay from first day" (a per-certificate toggle, or an employee whose policy
 *    is 'full') pays every day at 100%.
 *  - Accrual: 1.5 sick days per worked month, capped at 90 days total balance.
 *    Paid days are limited to the balance available — days beyond the balance
 *    are recorded but pay nothing.
 *
 * All functions here are PURE (no DB). The controller resolves the daily wage
 * value and the available balance, then calls in.
 */

const STATUTORY_MONTHLY_ACCRUAL = 1.5;
const STATUTORY_MAX_BALANCE = 90;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Paid day-equivalents for ONE spell of `workDays` consecutive sick work-days.
 * `fullFromDay1` pays every day at 100%.
 *
 * Examples (statutory): 1→0, 2→0.5, 3→1.0, 4→2.0, 6→4.0.
 */
function paidFractionForSpell(workDays, { fullFromDay1 = false } = {}) {
  const n = Math.max(0, Math.round(Number(workDays) || 0));
  if (n <= 0) return 0;
  if (fullFromDay1) return n; // every day at 100%
  let paid = 0;
  for (let i = 1; i <= n; i++) {
    if (i === 1) paid += 0;          // first day unpaid
    else if (i === 2 || i === 3) paid += 0.5; // 50%
    else paid += 1;                  // 100%
  }
  return paid;
}

/**
 * Compute sick pay for a list of certificates (each a separate spell), in the
 * order given (callers should pass them chronologically so the balance is
 * consumed oldest-first).
 *
 * @param {Array<{ id?, from_date?, to_date?, work_days:number, pay_from_first_day?:boolean }>} certs
 * @param {Object} opts
 * @param {number} opts.dailyValue        ₪ value of one full sick day
 * @param {number} opts.balanceAvailable  remaining accrued sick-day balance (days)
 * @param {boolean} opts.policyFull        employee-level "pay full from day 1"
 * @returns {{ results:Array, total_paid_days:number, total_amount:number, total_days_used:number, total_days_uncovered:number }}
 */
function computeSickPay(certs = [], opts = {}) {
  const dailyValue = Number(opts.dailyValue) || 0;
  const policyFull = !!opts.policyFull;
  let remainingBalance = opts.balanceAvailable == null ? Infinity : Number(opts.balanceAvailable);
  if (Number.isNaN(remainingBalance)) remainingBalance = Infinity;

  const results = (certs || []).map((c) => {
    const days = Math.max(0, Math.round(Number(c.work_days) || 0));
    const fullFromDay1 = !!c.pay_from_first_day || policyFull;
    // Balance caps how many of this certificate's days are eligible for pay.
    const coveredDays = Math.max(0, Math.min(days, remainingBalance));
    remainingBalance -= coveredDays;
    const paidDays = paidFractionForSpell(coveredDays, { fullFromDay1 });
    return {
      id: c.id != null ? c.id : null,
      from_date: c.from_date || null,
      to_date: c.to_date || c.from_date || null,
      work_days: days,
      covered_days: coveredDays,
      uncovered_days: days - coveredDays,
      paid_days: round2(paidDays),
      paid_amount: round2(paidDays * dailyValue),
      full_from_day_1: fullFromDay1,
    };
  });

  const totalPaidDays = round2(results.reduce((s, r) => s + r.paid_days, 0));
  const totalDaysUsed = results.reduce((s, r) => s + r.covered_days, 0);
  const totalUncovered = results.reduce((s, r) => s + r.uncovered_days, 0);
  return {
    results,
    total_paid_days: totalPaidDays,
    total_amount: round2(totalPaidDays * dailyValue),
    total_days_used: totalDaysUsed,
    total_days_uncovered: totalUncovered,
  };
}

/**
 * Whole months elapsed AFTER `asOfMonth` through `targetMonth` (both 'YYYY-MM').
 * Exclusive of the as-of month, because the opening balance is defined as the
 * balance at the END of as_of_month (its accrual is already baked in). So at
 * target === as_of the result is 0 (no extra accrual yet).
 * Returns 0 if target is before asOf or inputs are bad.
 */
function monthsElapsed(asOfMonth, targetMonth) {
  if (!asOfMonth || !targetMonth) return 0;
  const [ay, am] = String(asOfMonth).split('-').map(Number);
  const [ty, tm] = String(targetMonth).split('-').map(Number);
  if (!ay || !am || !ty || !tm) return 0;
  const diff = (ty - ay) * 12 + (tm - am);
  return diff < 0 ? 0 : diff;
}

/**
 * Accrued balance ceiling at `targetMonth`: opening balance (as of the end of
 * its as_of_month) + 1.5 per FULL month elapsed since, capped at 90. This is the
 * GROSS accrual before subtracting days already used.
 *
 * @param {{ days?:number, as_of_month?:string }} opening
 * @param {string} targetMonth  'YYYY-MM'
 */
function accruedBalance(opening, targetMonth) {
  const openDays = Math.max(0, Number(opening?.days) || 0);
  const asOf = opening?.as_of_month || null;
  // If no opening month is set, accrue nothing extra — just the opening days.
  const months = asOf ? monthsElapsed(asOf, targetMonth) : 0;
  return Math.min(STATUTORY_MAX_BALANCE, openDays + STATUTORY_MONTHLY_ACCRUAL * months);
}

/**
 * Available balance = accrued ceiling − days already used in prior months.
 * `usedBeforeMonth` is the sum of covered sick work-days consumed in months
 * strictly before targetMonth. Never negative.
 */
function availableBalance(opening, targetMonth, usedBeforeMonth = 0) {
  const accrued = accruedBalance(opening, targetMonth);
  return Math.max(0, accrued - (Number(usedBeforeMonth) || 0));
}

module.exports = {
  STATUTORY_MONTHLY_ACCRUAL,
  STATUTORY_MAX_BALANCE,
  round2,
  paidFractionForSpell,
  computeSickPay,
  monthsElapsed,
  accruedBalance,
  availableBalance,
};
