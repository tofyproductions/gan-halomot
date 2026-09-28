#!/usr/bin/env node
/**
 * What a day of חופשה or מחלה is worth to an hourly employee.
 *
 * The reference case is בגים שילו's own ריכוז משכורות שנתי, so these numbers
 * are checked against the accountant's rather than against themselves:
 *
 *   שכר יסוד 30,375 + תמורת חופשה 2,659 + מחלה 173 + מילואים 21,186 + חג 295
 *     = 54,688
 *   ימים לתלוש 178 · שעות משולמות 1,474 · חודשים עם תשלום 8
 *
 *   node scripts/hourly-day-rates.test.js
 */
const assert = require('assert');
const H = require('../src/services/hourlyDayRates');

let passed = 0;
const ok = (label) => { console.log('  ✓ ' + label); passed += 1; };

const m = (month, base, vac, sick, mil, hol, days, hours) => ({
  month, base_salary: base, vacation_pay: vac, sick_pay: sick,
  miluim_pay: mil, holiday_pay: hol, days_for_payslip: days, paid_hours: hours,
});

// בגים שילו, month by month.
const SHILO = [
  m('2025-01', 5202, 0, 173, 0, 0, 18, 147),
  m('2025-02', 6738, 0, 0, 0, 0, 23, 190),
  m('2025-03', 0, 0, 0, 9951, 0, 31, 248),
  m('2025-04', 3855, 2364, 0, 0, 295, 22, 176),
  m('2025-05', 5456, 295, 0, 11235, 0, 54, 445),
  m('2025-06', 5600, 0, 0, 0, 0, 18, 169),
  m('2025-07', 2416, 0, 0, 0, 0, 8, 72),
  m('2025-08', 1108, 0, 0, 0, 0, 4, 28),
];

console.log('the window is the twelve months BEFORE the month being paid');
{
  const w = H.lookbackMonths('2026-09');
  assert.strictEqual(w.length, 12);
  assert.strictEqual(w[w.length - 1], '2026-08', 'ends the month before');
  assert.strictEqual(w[0], '2025-09', 'and starts twelve back');
  assert.ok(!w.includes('2026-09'),
    'the month being paid is excluded — it is not closed, and the rate must not move as it is edited');
  ok('September 2026 is paid from September 2025 through August 2026');

  assert.deepStrictEqual(H.lookbackMonths('2026-01').slice(-1), ['2025-12'], 'crosses the year');
  assert.deepStrictEqual(H.lookbackMonths('bad'), []);
  ok('the window crosses a year boundary, and a bad month yields nothing');
}

console.log("the three inputs match the accountant's own annual summary");
{
  const a = H.aggregate(SHILO);
  assert.strictEqual(a.pay, 54688, 'the five components, and only those five');
  assert.strictEqual(a.days, 178, 'ימים לתלוש');
  assert.strictEqual(a.months, 8, 'months with any payment');
  ok('54,688 over 178 days across 8 months — the accountant\'s figures exactly');
}

console.log('a month of מילואים is a month of employment');
{
  // 2025-03: no worked hours at all, ₪9,951 of מילואים. Dropping it would
  // divide her average by the months she was away and quietly cut the rate.
  const without = H.aggregate(SHILO.filter((r) => r.month !== '2025-03'));
  assert.strictEqual(H.aggregate(SHILO).months, without.months + 1,
    'the מילואים month counts');
  ok('a month paid but not worked still counts toward the average');
}

console.log('the two rates are different questions with different divisors');
{
  const r = H.dayRatesFrom(SHILO);
  assert.strictEqual(r.full_day, 307.24, '54,688 ÷ 178');
  assert.strictEqual(r.sick_day, 227.87, '54,688 ÷ 8 months ÷ 30');
  assert.notStrictEqual(r.full_day, r.sick_day,
    'a day paid for and a day of the calendar are not the same day');
  ok('a full day is 307.24; a sick day is 227.87');
}

console.log('the coefficient is capped at a full post');
{
  const r = H.dayRatesFrom(SHILO);
  assert.strictEqual(r.raw_coefficient, 1.013, '1,475 ÷ 8 ÷ 182');
  assert.strictEqual(r.coefficient, 1, 'more than a full post is still one day');
  assert.strictEqual(r.vacation_day, r.full_day, 'so she is paid the whole day');
  ok('averaging over 182 hours pays one full day, never more');

  // Half a post: the same money, half the hours.
  const half = SHILO.map((x) => ({ ...x, paid_hours: x.paid_hours / 2 }));
  const h = H.dayRatesFrom(half);
  assert.ok(h.coefficient > 0.5 && h.coefficient < 0.51, `coefficient ${h.coefficient}`);
  assert.strictEqual(h.full_day, 307.24, 'the full-time day is unchanged');
  assert.ok(h.vacation_day < h.full_day, 'and she is paid a proportion of it');
  ok('a part-timer is paid a proportion of the same full-time day');
}

console.log('too little history is normal, not an error');
{
  // The system has not been running a year, and neither has every employee.
  const first = H.dayRatesFrom([m('2026-08', 4000, 0, 0, 0, 0, 20, 160)]);
  assert.ok(first, 'one month is enough to answer with');
  assert.strictEqual(first.full_day, 200, '4,000 ÷ 20');
  assert.strictEqual(first.months, 1);
  assert.strictEqual(first.source_months, 1);
  ok('a single month of history produces a rate rather than a refusal');

  assert.strictEqual(H.dayRatesFrom([]), null, 'no history at all yields null');
  assert.strictEqual(H.dayRatesFrom(null), null);
  // null means "cannot say", which a caller must handle by leaving the existing
  // behaviour alone — never by paying zero.
  ok('with nothing to compute from the answer is null, never a zero rate');
}

console.log('only the five components count');
{
  // נסיעות, הבראה, שעות נוספות and הפרשים are NOT part of a daily value.
  // בגים שילו's file carries ₪1,595 + ₪2,709 + ₪5,647 + ₪3,234 of them, and
  // including any would inflate every day of leave she is ever paid.
  const polluted = SHILO.map((x, i) => (i === 0
    ? { ...x, travel: 1595, recreation: 2709, overtime: 5647, differences: 3234 } : x));
  assert.strictEqual(H.aggregate(polluted).pay, 54688,
    'unknown fields are ignored, not summed');
  ok('travel, הבראה, overtime and הפרשים never reach the daily value');
}

console.log('a month with no days does not divide by zero');
{
  const noDays = H.dayRatesFrom([m('2026-08', 500, 0, 0, 0, 0, 0, 0)]);
  assert.ok(Number.isFinite(noDays.full_day), 'the full day stays a number');
  assert.strictEqual(noDays.full_day, 0);
  assert.ok(Number.isFinite(noDays.sick_day));
  ok('a month paid with no days on it yields 0, not Infinity');
}

console.log("מהרט's own payslip, worked by hand on paper");
{
  // אדולה מהרט started 02.08.2026, so September's window holds one month:
  // שכר יסוד 3,218 · ימים לתלוש 11 · שעות משולמות 74. The office worked it
  // out by hand and got ₪119; the file was sending ₪439.
  const r = H.dayRatesFrom([m('2026-08', 3218, 0, 0, 0, 0, 11, 74)]);
  assert.strictEqual(r.full_day, 292.55, '3,218 ÷ 11 — the figure on the paper');
  assert.strictEqual(r.raw_coefficient, 0.4066, '74 ÷ 182 — also on the paper');
  assert.strictEqual(r.vacation_day, 118.95, 'and ₪119 a day, to the agora');
  ok('one month of history reproduces the hand calculation exactly');
}
{
  // Why it was ₪125 before the base was narrowed: our base_salary sums the
  // 125%/150% premiums in with the regular hours, and the accountant's
  // שכר יסוד does not. Overtime is premium pay for hours beyond the working
  // day — averaging it into a day of LEAVE pays that premium again, on days
  // she did not work at all.
  const withOt = H.dayRatesFrom([m('2026-08', 3378.04, 0, 0, 0, 0, 11, 74.37)]);
  assert.ok(withOt.vacation_day > 125, `overtime inflates it to ${withOt.vacation_day}`);
  const withoutOt = H.dayRatesFrom([m('2026-08', 3220.04, 0, 0, 0, 0, 11, 74.37)]);
  assert.ok(Math.abs(withoutOt.vacation_day - 119) < 1,
    `regular hours alone lands on ₪${withoutOt.vacation_day}, beside the accountant's 119`);
  ok('overtime in the numerator is worth ₪6 a day, and does not belong there');
}

console.log(`\nAll hourly day-rate tests passed (${passed} checks).`);
