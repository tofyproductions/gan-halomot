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

console.log('\nbuildIssues — missing / duplicate');
const WIN = { from: '2026-10-04', to: '2026-10-08' }; // Sun 4 … Thu 8
const emp = { id: 'e1', branch_id: 'b1', start_date: null, is_active: true, receives_salary: true };
const base = (over = {}) => ({
  window: WIN, employees: [emp], punches: [], commitments: new Map(), requests: [],
  closures: [], resolutions: [], explanations: [], ...over,
});
const P = (day, approval_status = 'auto') => ({ employee_id: 'e1', day, approval_status });
const one = (issues, date, kind) => issues.filter(i => i.date === date && i.kind === kind);

ok('one counted punch → missing, open', () => {
  const out = E.buildIssues(base({ punches: [P('2026-10-05')] }));
  assert.deepStrictEqual(one(out, '2026-10-05', 'missing').map(i => i.state), ['open']);
  assert.strictEqual(out[0].key, 'e1|2026-10-05|missing');
});
ok('missing + her report at the manager → pending_manager', () => {
  const out = E.buildIssues(base({ punches: [P('2026-10-05'), P('2026-10-05', 'pending_manager')] }));
  assert.deepStrictEqual(one(out, '2026-10-05', 'missing').map(i => i.state), ['pending_manager']);
});
ok('legacy "pending" counts as at the manager', () => {
  const out = E.buildIssues(base({ punches: [P('2026-10-05'), P('2026-10-05', 'pending')] }));
  assert.strictEqual(one(out, '2026-10-05', 'missing')[0].state, 'pending_manager');
});
ok('missing + manager already approved (pending_accountant) → handled', () => {
  const out = E.buildIssues(base({ punches: [P('2026-10-05'), P('2026-10-05', 'pending_accountant')] }));
  assert.strictEqual(one(out, '2026-10-05', 'missing')[0].state, 'handled');
});
ok('rejected report → back to open', () => {
  const out = E.buildIssues(base({ punches: [P('2026-10-05'), P('2026-10-05', 'rejected')] }));
  assert.strictEqual(one(out, '2026-10-05', 'missing')[0].state, 'open');
});
ok('a complete day is not an issue', () => {
  const out = E.buildIssues(base({ punches: [P('2026-10-05'), P('2026-10-05')] }));
  assert.strictEqual(out.length, 0);
});
ok('three counted punches → duplicate, open', () => {
  const out = E.buildIssues(base({ punches: [P('2026-10-06'), P('2026-10-06'), P('2026-10-06')] }));
  assert.strictEqual(one(out, '2026-10-06', 'duplicate')[0].state, 'open');
});
ok('duplicate: employee labels at manager → pending_manager; manager-approved (pending) → handled; approved → gone', () => {
  const punches = [P('2026-10-06'), P('2026-10-06'), P('2026-10-06')];
  const at = (status) => E.buildIssues(base({ punches, resolutions: [{ employee_id: 'e1', date: '2026-10-06', status }] }));
  assert.strictEqual(one(at('pending_manager'), '2026-10-06', 'duplicate')[0].state, 'pending_manager');
  assert.strictEqual(one(at('pending'), '2026-10-06', 'duplicate')[0].state, 'handled');
  assert.strictEqual(one(at('approved'), '2026-10-06', 'duplicate').length, 0);
});
ok('unpaid or inactive employees are never chased', () => {
  const punches = [P('2026-10-05')];
  assert.strictEqual(E.buildIssues(base({ punches, employees: [{ ...emp, receives_salary: false }] })).length, 0);
  assert.strictEqual(E.buildIssues(base({ punches, employees: [{ ...emp, is_active: false }] })).length, 0);
});
ok('days outside the window are ignored', () => {
  assert.strictEqual(E.buildIssues(base({ punches: [P('2026-10-09')] })).length, 0);
});

console.log('\nbuildIssues — empty scheduled day');
// Works Sun–Thu 07:30–15:00, Friday off.
const SCHED = new Map([['e1', {
  days: [0, 1, 2, 3, 4].map(day => ({ day, is_off: false, start_hhmm: '07:30', end_hhmm: '15:00' }))
    .concat([{ day: 5, is_off: true, start_hhmm: '', end_hhmm: '' }]),
  is_alternating_off: false, alternating_day: null,
}]]);
const empties = (over) => E.buildIssues(base({ commitments: SCHED, ...over }))
  .filter(i => i.kind === 'empty_day').map(i => i.date);

ok('every scheduled day with no punch is an empty day (Sun–Thu)', () => {
  assert.deepStrictEqual(empties({}), ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
});
ok('no commitment → no empty days', () => {
  assert.strictEqual(E.buildIssues(base()).filter(i => i.kind === 'empty_day').length, 0);
});
ok('Friday off / Saturday never / alternating day never', () => {
  const win = { from: '2026-10-09', to: '2026-10-10' }; // Fri, Sat
  assert.deepStrictEqual(empties({ window: win }), []);
  const alt = new Map([['e1', { ...SCHED.get('e1'), is_alternating_off: true, alternating_day: 0 }]]);
  assert.ok(!empties({ commitments: alt }).includes('2026-10-04'));
});
ok('approved sick/vacation covering the day → no issue', () => {
  const requests = [{ employee_id: 'e1', from_date: '2026-10-05', to_date: '2026-10-06', status: 'approved' }];
  assert.deepStrictEqual(empties({ requests }), ['2026-10-04', '2026-10-07', '2026-10-08']);
});
ok('closure (branch or all-branches) → no issue', () => {
  const closures = [{ branch_id: 'b1', from: '2026-10-04', to: '2026-10-05' }, { branch_id: null, from: '2026-10-08', to: '2026-10-08' }];
  assert.deepStrictEqual(empties({ closures }), ['2026-10-06', '2026-10-07']);
  const other = [{ branch_id: 'b2', from: '2026-10-04', to: '2026-10-08' }];
  assert.strictEqual(empties({ closures: other }).length, 5);
});
ok('before her start date → no issue', () => {
  assert.deepStrictEqual(empties({ employees: [{ ...emp, start_date: '2026-10-07' }] }), ['2026-10-07', '2026-10-08']);
});
ok('empty-day states: pending request / explanation → pending_manager; accepted explanation → gone; manager-approved report → handled', () => {
  const st = (over) => E.buildIssues(base({ commitments: SCHED, ...over }))
    .find(i => i.kind === 'empty_day' && i.date === '2026-10-05');
  assert.strictEqual(st({ requests: [{ employee_id: 'e1', from_date: '2026-10-05', to_date: null, status: 'pending_manager' }] }).state, 'pending_manager');
  assert.strictEqual(st({ requests: [{ employee_id: 'e1', from_date: '2026-10-05', to_date: null, status: 'pending_accountant' }] }).state, 'handled');
  assert.strictEqual(st({ explanations: [{ employee_id: 'e1', date: '2026-10-05', status: 'pending_manager' }] }).state, 'pending_manager');
  assert.strictEqual(st({ explanations: [{ employee_id: 'e1', date: '2026-10-05', status: 'accepted' }] }), undefined);
  assert.strictEqual(st({ explanations: [{ employee_id: 'e1', date: '2026-10-05', status: 'rejected' }] }).state, 'open');
  assert.strictEqual(st({ punches: [P('2026-10-05', 'pending_manager'), P('2026-10-05', 'pending_manager')] }).state, 'pending_manager');
  assert.strictEqual(st({ punches: [P('2026-10-05', 'pending_accountant'), P('2026-10-05', 'pending_accountant')] }).state, 'handled');
});

console.log(`\nAll punch follow-up engine tests passed (${passed} checks).`);
