'use strict';

/**
 * What one day of חופשה or מחלה is worth to an HOURLY employee.
 *
 * Both are averages over her own recent history rather than her current rate,
 * because an hourly wage is not a daily wage: a woman who worked 54 days in one
 * month and 4 in the next has no single "day" to be paid for, and picking the
 * current month would make a day of leave worth whatever that month happened to
 * be. The accountant's own ריכוז משכורות computes it the same way, and these
 * figures are checked against hers.
 *
 * ── The window ──
 *
 * The twelve months BEFORE the month being paid — September 2026 is paid from
 * September 2025 through August 2026. The current month is excluded because it
 * is not closed yet; including it would make the rate move as the month is
 * edited.
 *
 * Fewer than twelve is normal and not an error. This system has not been
 * running a year, and neither has every employee: whatever months exist are
 * used, and the window grows on its own as months accumulate. A first month
 * with no history behind it falls back to that month alone, which is the only
 * honest answer available.
 *
 * ── יום חופשה ──
 *
 *   (שכר יסוד + תמורת חופשה + ימי מחלה + ימי מילואים + ימי חג) ÷ ימים לתלוש
 *
 * That is a full-time day. A part-timer is paid a proportion of it:
 *
 *   מקדם = (שעות משולמות ÷ חודשים) ÷ 182
 *
 * capped at 1 — someone who averages more than a full post is still paid one
 * full day, never more.
 *
 * ── יום מחלה ──
 *
 * The same numerator, but divided by the MONTHS worked and then by 30 — a
 * monthly average spread over a calendar month rather than over the days
 * actually paid. It is a different denominator answering a different question,
 * and the two must not be collapsed into one function that "looks similar".
 */

/** שעות של משרה מלאה בחודש. */
const FULL_TIME_MONTHLY_HOURS = 182;

/** Days in a month, for the statutory sick-day divisor. */
const SICK_MONTH_DAYS = 30;

const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * The months to look at: up to twelve, ending the month before `month`.
 * @param {string} month 'YYYY-MM'
 * @param {number} [count=12]
 */
function lookbackMonths(month, count = 12) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return [];
  let y = Number(m[1]);
  let mo = Number(m[2]);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    mo -= 1;
    if (mo === 0) { mo = 12; y -= 1; }
    out.push(`${y}-${String(mo).padStart(2, '0')}`);
  }
  return out.reverse();
}

/**
 * Sum one employee's history into the figures both rates are built from.
 *
 * @param {Array<{month:string, base_salary?:number, vacation_pay?:number,
 *   sick_pay?:number, miluim_pay?:number, holiday_pay?:number,
 *   days_for_payslip?:number, paid_hours?:number}>} rows
 */
function aggregate(rows) {
  const months = (rows || []).filter((r) => r && r.month);
  let pay = 0;
  let days = 0;
  let hours = 0;
  let paidMonths = 0;

  for (const r of months) {
    // The five components the accountant's own summary adds up. נסיעות,
    // הבראה, שעות נוספות and הפרשים are NOT here — they are not part of the
    // daily value, and adding them would inflate every day of leave.
    const monthPay = num(r.base_salary) + num(r.vacation_pay) + num(r.sick_pay)
      + num(r.miluim_pay) + num(r.holiday_pay);
    const monthDays = num(r.days_for_payslip);
    const monthHours = num(r.paid_hours);

    pay += monthPay;
    days += monthDays;
    hours += monthHours;
    // A month counts when she was PAID for something, not only when she clocked
    // in: a month of מילואים has no worked hours and is still a month of
    // employment. Anything else would divide her average by the months she was
    // away and quietly reduce the rate.
    if (monthDays > 0 || monthPay > 0) paidMonths += 1;
  }

  return { pay: r2(pay), days: r2(days), hours: r2(hours), months: paidMonths, sourceMonths: months.length };
}

/**
 * @returns {null|{
 *   full_day:number, coefficient:number, vacation_day:number, sick_day:number,
 *   pay:number, days:number, hours:number, months:number, source_months:number
 * }}  null when there is nothing to compute from.
 */
function dayRatesFrom(rows) {
  const a = aggregate(rows);
  if (a.months === 0) return null;

  // A full-time day: the money spread over the days it was paid for.
  const fullDay = a.days > 0 ? r2(a.pay / a.days) : 0;

  // Her own scope against a full post, capped at one.
  const avgMonthlyHours = a.months > 0 ? a.hours / a.months : 0;
  const rawCoefficient = avgMonthlyHours / FULL_TIME_MONTHLY_HOURS;
  const coefficient = Math.min(1, Math.round(rawCoefficient * 10000) / 10000);

  // Sick pay is a monthly average over a calendar month — a different question
  // from "what is a day she was paid for", and so a different divisor.
  const sickDay = r2(a.pay / a.months / SICK_MONTH_DAYS);

  return {
    full_day: fullDay,
    coefficient,
    raw_coefficient: Math.round(rawCoefficient * 10000) / 10000,
    vacation_day: r2(fullDay * coefficient),
    sick_day: sickDay,
    pay: a.pay,
    days: a.days,
    hours: a.hours,
    months: a.months,
    source_months: a.sourceMonths,
  };
}

/**
 * שעות משולמות — the hours worked, plus the hours behind every paid day off.
 *
 * A paid day is worth, in HOURS, what it is worth in money divided by the value
 * of one hour. For an hourly employee that is the leave pay ÷ her rate: אדולה
 * מהרט's day of חופשה is ₪119.56 at ₪45 an hour, so each one adds 2.66 hours,
 * not the 6.76 of her average working day. Counting her average day made her
 * September read 30.54 paid hours for 17.02 worked and two days of leave,
 * where the payslip's own money says 22.33 — the part-time proportion the
 * day's value already carries (full day × מקדם), ignored in the hours.
 *
 * Because it goes by the money, a sick day on the unpaid first-day bracket adds
 * nothing, and a half-paid one adds half.
 *
 * With no value for an hour (no rate on the card), the old count stays as the
 * fallback: each paid day at her average working day.
 *
 * @param {object} a
 * @param {number} a.workedHours           hours actually worked this month
 * @param {number} a.hourValue             ₪ of one hour (rate, or תקן salary ÷ committed hours)
 * @param {number} a.leavePay              ₪ of the paid days off (vacation + holiday + sick + מילואים)
 * @param {number} a.leaveDays             the same days, counted
 * @param {number} a.fallbackHoursPerDay   her average working day, for the no-rate case
 */
function paidHours({ workedHours, hourValue, leavePay, leaveDays, fallbackHoursPerDay }) {
  const hv = num(hourValue);
  const extra = hv > 0
    ? num(leavePay) / hv
    : num(leaveDays) * (num(fallbackHoursPerDay) || 8);
  return r2(num(workedHours) + extra);
}

module.exports = {
  FULL_TIME_MONTHLY_HOURS,
  SICK_MONTH_DAYS,
  lookbackMonths,
  aggregate,
  dayRatesFrom,
  paidHours,
};
