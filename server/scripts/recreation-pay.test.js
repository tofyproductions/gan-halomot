#!/usr/bin/env node
/**
 * דמי הבראה — the seniority brackets from the צו, the office's prorated
 * first-year policy, and the part-time share. Each figure lands on a payslip,
 * so each is pinned.
 *
 *   node scripts/recreation-pay.test.js
 */

const {
  recreationDaysForYears, monthsWorkedByEndOf, computeRecreation,
} = require('../src/services/recreationPay');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('recreationDaysForYears — the צו\'s brackets');
{
  check('year 1 → 5', recreationDaysForYears(1) === 5);
  check('years 2–3 → 6', recreationDaysForYears(2) === 6 && recreationDaysForYears(3) === 6);
  check('years 4–10 → 7', recreationDaysForYears(4) === 7 && recreationDaysForYears(10) === 7);
  check('years 11–15 → 8', recreationDaysForYears(11) === 8 && recreationDaysForYears(15) === 8);
  check('years 16–19 → 9', recreationDaysForYears(16) === 9 && recreationDaysForYears(19) === 9);
  check('20+ → 10', recreationDaysForYears(20) === 10 && recreationDaysForYears(30) === 10);
  check('0 completed years → 0 statutory days', recreationDaysForYears(0) === 0);
}

console.log('monthsWorkedByEndOf — seniority measured at the end of August');
{
  check('started 1.9.2025 → 12 months by Aug 2026', monthsWorkedByEndOf('2025-09-01', '2026-08') === 12);
  check('started 1.3.2026 → 6 months', monthsWorkedByEndOf('2026-03-01', '2026-08') === 6);
  check('started 20.3.2026 (after the 15th) → 5 months', monthsWorkedByEndOf('2026-03-20', '2026-08') === 5);
  check('started years ago → 36', monthsWorkedByEndOf('2023-09-01', '2026-08') === 36);
  check('no start date → null', monthsWorkedByEndOf(null, '2026-08') === null);
  check('future start → 0', monthsWorkedByEndOf('2027-01-01', '2026-08') === 0);
}

console.log('computeRecreation — the August figure');
{
  // Completed exactly one year, full time: 5 days × rate.
  let r = computeRecreation({ startDate: '2025-09-01', month: '2026-08', weeklyHours: 42, dayRate: 418 });
  check('one completed year, full time: 5 × ₪418 = ₪2,090', r.amount === 2090 && r.days === 5 && r.basis === 'annual');

  // Three completed years → 6 days.
  r = computeRecreation({ startDate: '2023-08-01', month: '2026-08', weeklyHours: null, dayRate: 418 });
  check('three completed years: 6 days', r.days === 6 && r.full_years === 3);

  // Five completed years → 7 days.
  r = computeRecreation({ startDate: '2021-08-01', month: '2026-08', dayRate: 418 });
  check('five completed years: 7 days', r.days === 7);

  // Half a year: NOTHING per the צו — listed with zero so the empty cell
  // reads as "not yet eligible", never as "forgotten".
  r = computeRecreation({ startDate: '2026-03-01', month: '2026-08', weeklyHours: 42, dayRate: 418 });
  check('6 months: not yet eligible, amount 0 (strictly by the law)',
    r.amount === 0 && r.days === 0 && r.basis === 'not_yet_eligible' && r.months_worked === 6);

  // Part time: 21h/week = 50% of the 42h full-time week.
  r = computeRecreation({ startDate: '2020-09-01', month: '2026-08', weeklyHours: 21, dayRate: 418 });
  check('half-time: 7 days × 50% = ₪1,463', r.fte === 0.5 && r.amount === Math.round(7 * 418 * 0.5));

  // Over-full-time commitment never pays more than 100%.
  r = computeRecreation({ startDate: '2020-09-01', month: '2026-08', weeklyHours: 45, dayRate: 418 });
  check('45h/week caps at 100% משרה', r.fte === 1);

  check('no start date → nothing to pay', computeRecreation({ startDate: null, month: '2026-08' }) === null);
  check('started this month → nothing yet', computeRecreation({ startDate: '2026-08-20', month: '2026-08' }) === null);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll recreation-pay checks passed.');
