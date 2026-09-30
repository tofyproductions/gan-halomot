'use strict';

/**
 * Moving a תקן employee's paid-but-not-worked days out of her השלמת שכר.
 *
 * A תקן employee is paid her agreed salary whatever the month holds. What she
 * did not work is topped up by השלמת שכר (code 47) — and code 47 carries no
 * social benefits. So every day she was PAID for without working it belongs on
 * the line that does carry them: a statutory holiday on דמי חגים (code 44), a
 * day of leave on תמורת חופשה (code 8). Owner's rulings, 30.09.2026.
 *
 * The money CHANGES LINE; none is added. Each claim takes from what is left of
 * the completion, in the order given, and never more than is there — a claim
 * larger than the completion would pay her above the agreed salary, which is a
 * new payment and not a relabel. What did not fit is returned as `unfunded`, so
 * the accountant can be told rather than the shortfall disappearing.
 *
 * ORDER IS THE CALLER'S DECISION, and the owner's is holidays before leave
 * (30.09.2026): דמי חגים are a statutory obligation on a fixed number of days,
 * so they take their full value first and leave takes what remains.
 *
 * @param {number} completion   the completion before any carve
 * @param {Array<{key:string, days:number, want:number}>} claims  in carve order
 * @returns {{ allocations: Object<string,{days,want,got,unfunded}>, carved:number, remaining:number }}
 */
function carveFromCompletion(completion, claims) {
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  let left = Math.max(0, r2(completion));
  const allocations = {};
  let carved = 0;
  for (const c of claims || []) {
    const want = Math.max(0, r2(c.want));
    const got = r2(Math.min(want, left));
    left = r2(left - got);
    carved = r2(carved + got);
    allocations[c.key] = { days: Number(c.days) || 0, want, got, unfunded: r2(want - got) };
  }
  return { allocations, carved, remaining: left };
}

/**
 * The statutory holidays this month that she was PAID for without working:
 * on one of her committed days (a holiday on her day off, or on a Saturday, is
 * not a working day she missed) and not a day she actually clocked in.
 *
 * No seniority condition for a תקן employee (owner, 30.09.2026): her salary
 * does not move on a holiday to begin with, so every statutory holiday that
 * falls on her working day is דמי חגים — in her first month as in her tenth.
 *
 * @param {Array<{date,name}>} monthHolidays  israeliHolidays.getHolidaysInMonth
 * @param {string[]} committedDates           commitmentInfo.committed_dates
 * @param {string[]} workedDates              commitmentInfo.worked_dates
 */
function tekenHolidayDays(monthHolidays, committedDates, workedDates) {
  const committed = new Set(committedDates || []);
  const worked = new Set(workedDates || []);
  return (monthHolidays || []).filter((h) => committed.has(h.date) && !worked.has(h.date));
}

/**
 * What ONE of her days is worth — by that day's own hours (owner, 30.09.2026).
 *
 * A תקן employee's days are not all the same length: אפרת משעלי works 10 hours
 * Sunday to Wednesday and 4.5 on Friday. Priced at the average (salary ÷
 * committed days, ₪409), her short Fridays were worth as much as her long days,
 * and her nine shut days in September came to ₪3,682 — more than her whole
 * completion of ₪3,410, which is BUILT from the hours she did not work. Priced
 * by the day, they come to ₪3,587: the completion, less the four hours she
 * worked beyond her commitment on open days (which a תקן contract absorbs).
 *
 *   day value = that day's weighted hours × the regular hourly value
 *             = weightedDayHours(committed hours of that date) × (salary ÷ weighted commitment)
 *
 * The WEIGHTED hours, because that is what the day removes from her worked
 * value: a 10-hour day is 8 regular + 2 at 125% = 10.5, and hourly_value is
 * salary ÷ the weighted commitment. So a long day is 10.5 × 43.48 = ₪456.52 and
 * a Friday 4.5 × 43.48 = ₪195.65, and a month of them sums to exactly the salary.
 *
 * תקן ONLY. An hourly employee's day stays the 12-month average of
 * services/hourlyDayRates.js — the owner was explicit that this is not hers.
 *
 * `fallback` (the average day) covers a date with no committed hours on file.
 */
function tekenDayValue(date, { hoursByDate, hourlyValue, fallback = 0 } = {}) {
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const { weightedDayHours } = require('./commitmentAnalysis');
  const h = Number(hoursByDate && hoursByDate[date]);
  if (!(h > 0) || !(Number(hourlyValue) > 0)) return r2(fallback);
  return r2(weightedDayHours(h) * Number(hourlyValue));
}

/**
 * Several days, each at its own value. `entries` are dates, or {date, value}
 * where value is the fraction of the day (a half-day closure is 0.5).
 */
function tekenDaysValue(entries, ctx) {
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  let total = 0;
  for (const e of entries || []) {
    const date = typeof e === 'string' ? e : e.date;
    const part = typeof e === 'string' ? 1 : (e.value == null ? 1 : Number(e.value));
    total += tekenDayValue(date, ctx) * part;
  }
  return r2(total);
}

/**
 * The regular hourly value, unrounded — what tekenDayValue multiplies by.
 * Salary ÷ weighted commitment; 0 when either is missing.
 */
function tekenHourlyValue(salary, weightedCommitment) {
  const s = Number(salary) || 0;
  const w = Number(weightedCommitment) || 0;
  return s > 0 && w > 0 ? s / w : 0;
}

module.exports = {
  carveFromCompletion, tekenHolidayDays, tekenDayValue, tekenDaysValue, tekenHourlyValue,
};
