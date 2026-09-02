/**
 * דמי הבראה — the annual August payment, computed per employee.
 *
 * The legal frame (צו ההרחבה בדבר תשלום דמי הבראה, private sector):
 *   - Entitlement begins only after COMPLETING one year of employment.
 *   - Days by seniority: year 1 → 5, years 2–3 → 6, years 4–10 → 7,
 *     years 11–15 → 8, years 16–19 → 9, 20+ → 10.
 *   - Part-time staff get the proportional share of their היקף משרה.
 *   - The per-day rate is updated periodically (kept in Setting
 *     'recreation_day_rate' — DEFAULT_DAY_RATE is only the fallback; the
 *     office confirms the current figure with the accountant).
 *
 * Strictly by the צו (office decision, 2026-09-02): an employee who has NOT
 * yet completed a full year by August is paid NOTHING this August — her first
 * recreation payment comes the following August, once the year is complete.
 * She is still listed (basis 'not_yet_eligible', amount 0) so the accountant
 * sees WHY the cell is empty rather than wondering if it was missed.
 *
 * Pure math, no database — scripts/recreation-pay.test.js requires it as-is.
 */

const DEFAULT_DAY_RATE = 418;   // ₪ per day, private sector — CONFIRM yearly
const FULL_TIME_WEEKLY_HOURS = 42; // צו ההרחבה's full-time week

/** Annual recreation days for an employee who has COMPLETED `years` years. */
function recreationDaysForYears(years) {
  if (years >= 20) return 10;
  if (years >= 16) return 9;
  if (years >= 11) return 8;
  if (years >= 4) return 7;
  if (years >= 2) return 6;
  if (years >= 1) return 5;
  return 0;
}

/** Whole months between start and the END of `month` ('YYYY-MM'). */
function monthsWorkedByEndOf(startDate, month) {
  if (!startDate) return null;
  const s = new Date(startDate);
  if (Number.isNaN(s.getTime())) return null;
  const [y, m] = month.split('-').map(Number);
  const months = (y - s.getUTCFullYear()) * 12 + (m - (s.getUTCMonth() + 1))
    + (s.getUTCDate() <= 15 ? 1 : 0); // a mid-month start counts its first month from the 16th
  return Math.max(0, months);
}

/**
 * The August suggestion for one employee.
 * @param {String|Date} startDate  employment start
 * @param {String} month           'YYYY-08'
 * @param {Number} weeklyHours     committed weekly hours (null/0 → full time)
 * @param {Number} dayRate         current per-day rate
 * @returns {Object|null} null when there is nothing to pay.
 */
function computeRecreation({ startDate, month, weeklyHours = null, dayRate = DEFAULT_DAY_RATE }) {
  const months = monthsWorkedByEndOf(startDate, month);
  if (months == null || months <= 0) return null;

  const fte = (Number(weeklyHours) > 0)
    ? Math.min(1, Math.round((Number(weeklyHours) / FULL_TIME_WEEKLY_HOURS) * 100) / 100)
    : 1;

  const fullYears = Math.floor(months / 12);
  if (fullYears < 1) {
    // The צו grants nothing before a completed year — listed with a zero so
    // the empty cell reads as "not yet", never as "forgotten".
    return {
      months_worked: months,
      full_years: 0,
      days: 0,
      fte,
      day_rate: dayRate,
      amount: 0,
      basis: 'not_yet_eligible',
    };
  }
  const days = recreationDaysForYears(fullYears);
  const amount = Math.round(days * dayRate * fte);
  return {
    months_worked: months,
    full_years: fullYears,
    days,
    fte,
    day_rate: dayRate,
    amount,
    basis: 'annual',
  };
}

module.exports = {
  DEFAULT_DAY_RATE,
  FULL_TIME_WEEKLY_HOURS,
  recreationDaysForYears,
  monthsWorkedByEndOf,
  computeRecreation,
};
