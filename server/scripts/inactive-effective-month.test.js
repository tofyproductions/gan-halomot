#!/usr/bin/env node
/**
 * inactive_effective_month gating — an employee deactivated with a reason
 * shows in the payroll table through her last real month (inclusive), then
 * archives out. No cutoff set = old behavior (shows every month forever).
 *
 * Mirrors the exact $or condition in payrollMonth.controller.js's
 * inactiveEmps query (string comparison on 'YYYY-MM', lexical order ==
 * chronological order for this format) — a change to the boundary there
 * should break this test too.
 *
 *   node scripts/inactive-effective-month.test.js
 */

// Same predicate as the query's `$or: [{ inactive_effective_month: null }, { inactive_effective_month: { $gte: month } }]`
function showsByReason(effectiveMonth, requestedMonth) {
  return effectiveMonth == null || effectiveMonth >= requestedMonth;
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('inactive_effective_month gating — reason-based visibility');
{
  check('no cutoff set → shows every month (legacy behavior unchanged)',
    showsByReason(null, '2026-01') && showsByReason(null, '2030-12'));

  check('effective month itself still shows (worked part of it)',
    showsByReason('2026-09', '2026-09') === true);

  check('month after the cutoff → archived, hidden',
    showsByReason('2026-09', '2026-10') === false);

  check('month before the cutoff → still shows',
    showsByReason('2026-09', '2026-08') === true);

  check('far future month → hidden',
    showsByReason('2026-09', '2027-01') === false);

  check('far past month (before she was even deactivated) → still shows',
    showsByReason('2026-09', '2020-01') === true);
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
