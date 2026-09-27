#!/usr/bin/env node
/**
 * Punch follow-up engine — pure rules, hand-built data, no database.
 * Spec: docs/superpowers/specs/2026-09-27-punch-followup-design.md
 *
 *   node scripts/punch-followup-engine.test.js
 */
const assert = require('assert');
const E = require('../src/services/punchFollowup/engine');

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

console.log('day rule + window');
ok('1 = missing, >2 = duplicate, 0 and 2 = nothing', () => {
  assert.strictEqual(E.classifyDayCount(0), null);
  assert.strictEqual(E.classifyDayCount(1), 'missing');
  assert.strictEqual(E.classifyDayCount(2), null);
  assert.strictEqual(E.classifyDayCount(3), 'duplicate');
});
ok('window: previous month start → yesterday', () => {
  assert.deepStrictEqual(E.followupWindow('2026-10-15', '2026-01-01'), { from: '2026-09-01', to: '2026-10-14' });
});
ok('window: go-live date clamps the start', () => {
  assert.deepStrictEqual(E.followupWindow('2026-10-15', '2026-10-05'), { from: '2026-10-05', to: '2026-10-14' });
});
ok('window: no start date → flow off', () => {
  assert.strictEqual(E.followupWindow('2026-10-15', null), null);
});
ok('window: went live today → nothing yet', () => {
  assert.strictEqual(E.followupWindow('2026-10-15', '2026-10-15'), null);
});
ok('window: 1st of month still covers last day of previous month', () => {
  assert.deepStrictEqual(E.followupWindow('2026-10-01', '2026-01-01'), { from: '2026-09-01', to: '2026-09-30' });
});
ok('addDays crosses months', () => {
  assert.strictEqual(E.addDays('2026-09-30', 1), '2026-10-01');
  assert.strictEqual(E.addDays('2026-10-01', -2), '2026-09-29');
});

console.log(`\nAll punch follow-up engine tests passed (${passed} checks).`);
