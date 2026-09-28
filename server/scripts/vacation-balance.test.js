#!/usr/bin/env node
/**
 * The חופשה balance.
 *
 * The arithmetic is small; what it has to get right is not:
 *   1. no opening month → null, meaning "unknown", NEVER 0 meaning "no days";
 *   2. accrual runs from the opening month forward, at the EMPLOYEE'S own rate;
 *   3. a missing rate accrues nothing rather than a guessed default;
 *   4. days taken before the opening month are already inside it and must not
 *      be charged twice;
 *   5. an overdraw is reported, not silently clamped to zero — a balance that
 *      cannot go negative cannot tell you it was exceeded.
 *
 *   node scripts/vacation-balance.test.js
 */
const assert = require('assert');
const V = require('../src/services/vacationBalance');

let passed = 0;
const ok = (label) => { console.log('  ✓ ' + label); passed += 1; };

console.log('months elapsed');
{
  assert.strictEqual(V.monthsElapsed('2026-08', '2026-08'), 0);
  assert.strictEqual(V.monthsElapsed('2026-08', '2026-09'), 1);
  assert.strictEqual(V.monthsElapsed('2026-08', '2027-02'), 6);
  assert.strictEqual(V.monthsElapsed('2026-09', '2026-08'), 0, 'never negative');
  assert.strictEqual(V.monthsElapsed(null, '2026-09'), 0);
  ok('counts whole months forward, and never backwards');
}

console.log('unknown is not zero');
{
  assert.strictEqual(V.accruedVacation({ days: 5 }, 1.167, '2026-09'), null,
    'no as_of_month → null');
  assert.strictEqual(V.vacationBalance({ days: 5 }, 1.167, '2026-09', 0), null);
  // 0 would render as "you have no vacation days", which is a claim. null lets
  // every screen show nothing instead of something false.
  ok('an opening with no month yields null, not a confident zero');
}

console.log("accrual runs at the employee's own rate");
{
  // רינת's row in the accountant's report: 1.167 a month.
  const opening = { days: 6.002, as_of_month: '2026-08' };
  assert.strictEqual(V.accruedVacation(opening, 1.167, '2026-08'), 6.002,
    'at the opening month itself nothing has accrued yet');
  assert.strictEqual(V.accruedVacation(opening, 1.167, '2026-09'), 7.169);
  assert.strictEqual(V.accruedVacation(opening, 1.167, '2026-11'), 9.503);
  ok('one month on is the opening plus one rate; three months is plus three');

  // The gan's staff genuinely differ — 0.18 to 1.167 a month.
  assert.strictEqual(V.accruedVacation({ days: 0, as_of_month: '2026-08' }, 0.18, '2026-10'), 0.36);
  ok('a part-timer accrues at her own rate, not at anybody else\'s');
}

console.log('a missing rate accrues nothing');
{
  const opening = { days: 4, as_of_month: '2026-08' };
  assert.strictEqual(V.accruedVacation(opening, 0, '2027-08'), 4,
    'a year on, with no rate on file, the balance has not moved');
  assert.strictEqual(V.accruedVacation(opening, undefined, '2027-08'), 4);
  assert.strictEqual(V.accruedVacation(opening, -3, '2027-08'), 4, 'a negative rate cannot drain it');
  // Too low prompts a question; too high is leave the gan never owed and
  // cannot claw back once somebody has booked a holiday around it.
  ok('no rate means no accrual — never an invented default');
}

console.log('leave taken before the opening is already inside it');
{
  const opening = { days: 6.002, as_of_month: '2026-08' };
  const b = V.vacationBalance(opening, 1.167, '2026-10', 0);
  assert.strictEqual(b.accrued, 8.336);
  assert.strictEqual(b.available, 8.336);
  // Only days AFTER 2026-08 are passed in as used; the caller filters by month.
  const used = V.vacationBalance(opening, 1.167, '2026-10', 2);
  assert.strictEqual(used.used, 2);
  assert.strictEqual(used.available, 6.336);
  ok('only the days handed in as "since the opening" reduce the balance');
}

console.log('an overdraw is reported, not hidden');
{
  const opening = { days: 1, as_of_month: '2026-08' };
  const b = V.vacationBalance(opening, 0, '2026-09', 5);
  assert.strictEqual(b.available, -4, 'the balance goes negative and says so');
  assert.strictEqual(b.overdrawn, true);
  // Clamping at zero would make an overdraw indistinguishable from an empty
  // balance, and the office would approve the next day of leave blind.
  ok('more days taken than accrued shows a negative balance and an overdrawn flag');

  const fine = V.vacationBalance(opening, 0, '2026-09', 1);
  assert.strictEqual(fine.available, 0);
  assert.strictEqual(fine.overdrawn, false, 'exactly empty is not overdrawn');
  ok('a balance of exactly zero is not flagged as overdrawn');
}

console.log('an opening overdraft carries forward');
{
  // The accountant's own report showed negative openings (-2.334, -2.668).
  const opening = { days: -2.334, as_of_month: '2026-08' };
  const b = V.vacationBalance(opening, 1.167, '2026-10', 0);
  assert.strictEqual(b.accrued, 0, '-2.334 + 2 × 1.167 lands back at zero');
  assert.strictEqual(b.overdrawn, false);
  ok('a negative opening is carried, not clamped away, and accrues back up');
}

console.log('the shape a screen can render');
{
  const b = V.vacationBalance({ days: 6.002, as_of_month: '2026-08' }, 1.167, '2026-09', 1);
  assert.deepStrictEqual(Object.keys(b).sort(),
    ['accrued', 'as_of_month', 'available', 'monthly_accrual', 'overdrawn', 'used'].sort());
  assert.strictEqual(b.as_of_month, '2026-08', 'the month it was measured travels with it');
  assert.strictEqual(b.monthly_accrual, 1.167);
  ok('the result carries the month and rate it was derived from, not just a number');
}

console.log('what may be FILED is capped by the balance');
{
  // The case exactly as the office described it: seven days away, two in hand.
  const u = V.vacationUsageForMonth(7, 2);
  assert.strictEqual(u.paid, 2, 'the accountant is sent two');
  assert.strictEqual(u.unpaid, 5, 'the other five are not erased, they are unpaid');
  assert.strictEqual(u.capped, true);
  assert.strictEqual(u.available, 2, 'the balance that caused it travels with it');
  ok('seven days taken against a balance of two files two, and says five are unpaid');
}
{
  const fits = V.vacationUsageForMonth(2, 7);
  assert.strictEqual(fits.paid, 2);
  assert.strictEqual(fits.unpaid, 0);
  assert.strictEqual(fits.capped, false, 'within balance is not a cap');
  ok('days within the balance pass through untouched and unflagged');
}
{
  const exact = V.vacationUsageForMonth(2, 2);
  assert.strictEqual(exact.paid, 2);
  assert.strictEqual(exact.capped, false, 'spending the balance exactly is not a cap');
  ok('taking exactly the balance is not reported as capped');
}
{
  const none = V.vacationUsageForMonth(3, 0);
  assert.strictEqual(none.paid, 0, 'no balance files no paid days');
  assert.strictEqual(none.unpaid, 3);
  assert.strictEqual(none.capped, true);
  ok('an empty balance files zero days and reports all three as unpaid');
}
{
  // The distinction the whole thing turns on: "she has none" vs "we do not know".
  const unknown = V.vacationUsageForMonth(7, null);
  assert.strictEqual(unknown.paid, 7, 'an unknown balance must NOT reduce her pay');
  assert.strictEqual(unknown.unpaid, 0);
  assert.strictEqual(unknown.capped, false);
  assert.strictEqual(unknown.available, null);
  ok('with no balance on file nothing is capped — unknown is not zero');
}
{
  const neg = V.vacationUsageForMonth(4, -3);
  assert.strictEqual(neg.paid, 0, 'an overdrawn balance cannot fund more leave');
  assert.strictEqual(neg.unpaid, 4);
  ok('an already-overdrawn balance files nothing further');

  const zero = V.vacationUsageForMonth(0, 5);
  assert.strictEqual(zero.paid, 0);
  assert.strictEqual(zero.capped, false, 'no days taken is not a cap');
  ok('a month with no vacation is not flagged');
}

console.log('a global employee and an hourly one are not treated the same');
{
  // סוכות: five days away, three in the balance.
  const hourly = V.vacationUsageForMonth(5, 3, { isGlobal: false });
  assert.strictEqual(hourly.paid, 3, 'an hourly employee is paid the days she has');
  assert.strictEqual(hourly.unpaid, 2);
  assert.strictEqual(hourly.overdraft, 0, 'she owes nothing — she simply was not paid');
  assert.strictEqual(hourly.capped, true);
  ok('an hourly employee is capped at her balance and owes nothing');

  const global = V.vacationUsageForMonth(5, 3, { isGlobal: true });
  assert.strictEqual(global.paid, 5, 'a תקן salary does not move with the days — all five are paid');
  assert.strictEqual(global.unpaid, 0);
  assert.strictEqual(global.overdraft, 2, 'the two uncovered days are an advance');
  assert.strictEqual(global.capped, false, 'nothing was withheld, so nothing was capped');
  assert.strictEqual(global.balance_before ?? global.available, 3,
    'the balance she had that month travels with the debt');
  ok('a global employee is paid in full and the uncovered days become a debt');
}
{
  const none = V.vacationUsageForMonth(5, 0, { isGlobal: true });
  assert.strictEqual(none.paid, 5);
  assert.strictEqual(none.overdraft, 5, 'no balance at all means the whole absence is advanced');
  ok('a global employee with no balance is still paid, and owes every day');

  const already = V.vacationUsageForMonth(2, -4, { isGlobal: true });
  assert.strictEqual(already.paid, 2);
  assert.strictEqual(already.overdraft, 2,
    'an already-negative balance funds nothing, so both days are advanced');
  ok('an employee already in arrears adds the whole of this month to the debt');
}
{
  const fits = V.vacationUsageForMonth(2, 7, { isGlobal: true });
  assert.strictEqual(fits.overdraft, 0, 'inside the balance there is no debt');
  assert.strictEqual(fits.paid, 2);
  ok('a global employee within her balance owes nothing');

  // The distinction that must never collapse: unknown is not zero. A balance
  // nobody has imported must not manufacture a debt against an employee.
  const unknown = V.vacationUsageForMonth(5, null, { isGlobal: true });
  assert.strictEqual(unknown.paid, 5);
  assert.strictEqual(unknown.overdraft, 0, 'an unknown balance creates no debt');
  assert.strictEqual(unknown.available, null);
  ok('with no balance on file a global employee is paid and owes nothing');

  const unknownHourly = V.vacationUsageForMonth(5, null, { isGlobal: false });
  assert.strictEqual(unknownHourly.paid, 5, 'and an unknown balance still reduces nobody');
  ok('an unknown balance never reduces an hourly employee either');
}

console.log("what the employee's own screen has to be able to say");
{
  // The numbers the screen prints must reconcile: opening + accrued − used
  // = what is left. If they do not, somebody plans a holiday on a wrong figure.
  const opening = { days: 6.002, as_of_month: '2026-08' };
  const b = V.vacationBalance(opening, 1.167, '2026-11', 4);
  const accruedSince = Math.round((b.accrued - opening.days) * 1000) / 1000;
  assert.strictEqual(accruedSince, 3.501, 'three months at 1.167');
  assert.strictEqual(Math.round((opening.days + accruedSince - b.used) * 1000) / 1000, b.available,
    'opening + accrued − used must equal the number shown as remaining');
  ok('the working shown on screen adds up to the figure shown on screen');
}
{
  // "No balance imported" must never render as a confident zero: an employee
  // told she has no days when nobody has entered her balance is being given
  // false information about her own entitlement.
  assert.strictEqual(V.vacationBalance({ days: 5 }, 1, '2026-11', 0), null);
  ok('an employee with no imported balance gets null, never a zero to act on');
}

console.log('pay follows the days that may be FILED');
{
  // אילנה שימחי took 2 days against a balance of 0.28. The file reports 0.28;
  // paying for 2 made the daily rate come out ₪1,057 — pay ÷ days, where the
  // two numbers had stopped describing the same thing.
  const u = V.vacationUsageForMonth(2, 0.28, { isGlobal: false });
  assert.strictEqual(u.paid, 0.28, 'only what the balance covers may be paid');
  const dayValue = 148.02;
  assert.strictEqual(Math.round(u.paid * dayValue * 100) / 100, 41.45,
    'and the pay follows those days, not the days she was away');
  ok('an hourly employee is paid for the filed days, so rate × days holds');
}

console.log(`\nAll vacation-balance tests passed (${passed} checks).`);
