#!/usr/bin/env node
/**
 * Constraint rules without a database: the Thursday-18:00 window, far future,
 * when the rota already respects a constraint, and which entries an accepted
 * constraint blocks.
 *
 *   node scripts/constraint-rules.test.js
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
const R = require('../src/services/shifts/constraintRules');

// Week of Sunday 2026-10-04. Next week starts 2026-10-11.
const wed = new Date('2026-10-07T09:00:00Z');        // Wed 12:00 IL
const thu1759 = new Date('2026-10-08T14:59:00Z');    // Thu 17:59 IL
const thu1800 = new Date('2026-10-08T15:00:00Z');    // Thu 18:00 IL
const fri = new Date('2026-10-09T08:00:00Z');

console.log('\nwindow');
check('ilNow is Israel time', () => assert.deepStrictEqual(R.ilNow(thu1800), { day: '2026-10-08', hour: 18 }));
check('next week open on Wednesday', () => assert.deepStrictEqual(R.submissionWindow(['2026-10-13'], wed), { ok: true }));
check('next week open at Thu 17:59', () => assert.strictEqual(R.submissionWindow(['2026-10-13'], thu1759).ok, true));
check('next week closed at Thu 18:00', () => assert.strictEqual(R.submissionWindow(['2026-10-13'], thu1800).ok, false));
check('next week closes with Hebrew error', () => assert(/^ההגשה/.test(R.submissionWindow(['2026-10-13'], thu1800).error), true));
check('two weeks out: open on Thu 18:00', () => assert.deepStrictEqual(R.submissionWindow(['2026-10-20'], thu1800), { ok: true }));
check('addDays', () => {
  assert.strictEqual(R.addDays('2026-10-04', 0), '2026-10-04');
  assert.strictEqual(R.addDays('2026-10-04', 1), '2026-10-05');
  assert.strictEqual(R.addDays('2026-10-31', 1), '2026-11-01');
});

console.log('\nfar future');
check('next week not far', () => assert.strictEqual(R.isFarFuture('2026-10-13', wed), false));
check('two weeks out not far', () => assert.strictEqual(R.isFarFuture('2026-10-20', wed), false));
check('three weeks out: far', () => assert.strictEqual(R.isFarFuture('2026-10-27', wed), true));

console.log('\nrespected');
const D = '2026-10-07';
const T = '2026-10-14';
const E = (id, date, start, end) => ({ employee_id: id, date, start_hhmm: start, end_hhmm: end });
check('day_off with no entry', () => assert.strictEqual(R.respected({ type: 'day_off', employee_id: 'a', date: D }, []), true));
check('day_off with entry blocks', () => assert.strictEqual(R.respected({ type: 'day_off', employee_id: 'a', date: D }, [E('a', D, '07:00', '15:00')]), false));
check('day_off for other employee does not block', () => assert.strictEqual(R.respected({ type: 'day_off', employee_id: 'a', date: D }, [E('b', D, '07:00', '15:00')]), true));
check('sick_expected same as day_off', () => assert.strictEqual(R.respected({ type: 'sick_expected', employee_id: 'a', date: D }, []), true));
check('partial: overlap false, outside true, touching true', () => {
  const c = { type: 'partial', employee_id: 'a', date: D, from_hhmm: '10:00', to_hhmm: '12:00' };
  assert.strictEqual(R.respected(c, [E('a', D, '07:00', '11:00')]), false);
  assert.strictEqual(R.respected(c, [E('a', D, '07:00', '10:00'), E('a', D, '12:00', '16:00')]), true);
});
check('move_day: off on date and working on target', () => {
  const c = { type: 'move_day', employee_id: 'a', date: D, target_date: T };
  assert.strictEqual(R.respected(c, [E('a', D, '07:00', '15:00'), E('a', T, '08:00', '16:00')]), false);
  assert.strictEqual(R.respected(c, [E('a', T, '08:00', '16:00')]), true);
  assert.strictEqual(R.respected(c, [E('a', D, '07:00', '15:00')]), false);
});
check('swap: requester off, colleague working', () => {
  const c = { type: 'swap', employee_id: 'a', date: D, colleague_id: 'b', target_date: T };
  assert.strictEqual(R.respected(c, [E('b', D, '07:00', '15:00'), E('a', T, '08:00', '16:00')]), true);
  assert.strictEqual(R.respected(c, [E('a', D, '07:00', '15:00'), E('b', T, '08:00', '16:00')]), false);
  assert.strictEqual(R.respected(c, [E('a', D, '07:00', '15:00')]), false);
});
check('other: no logic', () => assert.strictEqual(R.respected({ type: 'other', employee_id: 'a', date: D }, [E('a', D, '07:00', '15:00')]), null));

console.log('\nblocks');
check('day_off blocks entry on same date', () => assert.strictEqual(R.blocksEntry({ type: 'day_off', employee_id: 'a', date: D }, E('a', D, '07:00', '15:00')), true));
check('day_off does not block other dates or employees', () => {
  assert.strictEqual(R.blocksEntry({ type: 'day_off', employee_id: 'a', date: D }, E('a', T, '07:00', '15:00')), false);
  assert.strictEqual(R.blocksEntry({ type: 'day_off', employee_id: 'a', date: D }, E('b', D, '07:00', '15:00')), false);
});
check('partial blocks only overlapping hours', () => {
  const c = { type: 'partial', employee_id: 'a', date: D, from_hhmm: '10:00', to_hhmm: '12:00' };
  assert.strictEqual(R.blocksEntry(c, E('a', D, '11:00', '15:00')), true);
  assert.strictEqual(R.blocksEntry(c, E('a', D, '12:00', '15:00')), false);
});
check('swap blocks the requester on date', () => assert.strictEqual(R.blocksEntry({ type: 'swap', employee_id: 'a', date: D }, E('a', D, '07:00', '15:00')), true));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
