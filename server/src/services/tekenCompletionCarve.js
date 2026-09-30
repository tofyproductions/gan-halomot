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

module.exports = { carveFromCompletion, tekenHolidayDays };
