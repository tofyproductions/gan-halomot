#!/usr/bin/env node
/**
 * Punch follow-up — the pure helpers behind the employee's fixes and her
 * morning push. No database.
 *
 *   node scripts/punch-followup-fix.test.js
 */
const assert = require('assert');
const F = require('../src/services/punchFollowup/fix');

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

console.log('missingSide');
ok('the clock said entry → she is missing the exit, and vice versa', () => {
  assert.strictEqual(F.missingSide({ state: 0, hhmm: '07:30' }, '16:00'), 'out');
  assert.strictEqual(F.missingSide({ state: 1, hhmm: '16:00' }, '07:30'), 'in');
});
ok('direction unknown (255) → by time order', () => {
  assert.strictEqual(F.missingSide({ state: 255, hhmm: '07:30' }, '16:00'), 'out');
  assert.strictEqual(F.missingSide({ state: 255, hhmm: '16:00' }, '07:30'), 'in');
});

console.log('\nvalidateLabels');
const ids = ['a', 'b', 'c'];
ok('a clean in/ignore/out labelling passes', () => {
  assert.strictEqual(F.validateLabels([{ punch_id: 'a', role: 'in' }, { punch_id: 'b', role: 'ignore' }, { punch_id: 'c', role: 'out' }], ids), null);
});
ok('every punch labelled exactly once', () => {
  assert.ok(F.validateLabels([{ punch_id: 'a', role: 'in' }, { punch_id: 'c', role: 'out' }], ids));
  assert.ok(F.validateLabels([{ punch_id: 'a', role: 'in' }, { punch_id: 'a', role: 'ignore' }, { punch_id: 'c', role: 'out' }], ids));
  assert.ok(F.validateLabels([{ punch_id: 'a', role: 'in' }, { punch_id: 'b', role: 'ignore' }, { punch_id: 'z', role: 'out' }], ids));
});
ok('roles are bounded, and in/out must pair', () => {
  assert.ok(F.validateLabels([{ punch_id: 'a', role: 'in' }, { punch_id: 'b', role: 'lunch' }, { punch_id: 'c', role: 'out' }], ids));
  assert.ok(F.validateLabels([{ punch_id: 'a', role: 'in' }, { punch_id: 'b', role: 'in' }, { punch_id: 'c', role: 'out' }], ids));
  assert.ok(F.validateLabels([{ punch_id: 'a', role: 'ignore' }, { punch_id: 'b', role: 'ignore' }, { punch_id: 'c', role: 'ignore' }], ids));
});

console.log('\npickEmployeePushes');
const I = (employee_id, date, view = 'fix', key = `${employee_id}|${date}|missing`) => (
  { key, employee_id, date, kind: 'missing', has_user: true, visibility: { employee: view } });
ok('only yesterday, only open-for-her, only not yet sent', () => {
  const issues = [I('e1', '2026-10-14'), I('e1', '2026-10-13'), I('e2', '2026-10-14', 'sent'), I('e3', '2026-10-14')];
  const m = F.pickEmployeePushes(issues, new Set(['e3|2026-10-14|missing']), '2026-10-14');
  assert.deepStrictEqual([...m.keys()], ['e1']);
  assert.strictEqual(m.get('e1').length, 1);
});
ok('no app user → no push', () => {
  const m = F.pickEmployeePushes([{ ...I('e1', '2026-10-14'), has_user: false }], new Set(), '2026-10-14');
  assert.strictEqual(m.size, 0);
});

console.log('\npushText');
ok('one issue → named by kind and day', () => {
  assert.deepStrictEqual(F.pushText([{ kind: 'missing', date: '2026-09-27' }]),
    { title: 'חסרה לך החתמה ביום ראשון 27.9', body: 'לחצי כאן לתיקון' });
  assert.strictEqual(F.pushText([{ kind: 'duplicate', date: '2026-09-27' }]).title, 'יש לך החתמה כפולה ביום ראשון 27.9');
  assert.strictEqual(F.pushText([{ kind: 'empty_day', date: '2026-09-27' }]).title, 'לא נמצאו החתמות ביום ראשון 27.9');
});
ok('several → one summary', () => {
  assert.strictEqual(F.pushText([{ kind: 'missing', date: '2026-09-27' }, { kind: 'duplicate', date: '2026-09-28' }]).title,
    'יש לך 2 ימים לתיקון בהחתמות');
});

console.log(`\nAll punch follow-up fix tests passed (${passed} checks).`);
