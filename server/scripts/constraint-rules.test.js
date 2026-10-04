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
check('ilNow in winter (UTC+2)', () => assert.deepStrictEqual(R.ilNow(new Date('2026-12-10T16:00:00Z')), { day: '2026-12-10', hour: 18 }));
check('next week open on Wednesday', () => assert.deepStrictEqual(R.submissionWindow(['2026-10-13'], wed), { ok: true }));
check('next week open at Thu 17:59', () => assert.strictEqual(R.submissionWindow(['2026-10-13'], thu1759).ok, true));
check('next week closed from Thu 18:00', () => {
  const r = R.submissionWindow(['2026-10-13'], thu1800);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'ההגשה לשבוע הבא נסגרה ביום חמישי ב-18:00');
});
check('current week always closed', () => assert.strictEqual(R.submissionWindow(['2026-10-08'], wed).error, 'אי אפשר להגיש אילוץ לשבוע הנוכחי או לתאריך שעבר'));
check('week after next open even on Friday', () => assert.strictEqual(R.submissionWindow(['2026-10-20'], fri).ok, true));
check('earliest date decides', () => assert.strictEqual(R.submissionWindow(['2026-10-20', '2026-10-13'], fri).ok, false));
check('bad date refused', () => assert.strictEqual(R.submissionWindow(['13/10'], wed).error, 'תאריך לא תקין'));
check('isFarFuture', () => { assert.strictEqual(R.isFarFuture('2026-10-13', wed), false); assert.strictEqual(R.isFarFuture('2026-10-18', wed), true); });

console.log('\nrespected');
const E = (employee_id, date, s, t) => ({ employee_id, date, start_hhmm: s, end_hhmm: t });
const D = '2026-10-13'; const T = '2026-10-15';
check('day_off: not placed → true; placed → false', () => {
  assert.strictEqual(R.respected({ type: 'day_off', employee_id: 'a', date: D }, [E('b', D, '07:00', '15:00')]), true);
  assert.strictEqual(R.respected({ type: 'day_off', employee_id: 'a', date: D }, [E('a', D, '07:00', '15:00')]), false);
});
check('sick_expected same as day_off', () => assert.strictEqual(R.respected({ type: 'sick_expected', employee_id: 'a', date: D }, []), true));
check('partial: overlap false, outside true, touching true', () => {
  const c = { type: 'partial', employee_id: 'a', date: D, from_hhmm: '10:00', to_hhmm: '12:00' };
  assert.strictEqual(R.respected(c, [E('a', D, '07:00', '11:00')]), false);
  assert.strictEqual(R.respected(c, [E('a', D, '07:00', '10:00'), E('a', D, '12:00', '16:00')]), true);
});
check('move_day: off on date and working on target', () => {
  const c = { type: 'move_day', employee_id: 'a', date: D, target_date: T };
  assert.strictEqual(R.respected(c, [E('a', T, '07:00', '15:00')]), true);
  assert.strictEqual(R.respected(c, []), false);
});
check('swap handover', () => {
  const c = { type: 'swap', swap_mode: 'handover', employee_id: 'a', colleague_id: 'b', date: D };
  assert.strictEqual(R.respected(c, [E('b', D, '07:00', '15:00')]), true);
  assert.strictEqual(R.respected(c, [E('a', D, '07:00', '15:00'), E('b', D, '07:00', '15:00')]), false);
  assert.strictEqual(R.respected({ ...c, colleague_id: null }, [E('b', D, '07:00', '15:00')]), false);
});
check('swap mutual', () => {
  const c = { type: 'swap', swap_mode: 'mutual', employee_id: 'a', colleague_id: 'b', date: D, target_date: T };
  assert.strictEqual(R.respected(c, [E('b', D, '07:00', '15:00'), E('a', T, '07:00', '15:00')]), true);
  assert.strictEqual(R.respected(c, [E('b', D, '07:00', '15:00'), E('a', T, '07:00', '15:00'), E('b', T, '07:00', '15:00')]), false);
});
check('other is never automatic', () => assert.strictEqual(R.respected({ type: 'other', employee_id: 'a', date: D }, []), null));
check('ids compared as strings', () => assert.strictEqual(R.respected({ type: 'day_off', employee_id: { toString: () => 'a' }, date: D }, [E('a', D, '07:00', '15:00')]), false));

console.log('\nblocksEntry');
check('day_off blocks her entry that day only', () => {
  const c = { type: 'day_off', employee_id: 'a', date: D };
  assert.strictEqual(R.blocksEntry(c, E('a', D, '07:00', '15:00')), true);
  assert.strictEqual(R.blocksEntry(c, E('a', T, '07:00', '15:00')), false);
  assert.strictEqual(R.blocksEntry(c, E('b', D, '07:00', '15:00')), false);
});
check('partial blocks only overlapping hours', () => {
  const c = { type: 'partial', employee_id: 'a', date: D, from_hhmm: '10:00', to_hhmm: '12:00' };
  assert.strictEqual(R.blocksEntry(c, E('a', D, '11:00', '15:00')), true);
  assert.strictEqual(R.blocksEntry(c, E('a', D, '12:00', '15:00')), false);
});
check('swap blocks the requester on date', () => assert.strictEqual(R.blocksEntry({ type: 'swap', employee_id: 'a', date: D }, E('a', D, '07:00', '15:00')), true));
check('other blocks nothing', () => assert.strictEqual(R.blocksEntry({ type: 'other', employee_id: 'a', date: D }, E('a', D, '07:00', '15:00')), false));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
