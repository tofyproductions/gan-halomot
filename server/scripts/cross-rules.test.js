#!/usr/bin/env node
/**
 * Cross-branch rules without a database.
 *
 *   node scripts/cross-rules.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};
const assert = require('assert');
let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); } catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}
const R = require('../src/services/shifts/crossRules');

console.log('\nhasBranchRate');
check('hourly or global rate for that branch counts; null/0 and other branches do not', () => {
  const emp = { branch_rates: [{ branch_id: 'H', hourly_rate: 45 }, { branch_id: 'X', hourly_rate: null, global_salary: 0 }] };
  assert.strictEqual(R.hasBranchRate(emp, 'H'), true);
  assert.strictEqual(R.hasBranchRate(emp, 'X'), false);
  assert.strictEqual(R.hasBranchRate(emp, 'Z'), false);
  assert.strictEqual(R.hasBranchRate({ branch_rates: [{ branch_id: 'G', global_salary: 9000 }] }, 'G'), true);
  assert.strictEqual(R.hasBranchRate({}, 'H'), false);
});

console.log('\ncrossOverlaps');
const E = (employee_id, date, s, t, extra = {}) => ({ employee_id, employee_name: 'דנה', date, start_hhmm: s, end_hhmm: t, ...extra });
check('overlap with another branch is reported, touching is fine, other employees ignored', () => {
  const mine = [E('a', '2026-10-12', '13:00', '17:00'), E('b', '2026-10-12', '07:00', '15:00')];
  const other = [E('a', '2026-10-12', '07:00', '13:00', { branch_id: 'O1' }), E('b', '2026-10-13', '07:00', '15:00', { branch_id: 'O1' })];
  assert.deepStrictEqual(R.crossOverlaps(mine, other), []);
  const clash = [E('a', '2026-10-12', '07:00', '13:30', { branch_id: 'O1' })];
  assert.deepStrictEqual(R.crossOverlaps(mine, clash), [{ employee_id: 'a', employee_name: 'דנה', date: '2026-10-12', other_branch_id: 'O1' }]);
});

console.log('\narrangements and keys');
check('placementKey', () => assert.strictEqual(R.placementKey(E('a', '2026-10-12', '13:00', '17:00')), 'a|2026-10-12|13:00|17:00'));
check('arrangementCovers matches weekday + hours', () => {
  const arr = { employee_id: 'a', weekday: 1, start_hhmm: '13:00', end_hhmm: '17:00' };
  assert.strictEqual(R.arrangementCovers(arr, E('a', '2026-10-12', '13:00', '17:00')), true); // Monday
  assert.strictEqual(R.arrangementCovers(arr, E('a', '2026-10-13', '13:00', '17:00')), false);
  assert.strictEqual(R.arrangementCovers(arr, E('a', '2026-10-12', '13:00', '16:00')), false);
  assert.strictEqual(R.arrangementCovers(arr, E('b', '2026-10-12', '13:00', '17:00')), false);
});

console.log('\nrotaDay');
check('span of the day, branch of the earliest entry; none → null', () => {
  const es = [E('a', '2026-10-12', '13:00', '17:00', { branch_id: 'H' }), E('a', '2026-10-12', '07:00', '13:00', { branch_id: 'B' })];
  assert.deepStrictEqual(R.rotaDay(es, '2026-10-12'), { in: '07:00', out: '17:00', branch_id: 'B' });
  assert.strictEqual(R.rotaDay(es, '2026-10-13'), null);
  assert.strictEqual(R.rotaDay([E('a', '2026-10-12', '', '')], '2026-10-12'), null);
});

console.log('\nlateness');
check('absent, late over 30, on time, exactly 30', () => {
  assert.deepStrictEqual(R.lateness(null, '07:00'), { kind: 'absent' });
  assert.deepStrictEqual(R.lateness('07:31', '07:00'), { kind: 'late', minutes: 31 });
  assert.strictEqual(R.lateness('07:30', '07:00'), null);
  assert.strictEqual(R.lateness('06:50', '07:00'), null);
  assert.strictEqual(R.lateness('08:00', ''), null);
});

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
