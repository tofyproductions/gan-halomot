#!/usr/bin/env node
/** Schema-level checks for the punch follow-up models — validateSync only, no database. */
const assert = require('assert');
const mongoose = require('mongoose');
const { PunchDayExplanation, PunchFollowupLog, PunchResolution } = require('../src/models');
const id = () => new mongoose.Types.ObjectId();
let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

ok('explanation: valid, and status is bounded', () => {
  assert.strictEqual(new PunchDayExplanation({ employee_id: id(), date: '2026-10-05', reason_text: 'x' }).validateSync(), undefined);
  assert.ok(new PunchDayExplanation({ employee_id: id(), date: '2026-10-05', status: 'nope' }).validateSync());
});
ok('follow-up log: action is bounded', () => {
  const good = { issue_key: 'a|2026-10-05|missing', employee_id: id(), date: '2026-10-05', kind: 'missing', action: 'employee_push' };
  assert.strictEqual(new PunchFollowupLog(good).validateSync(), undefined);
  assert.ok(new PunchFollowupLog({ ...good, action: 'fax' }).validateSync());
});
ok('resolution accepts pending_manager + proposed_by_role', () => {
  const r = new PunchResolution({ employee_id: id(), date: '2026-10-05', status: 'pending_manager', proposed_by_role: 'employee' });
  assert.strictEqual(r.validateSync(), undefined);
});
console.log(`\nAll punch follow-up model tests passed (${passed} checks).`);
