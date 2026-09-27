# Punch Follow-up — Stage 1 (Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure engine plus a read-only database loader. Together they answer, for any employee and any day in the follow-up window: "is there a punch problem here (missing / duplicate / empty scheduled day), where does it stand (open / pending_manager / handled), and who should see it (employee / manager)?" The stage also adds the new models the later stages write to.

**Architecture:** `engine.js` is pure. It takes plain objects and returns issue objects, and it has no database access, so every rule is unit-tested with hand-built data. `load.js` does the Mongo reads and normalizes documents into the engine's input shape. The "1 counted punch = missing, >2 = duplicate" rule moves into `engine.classifyDayCount` and the existing `punchIssues` calls it, so the two can never drift apart. Stage 1 ships dormant: without the `punch_followup_start_date` Setting the window is `null` and nothing happens.

**Tech Stack:** Node (CommonJS), Mongoose, plain `assert` test scripts in `server/scripts/*.test.js` (repo convention — no jest).

**Spec:** `docs/superpowers/specs/2026-09-27-punch-followup-design.md` (stage 1 section)

## Global Constraints

- Days are Israel-local `YYYY-MM-DD` strings. Weekday 0 = Sunday … 5 = Friday, 6 = Saturday, and Saturday is never a work day.
- Counted punch statuses are `auto` and `approved`. `rejected` is ignored entirely. `pending` / `pending_manager` = at the manager. `pending_accountant` = the manager already approved.
- The window runs from `max(first day of previous month, punch_followup_start_date)` to **yesterday**, inclusive. No start date means window `null` and no issues.
- The engine never touches the DB. The loader never writes: `server/.env` points at **production**.
- Employees with `is_active === false` or `receives_salary === false` are never chased.
- Test convention: `node scripts/<name>.test.js` prints `✓` lines and exits non-zero on failure. Register it in `server/package.json` as `test:<name>`.

---

### Task 1: Shared day rule + window helpers

**Files:**
- Create: `server/src/services/punchFollowup/engine.js`
- Create: `server/scripts/punch-followup-engine.test.js`
- Modify: `server/src/controllers/payrollMonth.controller.js` (the `punchIssues` loop, currently `:4333-4339`)
- Modify: `server/package.json` (add `test:punch-followup`)

**Interfaces:**
- Produces:
  - `classifyDayCount(n: number) → 'missing' | 'duplicate' | null`
  - `addDays(ymd: string, n: number) → string`
  - `followupWindow(today: string, startDate: string|null) → {from, to} | null`

- [ ] **Step 1: Write the failing test** (`server/scripts/punch-followup-engine.test.js`)

```js
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
```

- [ ] **Step 2: Run it — expect FAIL** `cd server && node scripts/punch-followup-engine.test.js` → `Cannot find module '../src/services/punchFollowup/engine'`

- [ ] **Step 3: Implement** (`server/src/services/punchFollowup/engine.js`)

```js
'use strict';

/**
 * Punch follow-up — the PURE engine (stage 1 of
 * docs/superpowers/specs/2026-09-27-punch-followup-design.md).
 *
 * No database here. The loader hands in plain objects; the engine decides
 * which employee-days are problems, where each one stands, and who sees it.
 * The "one counted punch = missing, more than two = duplicate" rule lives here
 * and punchIssues (the accountant's screen) calls it too — two copies of that
 * rule is how the employee's popup and the payroll screen would start to
 * disagree about the same day.
 */

/** 1 counted punch → missing; more than 2 → duplicate; 0 and 2 → nothing. */
function classifyDayCount(n) {
  if (n === 1) return 'missing';
  if (n > 2) return 'duplicate';
  return null;
}

/** Calendar arithmetic on 'YYYY-MM-DD', at noon UTC so DST never shifts the day. */
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function firstOfPreviousMonth(ymd) {
  const d = new Date(`${ymd.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The days the follow-up looks at: from the start of the previous month (so
 * the 1st of a month still sees yesterday) or the go-live date, whichever is
 * later, up to yesterday. No go-live date = the flow is off.
 */
function followupWindow(today, startDate) {
  if (!startDate) return null;
  const to = addDays(today, -1);
  const prev = firstOfPreviousMonth(today);
  const from = startDate > prev ? startDate : prev;
  return from > to ? null : { from, to };
}

module.exports = { classifyDayCount, addDays, followupWindow };
```

- [ ] **Step 4: Run it — expect PASS** (7 checks).

- [ ] **Step 5: Make `punchIssues` use the shared rule.** In `payrollMonth.controller.js`, add near the other service requires:

```js
const { classifyDayCount } = require('../services/punchFollowup/engine');
```

and replace, in `punchIssues`:

```js
    if (list.length > 2) dupKeys.push(k);
    // A lone punch TODAY is a shift in progress, not an omission. A duplicate
    // today is still a duplicate — nothing about the day being unfinished
    // explains four readings.
    else if (list.length === 1) { if (dayOf < todayIL) missKeys.push(k); }
    else if (list.length === 2) {
```

with:

```js
    const cls = classifyDayCount(list.length);
    if (cls === 'duplicate') dupKeys.push(k);
    // A lone punch TODAY is a shift in progress, not an omission. A duplicate
    // today is still a duplicate — nothing about the day being unfinished
    // explains four readings.
    else if (cls === 'missing') { if (dayOf < todayIL) missKeys.push(k); }
    else if (list.length === 2) {
```

- [ ] **Step 6:** Add `"test:punch-followup": "node scripts/punch-followup-engine.test.js",` to `server/package.json` scripts. Run the test, and `node -e "require('./src/controllers/payrollMonth.controller.js')"` from `server/` (must load clean).

- [ ] **Step 7: Commit**

```bash
git add server/src/services/punchFollowup/engine.js server/scripts/punch-followup-engine.test.js server/src/controllers/payrollMonth.controller.js server/package.json
git commit -m "feat(punch-followup): the engine's day rule and window — shared with punchIssues"
```

---

### Task 2: `buildIssues` — missing and duplicate, with state

**Files:**
- Modify: `server/src/services/punchFollowup/engine.js`
- Modify: `server/scripts/punch-followup-engine.test.js`

**Interfaces:**
- Consumes: `classifyDayCount`, `addDays` (Task 1)
- Produces: `buildIssues(input) → Issue[]`

```
input = {
  window: {from, to},
  employees:    [{ id, branch_id, start_date /*ymd|null*/, is_active, receives_salary }],
  punches:      [{ employee_id, day /*ymd*/, approval_status }],
  commitments:  Map<employee_id, { days:[{day,is_off,start_hhmm,end_hhmm}], is_alternating_off, alternating_day }>,
  requests:     [{ employee_id, from_date, to_date /*ymd|null*/, status }],
  closures:     [{ branch_id /*string|null = all*/, from, to }],
  resolutions:  [{ employee_id, date, status }],
  explanations: [{ employee_id, date, status }],
}
Issue = { key: `${employee_id}|${date}|${kind}`, employee_id, branch_id, date,
          kind: 'missing'|'duplicate'|'empty_day', state: 'open'|'pending_manager'|'handled' }
```

All ids are strings, all dates `YYYY-MM-DD`.

- [ ] **Step 1: Add failing tests** (before the final `console.log`):

```js
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
```

- [ ] **Step 2: Run — expect FAIL** (`E.buildIssues is not a function`).

- [ ] **Step 3: Implement** — add to `engine.js` (and export `buildIssues`):

```js
const COUNTED = new Set(['auto', 'approved']);
const AT_MANAGER = new Set(['pending', 'pending_manager']);

function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const dayKey = (empId, date) => `${empId}|${date}`;

/** Group a list by employee|day. */
function byEmpDay(list, dateField) {
  const m = new Map();
  for (const x of list) {
    const k = dayKey(String(x.employee_id), x[dateField]);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

/**
 * Where a day's own reports put it. A report the manager has not seen yet →
 * pending_manager; one she approved (now with the accountant) → handled.
 * Rejected reports are gone, so a rejection falls back to open by itself.
 */
function stateFromReports(pending) {
  if (pending.some(p => p.approval_status === 'pending_accountant')) return 'handled';
  if (pending.some(p => AT_MANAGER.has(p.approval_status))) return 'pending_manager';
  return null;
}

function buildIssues(input) {
  const { window, employees } = input;
  if (!window) return [];
  const punchesByDay = byEmpDay((input.punches || []).filter(p => p.approval_status !== 'rejected'), 'day');
  const resolutionByDay = new Map((input.resolutions || []).map(r => [dayKey(String(r.employee_id), r.date), r]));
  const issues = [];
  const days = eachDay(window.from, window.to);

  for (const e of employees) {
    if (e.is_active === false || e.receives_salary === false) continue;
    const empId = String(e.id);
    for (const date of days) {
      if (e.start_date && date < e.start_date) continue;
      const dayPunches = punchesByDay.get(dayKey(empId, date)) || [];
      const counted = dayPunches.filter(p => COUNTED.has(p.approval_status || 'auto'));
      const pending = dayPunches.filter(p => !COUNTED.has(p.approval_status || 'auto'));
      const kind = classifyDayCount(counted.length);
      const push = (k, state) => issues.push({
        key: `${empId}|${date}|${k}`, employee_id: empId, branch_id: e.branch_id ? String(e.branch_id) : null,
        date, kind: k, state,
      });

      if (kind === 'missing') {
        push('missing', stateFromReports(pending) || 'open');
      } else if (kind === 'duplicate') {
        const r = resolutionByDay.get(dayKey(empId, date));
        if (r && r.status === 'approved') continue;
        push('duplicate', r?.status === 'pending' ? 'handled'
          : r?.status === 'pending_manager' ? 'pending_manager' : 'open');
      }
    }
  }
  return issues;
}
```

- [ ] **Step 4: Run — expect PASS** (17 checks).

- [ ] **Step 5: Commit** — `git commit -am "feat(punch-followup): buildIssues — missing and duplicate days with their state"`

---

### Task 3: `buildIssues` — the empty scheduled day

**Files:**
- Modify: `server/src/services/punchFollowup/engine.js`
- Modify: `server/scripts/punch-followup-engine.test.js`

**Interfaces:**
- Consumes: the `buildIssues` input fields `commitments`, `requests`, `closures`, `explanations` (Task 2)
- Produces: issues with `kind: 'empty_day'`

- [ ] **Step 1: Add failing tests:**

```js
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
```

- [ ] **Step 2: Run — expect FAIL** (no `empty_day` issues produced).

- [ ] **Step 3: Implement.** Add these helpers to `engine.js`:

```js
const weekdayOf = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

/** Her commitment says she works this weekday (Saturday never; the alternating day never — we can't know which week). */
function isScheduled(commitment, date) {
  if (!commitment) return false;
  const wd = weekdayOf(date);
  if (wd === 6) return false;
  if (commitment.is_alternating_off && commitment.alternating_day === wd) return false;
  const d = (commitment.days || []).find(x => x.day === wd);
  return !!(d && !d.is_off && d.start_hhmm && d.end_hhmm);
}

const covers = (from, to, date) => from <= date && date <= (to || from);
```

In `buildIssues`, before the employee loop, index the new inputs:

```js
  const commitments = input.commitments || new Map();
  const requestsByEmp = new Map();
  for (const r of input.requests || []) {
    if (r.status === 'rejected') continue;
    const k = String(r.employee_id);
    if (!requestsByEmp.has(k)) requestsByEmp.set(k, []);
    requestsByEmp.get(k).push(r);
  }
  const explanationByDay = new Map((input.explanations || []).map(x => [dayKey(String(x.employee_id), x.date), x]));
  const closures = input.closures || [];
```

Then after the `duplicate` branch inside the date loop, add:

```js
      else if (counted.length === 0 && isScheduled(commitments.get(empId), date)) {
        const branch = e.branch_id ? String(e.branch_id) : null;
        if (closures.some(c => (c.branch_id == null || String(c.branch_id) === branch) && covers(c.from, c.to, date))) continue;
        const reqs = (requestsByEmp.get(empId) || []).filter(r => covers(r.from_date, r.to_date, date));
        if (reqs.some(r => r.status === 'approved')) continue;
        const expl = explanationByDay.get(dayKey(empId, date));
        if (expl && expl.status === 'accepted') continue;
        const state = stateFromReports(pending)
          || (reqs.some(r => r.status === 'pending_accountant') ? 'handled' : null)
          || (reqs.some(r => AT_MANAGER.has(r.status)) ? 'pending_manager' : null)
          || (expl && expl.status === 'pending_manager' ? 'pending_manager' : null)
          || 'open';
        push('empty_day', state);
      }
```

- [ ] **Step 4: Run — expect PASS** (24 checks).

- [ ] **Step 5: Commit** — `git commit -am "feat(punch-followup): the empty scheduled day — commitment minus sick, vacation, closures"`

---

### Task 4: Who sees what — `visibility`

**Files:**
- Modify: `server/src/services/punchFollowup/engine.js`
- Modify: `server/scripts/punch-followup-engine.test.js`

**Interfaces:**
- Produces: `visibility(issue: Issue, { today: string, hasUser: boolean }) → { employee: 'fix'|'sent'|null, manager: 'awaiting'|'unhandled'|null }`

- [ ] **Step 1: Add failing tests:**

```js
console.log('\nvisibility');
const iss = (date, state) => ({ date, state });
const V = (i, hasUser = true) => E.visibility(i, { today: '2026-10-15', hasUser });
ok('yesterday, open → employee fixes, manager not yet', () => {
  assert.deepStrictEqual(V(iss('2026-10-14', 'open')), { employee: 'fix', manager: null });
});
ok('two days ago, open → both (stays with the employee too)', () => {
  assert.deepStrictEqual(V(iss('2026-10-13', 'open')), { employee: 'fix', manager: 'unhandled' });
});
ok('no app user → straight to the manager, from yesterday', () => {
  assert.deepStrictEqual(V(iss('2026-10-14', 'open'), false), { employee: null, manager: 'unhandled' });
});
ok('pending_manager → employee sees "sent", manager must approve', () => {
  assert.deepStrictEqual(V(iss('2026-10-14', 'pending_manager')), { employee: 'sent', manager: 'awaiting' });
});
ok('handled → nobody', () => {
  assert.deepStrictEqual(V(iss('2026-10-10', 'handled')), { employee: null, manager: null });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** (export `visibility`):

```js
/**
 * Who sees an issue today. The employee keeps an open issue on her popup
 * until someone handles it; the manager gets it after one day of grace —
 * immediately when the employee has no app login to be asked through.
 */
function visibility(issue, { today, hasUser }) {
  if (issue.state === 'handled') return { employee: null, manager: null };
  if (issue.state === 'pending_manager') return { employee: 'sent', manager: 'awaiting' };
  const graceOver = issue.date <= addDays(today, -2);
  return {
    employee: hasUser ? 'fix' : null,
    manager: (graceOver || !hasUser) ? 'unhandled' : null,
  };
}
```

- [ ] **Step 4: Run — expect PASS** (29 checks).

- [ ] **Step 5: Commit** — `git commit -am "feat(punch-followup): visibility — employee first, manager after a day of grace"`

---

### Task 5: The new models

**Files:**
- Create: `server/src/models/PunchDayExplanation.js`
- Create: `server/src/models/PunchFollowupLog.js`
- Modify: `server/src/models/PunchResolution.js` (`status` enum + `proposed_by_role`)
- Modify: `server/src/models/index.js` (register both)
- Create: `server/scripts/punch-followup-models.test.js`

**Interfaces:**
- Produces: Mongoose models `PunchDayExplanation`, `PunchFollowupLog`. `PunchResolution.status` now also accepts `'pending_manager'`, and the schema gains `proposed_by_role: 'employee'|'manager'|''`.

- [ ] **Step 1: Failing test** (`server/scripts/punch-followup-models.test.js`):

```js
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
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Create `server/src/models/PunchDayExplanation.js`:

```js
const mongoose = require('mongoose');

/**
 * An employee's explanation for a scheduled day with no punches, when she did
 * not work and the reason is neither sick nor vacation (those go through
 * EmployeeRequest). The branch manager accepts (the day stops being a
 * problem — and is unpaid) or rejects it (back to the employee's popup).
 */
const punchDayExplanationSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  date: { type: String, required: true },                 // 'YYYY-MM-DD' (Israel-local)
  reason_text: { type: String, default: '' },
  status: { type: String, enum: ['pending_manager', 'accepted', 'rejected'], default: 'pending_manager' },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_at: { type: Date, default: null },
  reject_reason: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

punchDayExplanationSchema.index({ employee_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('PunchDayExplanation', punchDayExplanationSchema);
```

Create `server/src/models/PunchFollowupLog.js`:

```js
const mongoose = require('mongoose');

/**
 * What the follow-up already SENT about an issue. The issue itself is never
 * stored (it is recomputed from punches every time); this is only the record
 * that lets the manager see "נשלחה תזכורת ב-…" and stops the same push from
 * going out twice.
 */
const punchFollowupLogSchema = new mongoose.Schema({
  issue_key: { type: String, required: true, index: true }, // `${employee_id}|${date}|${kind}`
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  date: { type: String, required: true },
  kind: { type: String, enum: ['missing', 'duplicate', 'empty_day'], required: true },
  action: {
    type: String,
    enum: ['employee_push', 'manager_whatsapp', 'manager_push', 'decision_push'],
    required: true,
  },
  by_user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  at: { type: Date, default: Date.now },
});

punchFollowupLogSchema.index({ employee_id: 1, date: 1 });

module.exports = mongoose.model('PunchFollowupLog', punchFollowupLogSchema);
```

In `PunchResolution.js` replace the status line and add the role:

```js
  status: { type: String, enum: ['pending_manager', 'pending', 'approved'], default: 'approved' },
  // Who drew up the labels: the employee herself (from her follow-up popup →
  // pending_manager) or a branch manager (→ pending, the accountant's queue).
  proposed_by_role: { type: String, enum: ['employee', 'manager', ''], default: '' },
```

In `server/src/models/index.js` add the requires (next to `ShkulitEmployeeSnapshot`) and the exports:

```js
const PunchDayExplanation = require('./PunchDayExplanation');
const PunchFollowupLog = require('./PunchFollowupLog');
```

```js
  PunchDayExplanation,
  PunchFollowupLog,
```

- [ ] **Step 4: Run — expect PASS** (3 checks). Register `"test:punch-followup-models": "node scripts/punch-followup-models.test.js",`.

- [ ] **Step 5: Commit** — `git commit -am "feat(punch-followup): models — day explanation, follow-up log, employee-proposed resolutions"` (after `git add` of the two new model files and the test).

---

### Task 6: The read-only loader + production preview

**Files:**
- Create: `server/src/services/punchFollowup/load.js`
- Create: `server/scripts/punch-followup-preview.js`

**Interfaces:**
- Consumes: `buildIssues`, `followupWindow`, `visibility`, `addDays` (engine)
- Produces:
  - `loadFollowup({ today, employeeFilter = {}, startOverride = null }) → Promise<{ window, issues, employeesById }>`
  - `START_KEY = 'punch_followup_start_date'`
  - Each returned issue carries `visibility` (the `visibility()` result) and `has_user`.

- [ ] **Step 1: Implement `load.js`:**

```js
'use strict';

/**
 * Punch follow-up — the DATABASE side. Reads only; everything it decides, it
 * decides by handing plain objects to engine.js. Never call punchIssues from
 * here: that function rejects mirrored reports as a side effect.
 */
const {
  Employee, Punch, EmployeeCommitment, EmployeeRequest, Holiday, SpecialDay,
  PunchResolution, PunchDayExplanation, Setting,
} = require('../../models');
const { buildIssues, followupWindow, visibility, addDays } = require('./engine');

const START_KEY = 'punch_followup_start_date';
const ISR_DAY = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

async function loadFollowup({ today, employeeFilter = {}, startOverride = null }) {
  const start = startOverride || (await Setting.findOne({ key: START_KEY }).lean())?.value || null;
  const window = followupWindow(today, start);
  if (!window) return { window: null, issues: [], employeesById: new Map() };

  const employees = await Employee.find({ ...employeeFilter, is_active: { $ne: false } })
    .select('_id full_name branch_id start_date is_active receives_salary user_id phone').lean();
  const ids = employees.map(e => e._id);
  const userIds = employees.map(e => e.user_id).filter(Boolean);
  const empByUser = new Map(employees.filter(e => e.user_id).map(e => [String(e.user_id), String(e._id)]));
  const branchIds = [...new Set(employees.map(e => String(e.branch_id)).filter(Boolean))];

  // A generous UTC margin, then the exact Israel day is taken per punch.
  const fromTs = new Date(`${addDays(window.from, -1)}T00:00:00Z`);
  const toTs = new Date(`${addDays(window.to, 2)}T00:00:00Z`);

  const [punches, commitments, requests, holidays, specials, resolutions, explanations] = await Promise.all([
    Punch.find({ employee_id: { $in: ids }, timestamp: { $gte: fromTs, $lt: toTs }, ignored: { $ne: true } })
      .select('employee_id timestamp approval_status').lean(),
    EmployeeCommitment.find({ employee_id: { $in: ids } })
      .select('employee_id days is_alternating_off alternating_day').lean(),
    EmployeeRequest.find({
      $or: [{ employee_id: { $in: ids } }, ...(userIds.length ? [{ user_id: { $in: userIds } }] : [])],
      type: { $in: ['sick', 'vacation', 'pregnancy_exam'] },
      from_date: { $lte: window.to },
    }).select('employee_id user_id from_date to_date status').lean(),
    Holiday.find({
      branch_id: { $in: branchIds }, kind: { $ne: 'short_day' },
      start_date: { $lte: toTs }, end_date: { $gte: fromTs },
    }).select('branch_id start_date end_date').lean(),
    SpecialDay.find({ date: { $gte: window.from, $lte: window.to } }).select('branch_id date').lean(),
    PunchResolution.find({ employee_id: { $in: ids }, date: { $gte: window.from, $lte: window.to } })
      .select('employee_id date status').lean(),
    PunchDayExplanation.find({ employee_id: { $in: ids }, date: { $gte: window.from, $lte: window.to } })
      .select('employee_id date status').lean(),
  ]);

  const issues = buildIssues({
    window,
    employees: employees.map(e => ({
      id: String(e._id), branch_id: e.branch_id ? String(e.branch_id) : null,
      start_date: e.start_date ? ISR_DAY(e.start_date) : null,
      is_active: e.is_active, receives_salary: e.receives_salary,
    })),
    punches: punches.map(p => ({ employee_id: String(p.employee_id), day: ISR_DAY(p.timestamp), approval_status: p.approval_status || 'auto' })),
    commitments: new Map(commitments.map(c => [String(c.employee_id), c])),
    requests: requests
      .map(r => ({ ...r, employee_id: r.employee_id ? String(r.employee_id) : empByUser.get(String(r.user_id)) }))
      .filter(r => r.employee_id),
    closures: [
      ...holidays.map(h => ({ branch_id: String(h.branch_id), from: ISR_DAY(h.start_date), to: ISR_DAY(h.end_date) })),
      ...specials.map(s => ({ branch_id: s.branch_id ? String(s.branch_id) : null, from: s.date, to: s.date })),
    ],
    resolutions: resolutions.map(r => ({ ...r, employee_id: String(r.employee_id) })),
    explanations: explanations.map(x => ({ ...x, employee_id: String(x.employee_id) })),
  });

  const employeesById = new Map(employees.map(e => [String(e._id), e]));
  for (const i of issues) {
    i.has_user = !!employeesById.get(i.employee_id)?.user_id;
    i.visibility = visibility(i, { today, hasUser: i.has_user });
  }
  return { window, issues, employeesById };
}

module.exports = { loadFollowup, START_KEY };
```

- [ ] **Step 2: Create `server/scripts/punch-followup-preview.js`** (read-only, prints aggregates only):

```js
#!/usr/bin/env node
/**
 * READ-ONLY preview of the punch follow-up against the configured database
 * (server/.env = PRODUCTION). Prints counts only — no names.
 *
 *   node scripts/punch-followup-preview.js [startDate=YYYY-MM-DD]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { loadFollowup } = require('../src/services/punchFollowup/load');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const startOverride = process.argv[2] || null;
  const { window, issues } = await loadFollowup({ today, startOverride });
  console.log('today', today, 'window', JSON.stringify(window));
  const tally = {};
  for (const i of issues) {
    const k = `${i.kind}/${i.state}/emp:${i.visibility.employee || '-'}/mgr:${i.visibility.manager || '-'}`;
    tally[k] = (tally[k] || 0) + 1;
  }
  console.log(JSON.stringify(tally, null, 1));
  console.log('employees with an open issue:', new Set(issues.filter(i => i.state === 'open').map(i => i.employee_id)).size);
  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 3: Run the preview against production** with a start date one week back (for example `node scripts/punch-followup-preview.js 2026-09-20`). Expected:
  - it prints a window and a tally, and exits 0;
  - there are `missing` counts in the same ballpark as the "בעיות בהחתמה" screen for those days;
  - `empty_day` counts are plausible — a handful, not every employee every day. If every employee shows up every day, the commitment weekday mapping is wrong: stop and investigate.
- [ ] **Step 4:** Run with no argument. Expected: `window null`, no issues (the Setting is not set — dormant).
- [ ] **Step 5: Commit** — `git add server/src/services/punchFollowup/load.js server/scripts/punch-followup-preview.js && git commit -m "feat(punch-followup): the read-only loader + a production preview"`

---

### Task 7: Ship stage 1

- [ ] Run all of: `test:punch-followup`, `test:punch-followup-models`, `scripts/notification-types.test.js`, `scripts/punch-digest.test.js`, `scripts/clock-word-stands.test.js`, `scripts/manager-first-gate.test.js`, and a load of `payrollMonth.controller.js`.
- [ ] `git push origin main`, then poll `https://gan-halomot.onrender.com/api/health` until `commit` matches.
- [ ] Open "בעיות בהחתמה" in production (it now runs through the shared `classifyDayCount`) and confirm the same counts as before, with no console errors.
- [ ] Update memory `gan-punch-followup.md`: stage 1 deployed, preview numbers, next = stage 2.
