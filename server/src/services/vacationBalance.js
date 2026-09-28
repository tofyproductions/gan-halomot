'use strict';

/**
 * The חופשה balance: what she has accrued, what she has taken, what is left.
 *
 * Until now this system recorded vacation days taken and never had a balance to
 * check them against — the payroll's own comment said "drawn from balance" next
 * to a number drawn from nothing. The balance lived only on the accountant's
 * payslip, which meant nobody here could answer "how many days do I have?"
 * without waiting for a payslip that arrives after the leave was already taken.
 *
 * ── Why the accrual rate is per-employee and stored, not computed ──
 *
 * Sick leave accrues at one statutory rate for everyone (1.5 a month), so
 * services/sickPay.js can hard-code it. Vacation cannot: the entitlement
 * depends on seniority and on the agreed job scope, and this gan's staff range
 * from 0.18 to 1.167 days a month in the accountant's own records. There is no
 * formula here that would reproduce those numbers, and inventing one would
 * quietly disagree with the payslip the employee actually receives.
 *
 * So the rate is a FIELD, imported from the accountant's דוח העדרויות along
 * with the opening balance. An employee with no rate on file accrues NOTHING
 * rather than a guessed default: a balance that is too low prompts a question,
 * while one that is too high is leave the gan did not owe and cannot take back.
 *
 * ── What this deliberately does NOT do ──
 *
 * It does not reduce anybody's pay. The sick path caps sick pay at the balance
 * because the statute says what is payable; vacation days here are entered by
 * the office as a fact of what was taken, and silently paying fewer of them
 * because a balance says so would change wages on the strength of an imported
 * spreadsheet. Overdrawn leave is REPORTED (`overdrawn`), and a person decides.
 */

/** Whole months from the end of `asOfMonth` to `targetMonth`; never negative. */
function monthsElapsed(asOfMonth, targetMonth) {
  if (!asOfMonth || !targetMonth) return 0;
  const [ay, am] = String(asOfMonth).split('-').map(Number);
  const [ty, tm] = String(targetMonth).split('-').map(Number);
  if (!ay || !am || !ty || !tm) return 0;
  const diff = (ty - ay) * 12 + (tm - am);
  return diff < 0 ? 0 : diff;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Gross days accrued by the END of `targetMonth`.
 *
 * Returns null — not 0 — when there is no opening month on file. Null means
 * "unknown", and the difference matters: zero would tell an employee she has
 * no leave, which is a statement, while null lets every caller show nothing
 * instead of something false.
 *
 * @param {{days?:number, as_of_month?:string}} opening
 * @param {number} monthlyAccrual  days per month, from the employee's record
 * @param {string} targetMonth     'YYYY-MM'
 */
function accruedVacation(opening, monthlyAccrual, targetMonth) {
  const asOf = opening?.as_of_month || null;
  if (!asOf) return null;
  const openDays = Number(opening?.days) || 0; // may be negative: an overdraft carries
  const rate = Math.max(0, Number(monthlyAccrual) || 0);
  return round3(openDays + rate * monthsElapsed(asOf, targetMonth));
}

/**
 * The full picture for one employee at one month.
 *
 * `usedSinceOpening` is days taken in the months AFTER as_of_month and up to
 * and including targetMonth. Days taken before that are already inside the
 * opening figure — counting them again would charge the same leave twice, and
 * that is the single easiest way to get this wrong.
 *
 * @returns {null|{accrued:number, used:number, available:number, overdrawn:boolean, as_of_month:string, monthly_accrual:number}}
 */
function vacationBalance(opening, monthlyAccrual, targetMonth, usedSinceOpening = 0) {
  const accrued = accruedVacation(opening, monthlyAccrual, targetMonth);
  if (accrued === null) return null;
  const used = Math.max(0, Number(usedSinceOpening) || 0);
  const available = round3(accrued - used);
  return {
    accrued,
    used: round3(used),
    available,
    // Reported, never enforced — see the note at the top of this file.
    overdrawn: available < 0,
    as_of_month: opening.as_of_month,
    monthly_accrual: Math.max(0, Number(monthlyAccrual) || 0),
  };
}

/**
 * How many vacation days may actually be FILED for the month.
 *
 * She was away seven days; her balance holds two. The accountant is sent two,
 * because paid vacation is drawn from a balance and a balance cannot go below
 * nothing — filing seven would pay five days of leave she has not earned, and
 * the payslip would then report a balance that never existed.
 *
 * The other five days do not vanish from the record. They come back as
 * `unpaid`, with the reason, so the office sees that a person was absent for
 * days nobody is paying for and can decide what they were — unpaid leave, a
 * correction to the balance, or an advance the gan chooses to grant. That
 * decision is a person's; this function only refuses to invent the days.
 *
 * With no balance on file (`available` null) NOTHING is capped: an unknown
 * balance must not silently reduce what an employee is paid. That is the whole
 * difference between "she has two days" and "we do not know how many she has".
 *
 * @param {number} taken       days the office recorded for the month
 * @param {number|null} available  days in hand, or null when unknown
 * @returns {{paid:number, unpaid:number, capped:boolean, available:number|null}}
 */
function vacationUsageForMonth(taken, available) {
  const want = Math.max(0, Number(taken) || 0);
  if (available == null || !Number.isFinite(Number(available))) {
    return { paid: want, unpaid: 0, capped: false, available: null };
  }
  const have = Math.max(0, round3(Number(available)));
  if (want <= have) return { paid: want, unpaid: 0, capped: false, available: have };
  return { paid: have, unpaid: round3(want - have), capped: true, available: have };
}

module.exports = {
  monthsElapsed, accruedVacation, vacationBalance, vacationUsageForMonth, round3,
};
