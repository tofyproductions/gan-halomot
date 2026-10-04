# סידור עבודה — שלב 3: סניפים אחרים, שכר ודוח נוכחות — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Managers can place employees from other branches (with a per-branch rate, approved by the home manager per placement or by a permanent arrangement both managers confirm), no one is double-booked across branches, fixed-schedule employees are paid by the published rota, and a 07:00 report lists yesterday's no-shows and late arrivals.

**Architecture:** Pure rules in `services/shifts/crossRules.js`. Two models (`BranchRateRequest`, `CrossBranchArrangement`) with their services (`rateRequests.service.js`, `crossBranch.service.js`). The rota service gains cross-branch validation, status derivation, a publish guard, and board fields. A `rotaPay.service.js` turns a published week into fixed-schedule exceptions (with branch) — `fixedSchedule.js` learns to read the exception's branch. A report service + hourly-gated job produce the morning report.

**Tech Stack:** Express + Mongoose, React 18 + MUI 6 + Vite, `mongodb-memory-server` tests.

**Spec:** `docs/superpowers/specs/2026-10-04-shifts-phase3-crossbranch-design.md`

## Global Constraints

- Branch rate for host branch H exists when `employee.branch_rates` has a row with `String(branch_id) === String(H)` and (`hourly_rate > 0` or `global_salary > 0`).
- Rate request steps: `pending_home` → `pending_office` → `approved` | `rejected` (reject at any step needs a reason). Office = `system_admin` or `accountant`. Final rate > 0 is written to `branch_rates` (update `hourly_rate` of the existing row for H, else push `{ branch_id: H, hourly_rate }`).
- Cross-branch entry fields: `cross_branch: Boolean`, `cross_status: 'pending' | 'approved'` — both server-derived, never trusted from the client.
- Publish refused while any `cross_status: 'pending'` entry exists: 409 `'יש שיבוצים מסניף אחר שממתינים לאישור מנהלת סניף הבית'`.
- Cross-branch overlap: 400 `` `${name} משובצת באותן שעות בסניף ${otherBranchName} ב-${date}` ``. Touching (13:00/13:00) is allowed.
- Permanent arrangement: proposed after the 3rd consecutive approved week (same host, employee, weekday, start, end); `active` only when both `host_confirmed` and `home_confirmed`; either manager may cancel.
- Rota → fixed schedule: only on publish, only for `fixed_schedule.enabled` employees, never overwrites an exception whose `source !== 'rota'`; rota exceptions carry `source: 'rota'` and `branch_id`.
- Report: 07:00 Israel, about yesterday, Sunday–Friday only; late threshold 30 minutes; skip fixed-schedule employees; punches counted: `ignored != true`, `approval_status ∈ {auto, approved}`, `timestamp_source != 'fixed_schedule'`.
- All user-facing text Hebrew. Server tests = node scripts with dotenv stub, registered in `server/package.json`. Client: `npx vite build` passes. Commit per task with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

Server create: `src/services/shifts/crossRules.js`, `src/models/BranchRateRequest.js`, `src/models/CrossBranchArrangement.js`, `src/services/shifts/rateRequests.service.js`, `src/services/shifts/crossBranch.service.js`, `src/services/shifts/rotaPay.service.js`, `src/services/shifts/attendanceReport.service.js`, `src/services/shiftAttendanceReportJob.js`; tests `scripts/cross-rules.test.js`, `scripts/cross-branch-service.test.js`, `scripts/rota-pay.test.js`, `scripts/attendance-report.test.js`.
Server modify: `src/models/ShiftWeek.js`, `src/models/Employee.js`, `src/models/NotificationEvent.js`, `src/models/index.js`, `src/services/fixedSchedule.js`, `src/services/shifts/shiftWeek.service.js`, `src/controllers/shifts.controller.js`, `src/routes/shifts.routes.js`, `src/index.js`, `package.json`.
Client create: `src/components/shifts/CrossBranchPanel.jsx`, `src/components/shifts/RateRequestDialog.jsx`, `src/components/shifts/AttendanceReportDialog.jsx`.
Client modify: `src/components/shifts/EntryDialog.jsx`, `src/components/shifts/ShiftsScreen.jsx`, `src/components/shifts/shiftRows.js`, `src/config/screenHelp.js`.

---

### Task 1: Pure cross-branch rules

**Files:** Create `server/src/services/shifts/crossRules.js`; Test `server/scripts/cross-rules.test.js`; register `"test:cross-rules"` after `"test:constraints-service"`.

**Interfaces — Produces:** `hasBranchRate(employee, branchId) → bool`; `placementKey(e) → 'employee|date|start|end'`; `crossOverlaps(entries, otherEntries) → [{ employee_id, employee_name, date, other_branch_id }]` (other entries carry `branch_id`); `arrangementCovers(arr, entry) → bool` (arr `{ employee_id, weekday, start_hhmm, end_hhmm }`, uses the entry date's weekday); `rotaDay(entries, date) → { in, out, branch_id } | null` (earliest start, latest end, branch of the earliest entry); `lateness(firstPunchHHMM|null, scheduledStartHHMM, threshold=30) → { kind: 'absent' } | { kind: 'late', minutes } | null`.

- [ ] **Step 1: Failing test** — `server/scripts/cross-rules.test.js`

```js
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
```

- [ ] **Step 2: Run, expect `Cannot find module`.**
- [ ] **Step 3: Implement** — `server/src/services/shifts/crossRules.js`

```js
/**
 * סניפים אחרים — rules that need no database.
 */
const { weekdayOf } = require('../fixedSchedule');

const mins = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** A rate the payroll can actually pay her at that branch. */
function hasBranchRate(employee, branchId) {
  return (employee.branch_rates || []).some(r => String(r.branch_id) === String(branchId)
    && ((Number(r.hourly_rate) || 0) > 0 || (Number(r.global_salary) || 0) > 0));
}

const placementKey = (e) => `${e.employee_id}|${e.date}|${e.start_hhmm || ''}|${e.end_hhmm || ''}`;

/** One person, two branches, the same minutes — refused. Back-to-back is the normal switch. */
function crossOverlaps(entries, otherEntries) {
  const out = [];
  for (const e of entries) {
    const s = mins(e.start_hhmm); const t = mins(e.end_hhmm);
    if (s === null || t === null) continue;
    const hit = otherEntries.find(o => String(o.employee_id) === String(e.employee_id) && o.date === e.date
      && mins(o.start_hhmm) !== null && mins(o.end_hhmm) !== null && s < mins(o.end_hhmm) && mins(o.start_hhmm) < t);
    if (hit) out.push({ employee_id: String(e.employee_id), employee_name: e.employee_name, date: e.date, other_branch_id: String(hit.branch_id) });
  }
  return out;
}

function arrangementCovers(arr, entry) {
  return String(arr.employee_id) === String(entry.employee_id)
    && arr.weekday === weekdayOf(entry.date)
    && arr.start_hhmm === entry.start_hhmm && arr.end_hhmm === entry.end_hhmm;
}

/** Her day in the rota as one span, at the branch she starts in. */
function rotaDay(entries, date) {
  const day = entries.filter(e => e.date === date && mins(e.start_hhmm) !== null && mins(e.end_hhmm) !== null)
    .sort((a, b) => mins(a.start_hhmm) - mins(b.start_hhmm));
  if (!day.length) return null;
  const end = day.reduce((m, e) => (mins(e.end_hhmm) > mins(m) ? e.end_hhmm : m), day[0].end_hhmm);
  return { in: day[0].start_hhmm, out: end, branch_id: day[0].branch_id ? String(day[0].branch_id) : null };
}

function lateness(firstPunch, scheduledStart, threshold = 30) {
  if (mins(scheduledStart) === null) return null;
  if (!firstPunch) return { kind: 'absent' };
  const diff = mins(firstPunch) - mins(scheduledStart);
  return diff > threshold ? { kind: 'late', minutes: diff } : null;
}

module.exports = { hasBranchRate, placementKey, crossOverlaps, arrangementCovers, rotaDay, lateness };
```

- [ ] **Step 4: Run, expect `all passed`. Step 5: register + commit** `feat(cross-branch): pure rules — rate eligibility, overlaps, arrangements, rota day, lateness`.

---

### Task 2: Models + rate requests + cross-branch service

**Files:** Create `server/src/models/BranchRateRequest.js`, `server/src/models/CrossBranchArrangement.js`, `server/src/services/shifts/rateRequests.service.js`, `server/src/services/shifts/crossBranch.service.js`, `server/scripts/cross-branch-service.test.js`. Modify `server/src/models/ShiftWeek.js` (entry fields), `server/src/models/index.js`, `server/src/models/NotificationEvent.js`, `server/package.json` (`"test:cross-branch-service"`).

**Interfaces — Produces:**
- `rateRequests.service.js`: `createRateRequest({ user, employeeId, hostBranchId, proposedRate })`, `decideRateRequest({ user, id, approve, reason, finalRate })`, `listRateRequests({ user })` → `[{...request, employee_name, home_branch_name, host_branch_name, can_decide}]`.
- `crossBranch.service.js`: `foreignCandidates({ hostBranchId })` → `[{ _id, full_name, branch_id, branch_name, has_rate }]`; `activeArrangements({ hostBranchId, employeeIds })`; `otherBranchEntries({ weekStart, employeeIds, excludeBranchId })` → entries with `branch_id`, `branch_name`, `cross_status`, `week_id`; `decidePlacement({ user, weekId, entryId, approve, reason })`; `maybeProposeArrangement({ week, entry })`; `confirmArrangement({ user, id })`; `cancelArrangement({ user, id })`; `arrangementsFor({ user, branchId })` (proposed/active where she is host or home manager); `homePending({ branchId })` → pending cross entries of her employees in other branches' weeks.

- [ ] **Step 1: Models**

`ShiftWeek.js` entrySchema — add after `new_class`:
```js
  // An employee of another branch (phase 3). Server-derived on every save.
  cross_branch: { type: Boolean, default: false },
  cross_status: { type: String, enum: ['pending', 'approved', null], default: null },
```

`server/src/models/BranchRateRequest.js`:
```js
const mongoose = require('mongoose');

/**
 * A rate for an employee to work at a branch that is not hers.
 *
 * Her own manager answers first (it is her person being lent out), then the
 * office sets the money. Only then can the host manager place her.
 */
const branchRateRequestSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  home_branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  host_branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  proposed_rate: { type: Number, default: null },
  final_rate: { type: Number, default: null },
  status: { type: String, enum: ['pending_home', 'pending_office', 'approved', 'rejected'], default: 'pending_home', index: true },
  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requested_by_name: { type: String, default: '' },
  home_decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  office_decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reject_reason: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('BranchRateRequest', branchRateRequestSchema);
```

`server/src/models/CrossBranchArrangement.js`:
```js
const mongoose = require('mongoose');

/**
 * "She is with us every Monday 13:00–17:00" — agreed by both managers, so
 * those placements stop asking for approval every week.
 */
const crossBranchArrangementSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  employee_name: { type: String, default: '' },
  home_branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  host_branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  weekday: { type: Number, min: 0, max: 6, required: true },
  start_hhmm: { type: String, required: true },
  end_hhmm: { type: String, required: true },
  status: { type: String, enum: ['proposed', 'active', 'cancelled'], default: 'proposed', index: true },
  host_confirmed: { type: Boolean, default: false },
  home_confirmed: { type: Boolean, default: false },
  cancelled_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('CrossBranchArrangement', crossBranchArrangementSchema);
```

Register both in `models/index.js`. NotificationEvent enum, after the constraints line:
```js
      // סניפים אחרים (docs/superpowers/specs/2026-10-04-shifts-phase3-crossbranch-design.md).
      'rate_request', 'rate_request_decision', 'cross_placement_request', 'cross_placement_decision',
      'cross_arrangement', 'shift_attendance_report', 'shift_attendance_report_office',
```

- [ ] **Step 2: Failing test** — `server/scripts/cross-branch-service.test.js`

```js
#!/usr/bin/env node
/**
 * Rate requests and cross-branch placements against an in-memory database.
 *
 *   node scripts/cross-branch-service.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const eq = (a, b, l) => {
  const g = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${g ? '✅' : '❌'} ${l}${g ? '' : ` (${JSON.stringify(a)} ≠ ${JSON.stringify(b)})`}`);
  if (!g) failures++;
};
async function throws(fn, status, message, label) {
  try { await fn(); eq('no throw', status, label); } catch (e) { eq([e.status, message ? e.message : undefined], [status, message], label); }
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const M = require('../src/models');
  const rates = require('../src/services/shifts/rateRequests.service');
  const cross = require('../src/services/shifts/crossBranch.service');

  const home = await M.Branch.create({ name: 'כפר סבא - קפלן' });
  const host = await M.Branch.create({ name: 'כפר סבא - משה דיין' });
  let idn = 300000000;
  const mkUser = (role, extra = {}) => M.User.create({ full_name: role, id_number: String(idn++), email: `${idn}@x.l`, password_hash: 'x', role, is_active: true, ...extra });
  const homeMgrU = await mkUser('branch_manager', { managed_branch_ids: [home._id], branch_id: home._id });
  const hostMgrU = await mkUser('branch_manager', { managed_branch_ids: [host._id], branch_id: host._id });
  const accU = await mkUser('accountant');
  const as = (u) => ({ id: String(u._id), role: u.role, managed_branch_ids: (u.managed_branch_ids || []).map(String), branch_id: u.branch_id ? String(u.branch_id) : null, full_name: u.full_name });
  const homeMgr = as(homeMgrU); const hostMgr = as(hostMgrU); const acc = as(accU);
  const dana = await M.Employee.create({ full_name: 'דנה', israeli_id: String(idn++), branch_id: home._id, is_active: true });

  console.log('\nבקשת תעריף');
  await throws(() => rates.createRateRequest({ user: homeMgr, employeeId: String(dana._id), hostBranchId: String(host._id), proposedRate: 50 }), 403, 'רק מנהלת הסניף המארח מבקשת תעריף', 'רק המארחת מבקשת');
  const rr = await rates.createRateRequest({ user: hostMgr, employeeId: String(dana._id), hostBranchId: String(host._id), proposedRate: 50 });
  eq(rr.status, 'pending_home', 'ממתין למנהלת סניף הבית');
  eq(await M.NotificationEvent.countDocuments({ type: 'rate_request', recipient_id: homeMgrU._id }), 1, 'מנהלת הבית קיבלה התראה');
  await throws(() => rates.createRateRequest({ user: hostMgr, employeeId: String(dana._id), hostBranchId: String(host._id), proposedRate: 50 }), 409, 'כבר יש בקשת תעריף פתוחה לעובדת הזו', 'בקשה כפולה');
  await throws(() => rates.decideRateRequest({ user: hostMgr, id: String(rr._id), approve: true }), 403, 'אין הרשאה להחליט בשלב הזה', 'המארחת לא מאשרת שלב בית');
  await throws(() => rates.decideRateRequest({ user: homeMgr, id: String(rr._id), approve: false, reason: '' }), 400, 'יש לכתוב סיבה לדחייה', 'דחייה בלי סיבה');
  const step2 = await rates.decideRateRequest({ user: homeMgr, id: String(rr._id), approve: true });
  eq(step2.status, 'pending_office', 'עבר למשרד');
  const list = await rates.listRateRequests({ user: acc });
  eq(list.map(r => [r.employee_name, r.can_decide]), [['דנה', true]], 'המשרד רואה את הבקשה ויכול להחליט');
  await throws(() => rates.decideRateRequest({ user: acc, id: String(rr._id), approve: true, finalRate: 0 }), 400, 'יש להזין תעריף לשעה', 'תעריף אפס');
  const done = await rates.decideRateRequest({ user: acc, id: String(rr._id), approve: true, finalRate: 48 });
  eq(done.status, 'approved', 'אושר');
  const d2 = await M.Employee.findById(dana._id).lean();
  eq(d2.branch_rates.map(r => [String(r.branch_id), r.hourly_rate]), [[String(host._id), 48]], 'התעריף נכתב לכרטיס העובדת');
  eq(await M.NotificationEvent.countDocuments({ type: 'rate_request_decision', recipient_id: hostMgrU._id }), 1, 'המבקשת עודכנה');
  eq((await rates.listRateRequests({ user: acc })).length, 0, 'אחרי אישור — יורדת מהרשימה');

  console.log('\nמועמדות מסניפים אחרים');
  const cands = await cross.foreignCandidates({ hostBranchId: String(host._id) });
  eq(cands.map(c => [c.full_name, c.has_rate, c.branch_name]), [['דנה', true, 'כפר סבא - קפלן']], 'דנה עם תעריף');

  console.log('\nשיבוץ מסניף אחר ואישור');
  const ShiftWeek = M.ShiftWeek;
  const mkWeek = (ws, entries, published = true) => ShiftWeek.create({ branch_id: host._id, week_start: ws, entries, published: published ? entries : [], published_at: published ? new Date() : null });
  const entry = (date) => ({ employee_id: dana._id, employee_name: 'דנה', date, area: 'floater', start_hhmm: '13:00', end_hhmm: '17:00', cross_branch: true, cross_status: 'approved' });
  await mkWeek('2026-09-27', [entry('2026-09-28')]);
  await mkWeek('2026-10-04', [entry('2026-10-05')]);
  const w3 = await mkWeek('2026-10-11', [{ ...entry('2026-10-12'), cross_status: 'pending' }], false);
  const pendingForHome = await cross.homePending({ branchId: String(home._id) });
  eq(pendingForHome.map(p => [p.date, p.branch_name]), [['2026-10-12', 'כפר סבא - משה דיין']], 'מנהלת הבית רואה מה ממתין לה');
  await throws(() => cross.decidePlacement({ user: hostMgr, weekId: String(w3._id), entryId: String(w3.entries[0]._id), approve: true }), 403, 'רק מנהלת סניף הבית של העובדת מאשרת', 'המארחת לא מאשרת');
  await cross.decidePlacement({ user: homeMgr, weekId: String(w3._id), entryId: String(w3.entries[0]._id), approve: true });
  eq((await ShiftWeek.findById(w3._id)).entries[0].cross_status, 'approved', 'אושר');
  const arr = await M.CrossBranchArrangement.findOne({ employee_id: dana._id }).lean();
  eq([arr && arr.status, arr && arr.weekday, arr && arr.start_hhmm], ['proposed', 1, '13:00'], 'אחרי שלוש פעמים — הוצע סידור קבוע');
  eq(await M.NotificationEvent.countDocuments({ type: 'cross_arrangement' }), 2, 'שתי המנהלות נשאלו');
  await cross.confirmArrangement({ user: hostMgr, id: String(arr._id) });
  eq((await M.CrossBranchArrangement.findById(arr._id)).status, 'proposed', 'אחרי אישור אחת — עדיין מוצע');
  await cross.confirmArrangement({ user: homeMgr, id: String(arr._id) });
  eq((await M.CrossBranchArrangement.findById(arr._id)).status, 'active', 'שתיהן אישרו — פעיל');
  const act = await cross.activeArrangements({ hostBranchId: String(host._id), employeeIds: [String(dana._id)] });
  eq(act.length, 1, 'סידור פעיל זמין לשיבוץ אוטומטי');
  await cross.cancelArrangement({ user: homeMgr, id: String(arr._id) });
  eq((await M.CrossBranchArrangement.findById(arr._id)).status, 'cancelled', 'כל אחת מבטלת לבד');

  console.log('\nדחיית שיבוץ');
  const w4 = await mkWeek('2026-10-18', [{ ...entry('2026-10-20'), cross_status: 'pending' }], false);
  await throws(() => cross.decidePlacement({ user: homeMgr, weekId: String(w4._id), entryId: String(w4.entries[0]._id), approve: false, reason: '' }), 400, 'יש לכתוב סיבה לדחייה', 'דחייה בלי סיבה');
  await cross.decidePlacement({ user: homeMgr, weekId: String(w4._id), entryId: String(w4.entries[0]._id), approve: false, reason: 'צריכה אותה אצלי' });
  eq((await ShiftWeek.findById(w4._id)).entries.length, 0, 'השיבוץ הוסר מהסידור המארח');
  eq(await M.NotificationEvent.countDocuments({ type: 'cross_placement_decision', recipient_id: hostMgrU._id, ref_id: w4._id }), 1, 'המארחת עודכנה עם הסיבה');

  console.log('\nשיבוצים בסניפים אחרים');
  const others = await cross.otherBranchEntries({ weekStart: '2026-10-11', employeeIds: [String(dana._id)], excludeBranchId: String(home._id) });
  eq(others.map(o => [o.date, o.branch_name, o.cross_status]), [['2026-10-12', 'כפר סבא - משה דיין', 'approved']], 'מנהלת הבית רואה את דנה במשה דיין');

  await new Promise(r => setTimeout(r, 300));
  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run, expect `Cannot find module`.**

- [ ] **Step 4: Implement `rateRequests.service.js`**

```js
/**
 * Branch-rate requests: host asks, home manager agrees, office sets the money.
 */
const mongoose = require('mongoose');
const { BranchRateRequest, Employee, Branch, User } = require('../../models');
const notificationService = require('../notification.service');
const { branchManagerFilter } = require('../branch-recipients.service');
const { ShiftError, canEdit } = require('./access');

const OFFICE = ['system_admin', 'accountant'];

async function managersOf(branchId) {
  return (await User.find({ ...branchManagerFilter(branchId), role: 'branch_manager' }).select('_id').lean()).map(u => u._id);
}
async function officeIds() {
  return (await User.find({ role: { $in: OFFICE }, is_active: { $ne: false } }).select('_id').lean()).map(u => u._id);
}
const notify = (ids, payload) => Promise.all(ids.map(recipient_id => notificationService.notifyOnce({ ...payload, recipient_id })
  .catch(err => console.error('[rate-requests] notify failed:', err.message))));

async function loadOr404(id) {
  if (!mongoose.isValidObjectId(id)) throw new ShiftError(404, 'בקשה לא נמצאה');
  const r = await BranchRateRequest.findById(id);
  if (!r) throw new ShiftError(404, 'בקשה לא נמצאה');
  return r;
}

async function createRateRequest({ user, employeeId, hostBranchId, proposedRate }) {
  if (!canEdit(user, hostBranchId)) throw new ShiftError(403, 'רק מנהלת הסניף המארח מבקשת תעריף');
  if (!mongoose.isValidObjectId(employeeId)) throw new ShiftError(404, 'עובדת לא נמצאה');
  const emp = await Employee.findOne({ _id: employeeId, is_active: true }).lean();
  if (!emp) throw new ShiftError(404, 'עובדת לא נמצאה');
  if (String(emp.branch_id) === String(hostBranchId)) throw new ShiftError(400, 'העובדת כבר שייכת לסניף הזה');
  if (await BranchRateRequest.exists({ employee_id: emp._id, host_branch_id: hostBranchId, status: { $in: ['pending_home', 'pending_office'] } })) {
    throw new ShiftError(409, 'כבר יש בקשת תעריף פתוחה לעובדת הזו');
  }
  const rate = Number(proposedRate);
  const r = await BranchRateRequest.create({
    employee_id: emp._id, home_branch_id: emp.branch_id, host_branch_id: hostBranchId,
    proposed_rate: rate > 0 ? rate : null, requested_by: user.id, requested_by_name: user.full_name || '',
  });
  const hostName = (await Branch.findById(hostBranchId).select('name').lean())?.name || '';
  await notify(await managersOf(emp.branch_id), {
    type: 'rate_request', ref_collection: 'BranchRateRequest', ref_id: r._id,
    title: `בקשה לשבץ את ${emp.full_name} ב${hostName}`, body: 'נדרש אישור שלך לפני שהמשרד קובע תעריף', url: '/shifts',
  });
  return r;
}

async function decideRateRequest({ user, id, approve, reason, finalRate }) {
  const r = await loadOr404(id);
  const atHome = r.status === 'pending_home';
  const atOffice = r.status === 'pending_office';
  if (!atHome && !atOffice) throw new ShiftError(409, 'הבקשה כבר טופלה');
  if ((atHome && !canEdit(user, r.home_branch_id)) || (atOffice && !OFFICE.includes(user.role))) throw new ShiftError(403, 'אין הרשאה להחליט בשלב הזה');
  const emp = await Employee.findById(r.employee_id);
  if (!approve) {
    const why = String(reason || '').trim();
    if (!why) throw new ShiftError(400, 'יש לכתוב סיבה לדחייה');
    r.status = 'rejected'; r.reject_reason = why.slice(0, 500);
    if (atHome) r.home_decided_by = user.id; else r.office_decided_by = user.id;
    await r.save();
    await notify([r.requested_by], {
      type: 'rate_request_decision', ref_collection: 'BranchRateRequest', ref_id: r._id,
      title: `בקשת התעריף ל${emp ? emp.full_name : 'עובדת'} נדחתה`, body: r.reject_reason, url: '/shifts',
    });
    return r;
  }
  if (atHome) {
    r.status = 'pending_office'; r.home_decided_by = user.id;
    await r.save();
    await notify(await officeIds(), {
      type: 'rate_request', ref_collection: 'BranchRateRequest', ref_id: r._id,
      title: `תעריף לסניף אחר — ${emp ? emp.full_name : ''}`, body: r.proposed_rate ? `הוצע ${r.proposed_rate} ₪ לשעה` : 'יש לקבוע תעריף לשעה', url: '/shifts',
    });
    return r;
  }
  const rate = Number(finalRate ?? r.proposed_rate);
  if (!(rate > 0)) throw new ShiftError(400, 'יש להזין תעריף לשעה');
  const rows = emp.branch_rates || [];
  const row = rows.find(x => String(x.branch_id) === String(r.host_branch_id));
  if (row) row.hourly_rate = rate; else rows.push({ branch_id: r.host_branch_id, hourly_rate: rate });
  emp.branch_rates = rows;
  await emp.save();
  r.status = 'approved'; r.final_rate = rate; r.office_decided_by = user.id;
  await r.save();
  await notify([r.requested_by], {
    type: 'rate_request_decision', ref_collection: 'BranchRateRequest', ref_id: r._id,
    title: `נקבע תעריף ל${emp.full_name}`, body: `${rate} ₪ לשעה — אפשר לשבץ אותה`, url: '/shifts',
  });
  return r;
}

async function listRateRequests({ user }) {
  const isOffice = OFFICE.includes(user.role);
  const managed = (user.managed_branch_ids && user.managed_branch_ids.length ? user.managed_branch_ids : [user.branch_id]).filter(Boolean).map(String);
  const filter = isOffice ? { status: { $in: ['pending_home', 'pending_office'] } }
    : { status: { $in: ['pending_home', 'pending_office'] }, $or: [{ home_branch_id: { $in: managed } }, { host_branch_id: { $in: managed } }] };
  const list = await BranchRateRequest.find(filter).sort({ created_at: -1 }).lean();
  const emps = new Map((await Employee.find({ _id: { $in: list.map(r => r.employee_id) } }).select('full_name').lean()).map(e => [String(e._id), e.full_name]));
  const branches = new Map((await Branch.find({ _id: { $in: list.flatMap(r => [r.home_branch_id, r.host_branch_id]) } }).select('name').lean()).map(b => [String(b._id), b.name]));
  return list.map(r => ({
    ...r,
    employee_name: emps.get(String(r.employee_id)) || '',
    home_branch_name: branches.get(String(r.home_branch_id)) || '',
    host_branch_name: branches.get(String(r.host_branch_id)) || '',
    can_decide: (r.status === 'pending_home' && canEdit(user, r.home_branch_id)) || (r.status === 'pending_office' && isOffice),
  }));
}

module.exports = { createRateRequest, decideRateRequest, listRateRequests };
```

- [ ] **Step 5: Implement `crossBranch.service.js`**

```js
/**
 * Placements of employees in branches that are not theirs: who may be
 * placed, what her own manager must approve, and the permanent arrangements
 * that end the weekly asking.
 */
const mongoose = require('mongoose');
const { ShiftWeek, Employee, Branch, User, CrossBranchArrangement } = require('../../models');
const notificationService = require('../notification.service');
const { branchManagerFilter } = require('../branch-recipients.service');
const { weekdayOf } = require('../fixedSchedule');
const { ShiftError, canEdit } = require('./access');
const { hasBranchRate } = require('./crossRules');

const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function managersOf(branchId) {
  return (await User.find({ ...branchManagerFilter(branchId), role: 'branch_manager' }).select('_id').lean()).map(u => u._id);
}
const notify = (ids, payload) => Promise.all(ids.map(recipient_id => notificationService.notifyOnce({ ...payload, recipient_id })
  .catch(err => console.error('[cross-branch] notify failed:', err.message))));
async function branchNames(ids) {
  return new Map((await Branch.find({ _id: { $in: ids } }).select('name').lean()).map(b => [String(b._id), b.name]));
}

async function foreignCandidates({ hostBranchId }) {
  const emps = await Employee.find({ is_active: true, branch_id: { $ne: hostBranchId } }).select('full_name branch_id branch_rates').sort({ full_name: 1 }).lean();
  const names = await branchNames([...new Set(emps.map(e => String(e.branch_id)))]);
  return emps.map(e => ({ _id: String(e._id), full_name: e.full_name, branch_id: String(e.branch_id), branch_name: names.get(String(e.branch_id)) || '', has_rate: hasBranchRate(e, hostBranchId) }));
}

async function activeArrangements({ hostBranchId, employeeIds }) {
  return CrossBranchArrangement.find({ host_branch_id: hostBranchId, employee_id: { $in: employeeIds }, status: 'active' }).lean();
}

/** Her entries in every other branch's week — for overlap checks and the home manager's view. */
async function otherBranchEntries({ weekStart, employeeIds, excludeBranchId }) {
  if (!employeeIds.length) return [];
  const weeks = await ShiftWeek.find({ week_start: weekStart, branch_id: { $ne: excludeBranchId }, 'entries.employee_id': { $in: employeeIds } }).lean();
  const names = await branchNames(weeks.map(w => w.branch_id));
  const ids = new Set(employeeIds.map(String));
  return weeks.flatMap(w => w.entries.filter(e => ids.has(String(e.employee_id))).map(e => ({
    ...e, _id: String(e._id), employee_id: String(e.employee_id), branch_id: String(w.branch_id), branch_name: names.get(String(w.branch_id)) || '', week_id: String(w._id),
  })));
}

async function homePending({ branchId }) {
  const mine = (await Employee.find({ branch_id: branchId }).select('_id').lean()).map(e => e._id);
  const weeks = await ShiftWeek.find({ branch_id: { $ne: branchId }, entries: { $elemMatch: { employee_id: { $in: mine }, cross_status: 'pending' } } }).lean();
  const names = await branchNames(weeks.map(w => w.branch_id));
  const set = new Set(mine.map(String));
  return weeks.flatMap(w => w.entries.filter(e => set.has(String(e.employee_id)) && e.cross_status === 'pending').map(e => ({
    ...e, _id: String(e._id), week_id: String(w._id), branch_id: String(w.branch_id), branch_name: names.get(String(w.branch_id)) || '',
  })));
}

/** Two earlier consecutive host weeks with the same approved placement → propose a permanent arrangement. */
async function maybeProposeArrangement({ week, entry }) {
  const weekday = weekdayOf(entry.date);
  const exists = await CrossBranchArrangement.exists({ employee_id: entry.employee_id, host_branch_id: week.branch_id, weekday, start_hhmm: entry.start_hhmm, end_hhmm: entry.end_hhmm, status: { $in: ['proposed', 'active'] } });
  if (exists) return null;
  for (const back of [7, 14]) {
    const date = addDays(entry.date, -back);
    const prev = await ShiftWeek.findOne({ branch_id: week.branch_id, week_start: addDays(week.week_start, -back) }).lean();
    const hit = prev && (prev.published || []).some(e => String(e.employee_id) === String(entry.employee_id) && e.date === date
      && e.start_hhmm === entry.start_hhmm && e.end_hhmm === entry.end_hhmm && e.cross_status === 'approved');
    if (!hit) return null;
  }
  const emp = await Employee.findById(entry.employee_id).select('full_name branch_id').lean();
  const arr = await CrossBranchArrangement.create({
    employee_id: entry.employee_id, employee_name: emp ? emp.full_name : '', home_branch_id: emp.branch_id, host_branch_id: week.branch_id,
    weekday, start_hhmm: entry.start_hhmm, end_hhmm: entry.end_hhmm,
  });
  const ids = [...await managersOf(week.branch_id), ...await managersOf(emp.branch_id)];
  await notify(ids, {
    type: 'cross_arrangement', ref_collection: 'CrossBranchArrangement', ref_id: arr._id,
    title: `${arr.employee_name} — סידור קבוע?`, body: `שובצה 3 שבועות ברצף באותו יום ובאותן שעות (${arr.start_hhmm}–${arr.end_hhmm}). לאשר כסידור קבוע?`, url: '/shifts',
  });
  return arr;
}

async function decidePlacement({ user, weekId, entryId, approve, reason }) {
  if (!mongoose.isValidObjectId(weekId)) throw new ShiftError(404, 'סידור לא נמצא');
  const week = await ShiftWeek.findById(weekId);
  if (!week) throw new ShiftError(404, 'סידור לא נמצא');
  const entry = week.entries.id(entryId);
  if (!entry || !entry.cross_branch) throw new ShiftError(404, 'שיבוץ לא נמצא');
  const emp = await Employee.findById(entry.employee_id).select('full_name branch_id').lean();
  if (!emp || !canEdit(user, emp.branch_id)) throw new ShiftError(403, 'רק מנהלת סניף הבית של העובדת מאשרת');
  if (entry.cross_status !== 'pending') throw new ShiftError(409, 'השיבוץ כבר טופל');
  if (!approve) {
    const why = String(reason || '').trim();
    if (!why) throw new ShiftError(400, 'יש לכתוב סיבה לדחייה');
    entry.deleteOne();
    await week.save();
    await notify(await managersOf(week.branch_id), {
      type: 'cross_placement_decision', ref_collection: 'ShiftWeek', ref_id: week._id,
      title: `השיבוץ של ${emp.full_name} ב-${entry.date} לא אושר`, body: why, url: `/shifts?week=${week.week_start}`,
    });
    return { approved: false };
  }
  entry.cross_status = 'approved';
  await week.save();
  await notify(await managersOf(week.branch_id), {
    type: 'cross_placement_decision', ref_collection: 'ShiftWeek', ref_id: week._id,
    title: `השיבוץ של ${emp.full_name} ב-${entry.date} אושר`, body: '', url: `/shifts?week=${week.week_start}`,
  });
  await maybeProposeArrangement({ week, entry: entry.toObject() });
  return { approved: true };
}

async function loadArr(id) {
  if (!mongoose.isValidObjectId(id)) throw new ShiftError(404, 'סידור קבוע לא נמצא');
  const a = await CrossBranchArrangement.findById(id);
  if (!a) throw new ShiftError(404, 'סידור קבוע לא נמצא');
  return a;
}

async function confirmArrangement({ user, id }) {
  const a = await loadArr(id);
  if (a.status !== 'proposed') throw new ShiftError(409, 'הסידור כבר לא ממתין לאישור');
  const isHost = canEdit(user, a.host_branch_id); const isHome = canEdit(user, a.home_branch_id);
  if (!isHost && !isHome) throw new ShiftError(403, 'רק אחת משתי המנהלות מאשרת');
  if (isHost) a.host_confirmed = true;
  if (isHome) a.home_confirmed = true;
  if (a.host_confirmed && a.home_confirmed) a.status = 'active';
  await a.save();
  return a;
}

async function cancelArrangement({ user, id }) {
  const a = await loadArr(id);
  if (a.status === 'cancelled') throw new ShiftError(409, 'הסידור כבר בוטל');
  if (!canEdit(user, a.host_branch_id) && !canEdit(user, a.home_branch_id)) throw new ShiftError(403, 'רק אחת משתי המנהלות מבטלת');
  a.status = 'cancelled'; a.cancelled_by = user.id;
  await a.save();
  const ids = [...await managersOf(a.host_branch_id), ...await managersOf(a.home_branch_id)];
  await notify(ids, {
    type: 'cross_arrangement', ref_collection: 'CrossBranchArrangement', ref_id: a._id,
    title: `הסידור הקבוע של ${a.employee_name} בוטל`, body: 'משבוע הבא כל שיבוץ שלה שוב דורש אישור', url: '/shifts',
  });
  return a;
}

async function arrangementsFor({ user, branchId }) {
  const list = await CrossBranchArrangement.find({ status: { $in: ['proposed', 'active'] }, $or: [{ host_branch_id: branchId }, { home_branch_id: branchId }] }).lean();
  const names = await branchNames(list.flatMap(a => [a.host_branch_id, a.home_branch_id]));
  return list.map(a => ({
    ...a, host_branch_name: names.get(String(a.host_branch_id)) || '', home_branch_name: names.get(String(a.home_branch_id)) || '',
    can_confirm: a.status === 'proposed' && ((canEdit(user, a.host_branch_id) && !a.host_confirmed) || (canEdit(user, a.home_branch_id) && !a.home_confirmed)),
    can_cancel: canEdit(user, a.host_branch_id) || canEdit(user, a.home_branch_id),
  }));
}

module.exports = {
  foreignCandidates, activeArrangements, otherBranchEntries, homePending, maybeProposeArrangement,
  decidePlacement, confirmArrangement, cancelArrangement, arrangementsFor, managersOf,
};
```

- [ ] **Step 6: Run** `node scripts/cross-branch-service.test.js` → all ✅; also `node scripts/shifts-service.test.js` (model change must not break it).
- [ ] **Step 7: Register, commit** `feat(cross-branch): rate requests, placement approval, permanent arrangements`.

---

### Task 3: Rota service — foreign placements, cross overlaps, publish guard, board fields

**Files:** Modify `server/src/services/shifts/shiftWeek.service.js`, `server/scripts/shifts-service.test.js`.

**Interfaces — Consumes:** Task 1 (`hasBranchRate`, `placementKey`, `crossOverlaps`, `arrangementCovers`), Task 2 (`activeArrangements`, `otherBranchEntries`, `homePending`, `arrangementsFor`, `foreignCandidates`, `managersOf`). **Produces:** `getBoard` adds `foreign_candidates`, `away` (her employees' entries in other branches this week), `cross_pending` (`homePending` for this branch), `arrangements` (`arrangementsFor`), `rate_requests` (from `rateRequests.listRateRequests` filtered to this branch as home or host — office sees all). `prepareEntries` accepts foreign employees with a rate, derives `cross_branch`/`cross_status`, refuses cross-branch overlaps for every entry. `applyEntries` notifies home managers about newly pending placements. `publishWeek` refuses while pending cross entries exist (check right after the window check).

- [ ] **Step 1: Failing tests** — append to `server/scripts/shifts-service.test.js` before the disconnect (reuse `M`, `svc`, `manager`, `branch`, `other`, `dana`, `throwsStatus`; read the file and adapt names):

```js
  console.log('\nסניפים אחרים בסידור');
  const otherMgrU = await M.User.create({ full_name: 'מנהלת הרצליה', id_number: '777000001', email: 'om@x.l', password_hash: 'x', role: 'branch_manager', is_active: true, managed_branch_ids: [other._id], branch_id: other._id });
  const otherMgr = { id: String(otherMgrU._id), role: 'branch_manager', managed_branch_ids: [String(other._id)], full_name: 'מנהלת הרצליה' };
  const guest = await M.Employee.create({ full_name: 'אורחת', israeli_id: '777000002', branch_id: other._id, is_active: true });
  const WK = '2026-11-01';
  const wkX = await svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: WK });
  const baseX = wkX.entries.map(e => e.toObject());
  const guestEntry = { employee_id: guest._id, date: '2026-11-02', area: 'floater', start_hhmm: '13:00', end_hhmm: '17:00' };
  await throwsStatus(() => svc.saveEntries({ user: manager, weekId: String(wkX._id), entries: [...baseX, guestEntry] }), 400, 'עובדת מסניף אחר בלי תעריף — נדחית');
  await M.Employee.updateOne({ _id: guest._id }, { $set: { branch_rates: [{ branch_id: branch._id, hourly_rate: 50 }] } });
  const savedX = await svc.saveEntries({ user: manager, weekId: String(wkX._id), entries: [...baseX, guestEntry] });
  const gx = savedX.entries.find(e => String(e.employee_id) === String(guest._id));
  eq([gx.cross_branch, gx.cross_status], [true, 'pending'], 'עם תעריף — נשמר וממתין לאישור סניף הבית');
  eq(await M.NotificationEvent.countDocuments({ type: 'cross_placement_request', recipient_id: otherMgrU._id }), 1, 'מנהלת הבית קיבלה בקשה');
  await throwsStatus(() => svc.publishWeek({ user: manager, weekId: String(wkX._id), now: new Date('2026-10-29T16:00:00Z') }), 409, 'פרסום נחסם בזמן שיבוץ ממתין');
  // Home manager places her in her own branch at overlapping hours → refused.
  const wkO = await svc.createWeek({ user: otherMgr, branchId: String(other._id), weekStart: WK });
  await throwsStatus(() => svc.saveEntries({ user: otherMgr, weekId: String(wkO._id), entries: [...wkO.entries.map(e => e.toObject()), { employee_id: guest._id, date: '2026-11-02', area: 'floater', start_hhmm: '12:00', end_hhmm: '14:00' }] }), 400, 'חפיפה בין סניפים נדחית');
  const okO = await svc.saveEntries({ user: otherMgr, weekId: String(wkO._id), entries: [...wkO.entries.map(e => e.toObject()), { employee_id: guest._id, date: '2026-11-02', area: 'floater', start_hhmm: '07:00', end_hhmm: '13:00' }] });
  eq(okO.entries.some(e => String(e.employee_id) === String(guest._id)), true, 'שעות שונות באותו יום — מותר');
  const boardO = await svc.getBoard({ user: otherMgr, branchId: String(other._id), weekStart: WK });
  eq([boardO.away.length, boardO.cross_pending.length], [1, 1], 'מנהלת הבית רואה אותה בסניף האחר וממתין לה');
  const C2 = require('../src/services/shifts/crossBranch.service');
  await C2.decidePlacement({ user: otherMgr, weekId: String(wkX._id), entryId: String(gx._id), approve: true });
  const resave = await svc.saveEntries({ user: manager, weekId: String(wkX._id), entries: (await M.ShiftWeek.findById(wkX._id)).entries.map(e => e.toObject()) });
  eq(resave.entries.find(e => String(e.employee_id) === String(guest._id)).cross_status, 'approved', 'שמירה חוזרת שומרת על האישור');
  const boardX = await svc.getBoard({ user: manager, branchId: String(branch._id), weekStart: WK });
  eq(boardX.foreign_candidates.find(c => c._id === String(guest._id)).has_rate, true, 'הלוח מציע עובדות מסניפים אחרים');
```

- [ ] **Step 2: Run, expect failures.** Also update the two EXISTING assertions in `shifts-service.test.js` (~lines 186 and 193) that expect the message `'זרה לא שייכת לסניף הזה'` for a foreign employee: a foreign employee WITHOUT a rate is now refused with `` `ל${'זרה'} אין תעריף לסניף הזה — יש לשלוח בקשת תעריף` `` (i.e. `'לזרה אין תעריף לסניף הזה — יש לשלוח בקשת תעריף'`). Keep the 400 and the "her extra_classroom_ids unchanged" check.

- [ ] **Step 3: Implement in `shiftWeek.service.js`**

Requires: `const cross = require('./crossBranch.service');`, `const rateRequests = require('./rateRequests.service');`, `const { hasBranchRate, placementKey, crossOverlaps, arrangementCovers } = require('./crossRules');`. Add `branch_rates` to the `Employee.find(...).select(...)` in `prepareEntries`.

In `prepareEntries`, replace the line
`if (String(emp.branch_id) !== String(week.branch_id)) throw new ShiftError(400, \`${emp.full_name} לא שייכת לסניף הזה\`);`
with:
```js
    const foreign = String(emp.branch_id) !== String(week.branch_id);
    if (foreign && !hasBranchRate(emp, week.branch_id)) {
      throw new ShiftError(400, `ל${emp.full_name} אין תעריף לסניף הזה — יש לשלוח בקשת תעריף`, { needs_rate: String(emp._id) });
    }
    e.cross_branch = foreign;
    e.cross_status = null;
```
After the loop (before the accepted-constraints lock), add:
```js
  // Cross-branch: approval carried over, or by a permanent arrangement; otherwise pending.
  const foreignIds = [...new Set(entries.filter(e => e.cross_branch).map(e => String(e.employee_id)))];
  const approvedBefore = new Set(week.entries.filter(e => e.cross_status === 'approved').map(e => placementKey(e)));
  const arrangements = foreignIds.length ? await cross.activeArrangements({ hostBranchId: week.branch_id, employeeIds: foreignIds }) : [];
  for (const e of entries) {
    if (!e.cross_branch) continue;
    e.cross_status = (approvedBefore.has(placementKey(e)) || arrangements.some(a => arrangementCovers(a, e))) ? 'approved' : 'pending';
  }
  // Nobody in two branches at once.
  const allIds = [...new Set(entries.map(e => String(e.employee_id)))];
  const elsewhere = await cross.otherBranchEntries({ weekStart: week.week_start, employeeIds: allIds, excludeBranchId: week.branch_id });
  const clash = crossOverlaps(entries, elsewhere);
  if (clash.length) {
    const c = clash[0];
    const where = elsewhere.find(o => o.branch_id === c.other_branch_id);
    throw new ShiftError(400, `${c.employee_name} משובצת באותן שעות בסניף ${where ? where.branch_name : 'אחר'} ב-${c.date}`);
  }
```
In `normalizeEntries`, carry through nothing new (cross fields are derived). In `applyEntries`, after `await week.save();` add:
```js
  const newlyPending = week.entries.filter(e => e.cross_status === 'pending' && !prevPendingKeys.has(placementKey(e)));
  if (newlyPending.length) {
    const homes = await Employee.find({ _id: { $in: newlyPending.map(e => e.employee_id) } }).select('branch_id full_name').lean();
    for (const h of homes) {
      const ids = await cross.managersOf(h.branch_id);
      await Promise.all(ids.map(recipient_id => notificationService.notifyOnce({
        type: 'cross_placement_request', ref_collection: 'ShiftWeek', ref_id: week._id, recipient_id,
        title: `${h.full_name} שובצה בסניף אחר`, body: 'נדרש אישור שלך לשיבוץ', url: '/shifts',
      }).catch(err => console.error('[shifts] notify failed:', err.message))));
    }
  }
```
with `const prevPendingKeys = new Set(week.entries.filter(e => e.cross_status === 'pending').map(e => placementKey(e)));` captured at the top of `applyEntries` before entries are replaced.

In `publishWeek`, right after the submission-window check:
```js
  if (week.entries.some(e => e.cross_status === 'pending')) {
    throw new ShiftError(409, 'יש שיבוצים מסניף אחר שממתינים לאישור מנהלת סניף הבית');
  }
```

In `getBoard`, before `return {`:
```js
  const branchEmployeeIds = employees.map(e => String(e._id));
  const [foreignCandidates, away, crossPending, arrangements, allRateRequests] = await Promise.all([
    cross.foreignCandidates({ hostBranchId: branchId }),
    cross.otherBranchEntries({ weekStart, employeeIds: branchEmployeeIds, excludeBranchId: branchId }),
    cross.homePending({ branchId }),
    cross.arrangementsFor({ user, branchId }),
    rateRequests.listRateRequests({ user }),
  ]);
```
and add to the returned object: `foreign_candidates: foreignCandidates, away, cross_pending: crossPending, arrangements, rate_requests: allRateRequests.filter(r => String(r.home_branch_id) === String(branchId) || String(r.host_branch_id) === String(branchId) || ['system_admin', 'accountant'].includes(user.role)),`. Also make `employees` in the payload include foreign employees placed in this week (so EntryDialog can show their names): append `foreignCandidates.filter(c => c.has_rate)` mapped to `{ _id, full_name: \`${c.full_name} (${c.branch_name})\`, primary_classroom_id: null, extra_classroom_ids: [], foreign: true }`.

- [ ] **Step 4: Run** shifts-service, cross-branch-service, constraints-service tests — all pass.
- [ ] **Step 5: Commit** `feat(cross-branch): rota accepts rated foreign employees, blocks cross-branch double booking, waits for home approval`.

---

### Task 4: Fixed-schedule employees follow the published rota

**Files:** Modify `server/src/models/Employee.js` (exception sub-schema), `server/src/services/fixedSchedule.js`, `server/src/services/shifts/shiftWeek.service.js` (call on publish). Create `server/src/services/shifts/rotaPay.service.js`, `server/scripts/rota-pay.test.js`; register `"test:rota-pay"`.

**Interfaces — Produces:** `applyRotaToFixedSchedules({ week, closedDates, today })` → `{ employees: n, exceptions: n, punchesRemoved: n }`.

- [ ] **Step 1: Schema + generator**

`Employee.js` `fixedScheduleExceptionSchema`, add:
```js
  // 'rota' = written from a published סידור עבודה (phase 3); 'manual' = set by a person and never overwritten by the rota.
  source: { type: String, enum: ['manual', 'rota'], default: 'manual' },
  // The branch she works at that day per the rota — generated punches carry it so cross-branch rates apply.
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
```
`fixedSchedule.js` `plannedHoursFor`: when returning from an exception with hours, include `branch_id: ex.branch_id ? String(ex.branch_id) : null`. In `materializeMonth` where the IN and OUT docs are built (`branch_id: emp.branch_id`), use `branch_id: basePlanned.branch_id || emp.branch_id` (basePlanned = the pre-jitter planned object from `toCreate`). Keep everything else unchanged.

- [ ] **Step 2: Failing test** — `server/scripts/rota-pay.test.js`

```js
#!/usr/bin/env node
/**
 * A published week becomes the fixed-schedule employee's hours: rota days,
 * days off, the branch of the day; manual exceptions untouched; generated
 * punches of those days removed so they regenerate.
 *
 *   node scripts/rota-pay.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
let failures = 0;
const eq = (a, b, l) => { const g = JSON.stringify(a) === JSON.stringify(b); console.log(`  ${g ? '✅' : '❌'} ${l}${g ? '' : ` (${JSON.stringify(a)} ≠ ${JSON.stringify(b)})`}`); if (!g) failures++; };

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const M = require('../src/models');
  const { applyRotaToFixedSchedules } = require('../src/services/shifts/rotaPay.service');
  const fixedSchedule = require('../src/services/fixedSchedule');

  const home = await M.Branch.create({ name: 'כפר סבא - קפלן' });
  const host = await M.Branch.create({ name: 'כפר סבא - משה דיין' });
  const fixed = await M.Employee.create({
    full_name: 'לידור', israeli_id: '555000001', branch_id: home._id, is_active: true,
    fixed_schedule: { enabled: true, days: [0, 1, 2, 3, 4].map(weekday => ({ weekday, in: '07:00', out: '15:00' })), exceptions: [{ date: '2026-10-15', off: true, note: 'יום אישי', source: 'manual' }] },
  });
  const regular = await M.Employee.create({ full_name: 'רגילה', israeli_id: '555000002', branch_id: home._id, is_active: true });
  // Generated punches already exist for Sunday (a past day in the test's "today").
  await M.Punch.create([
    { branch_id: home._id, employee_id: fixed._id, israeli_id: '555000001', device_user_sn: 'fs-1', timestamp: fixedSchedule.ilDateTime('2026-10-11', '07:03'), timestamp_source: 'fixed_schedule', approval_status: 'approved' },
    { branch_id: home._id, employee_id: fixed._id, israeli_id: '555000001', device_user_sn: 'fs-2', timestamp: fixedSchedule.ilDateTime('2026-10-11', '15:02'), timestamp_source: 'fixed_schedule', approval_status: 'approved' },
  ]);
  const E = (emp, date, s, t, branch) => ({ employee_id: emp._id, date, start_hhmm: s, end_hhmm: t, branch_id: branch });
  const week = {
    branch_id: home._id, week_start: '2026-10-11',
    published: [E(fixed, '2026-10-11', '08:00', '14:00'), E(fixed, '2026-10-15', '07:00', '15:00'), E(regular, '2026-10-11', '07:00', '15:00')],
  };
  // Monday the 12th she works at the host branch (its own published week).
  await M.ShiftWeek.create({ branch_id: host._id, week_start: '2026-10-11', published_at: new Date(), published: [{ employee_id: fixed._id, employee_name: 'לידור', date: '2026-10-12', area: 'floater', start_hhmm: '09:00', end_hhmm: '13:00', cross_branch: true, cross_status: 'approved' }] });

  const res = await applyRotaToFixedSchedules({ week, closedDates: new Set(['2026-10-13']), today: '2026-10-12' });
  const ex = (await M.Employee.findById(fixed._id).lean()).fixed_schedule.exceptions;
  const byDate = Object.fromEntries(ex.map(e => [e.date, e]));
  eq([byDate['2026-10-11'].in, byDate['2026-10-11'].out, byDate['2026-10-11'].source], ['08:00', '14:00', 'rota'], 'ראשון: שעות הסידור');
  eq([byDate['2026-10-12'].in, String(byDate['2026-10-12'].branch_id)], ['09:00', String(host._id)], 'שני: עבדה בסניף אחר — השעות והסניף משם');
  eq(byDate['2026-10-13'], undefined, 'יום סגור — לא נכתב חריג');
  eq([byDate['2026-10-14'].off, byDate['2026-10-14'].source], [true, 'rota'], 'רביעי: לא בסידור — יום חופש');
  eq([byDate['2026-10-15'].off, byDate['2026-10-15'].source], [true, 'manual'], 'חריג ידני לא נדרס');
  eq(res.employees, 1, 'רק עובדות עם שעות קבועות');
  eq(await M.Punch.countDocuments({ employee_id: fixed._id, timestamp_source: 'fixed_schedule' }), 0, 'החתמות שנוצרו לימים האלה נמחקו כדי להיווצר מחדש');
  // Republish with a change replaces the rota exception.
  week.published[0] = E(fixed, '2026-10-11', '09:00', '14:00');
  await applyRotaToFixedSchedules({ week, closedDates: new Set(['2026-10-13']), today: '2026-10-12' });
  const ex2 = (await M.Employee.findById(fixed._id).lean()).fixed_schedule.exceptions.filter(e => e.date === '2026-10-11');
  eq([ex2.length, ex2[0].in], [1, '09:00'], 'פרסום חוזר מעדכן את אותו חריג');
  eq(fixedSchedule.plannedHoursFor({ exceptions: [{ date: '2026-10-12', in: '09:00', out: '13:00', branch_id: host._id }] }, '2026-10-12').branch_id, String(host._id), 'plannedHoursFor מחזיר את הסניף');

  await mongoose.disconnect(); await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Implement** — `server/src/services/shifts/rotaPay.service.js`

```js
/**
 * A published rota is what a fixed-schedule employee is paid for.
 *
 * Her punches are generated from her fixed hours (fixedSchedule.js). Once a
 * week is published, each of its open days becomes an exception on her fixed
 * schedule — the rota's span for that day and the branch she works at, or a
 * day off. Exceptions a person set by hand stay: they are the office's word.
 * Generated punches of those days are removed so the next materialisation
 * regenerates them from the exception (days in the future have none yet).
 */
const { Employee, ShiftWeek, Punch } = require('../../models');
const { weekDays } = require('./rules');
const { rotaDay } = require('./crossRules');
const { ilDayBounds } = require('../fixedSchedule');

async function applyRotaToFixedSchedules({ week, closedDates, today }) {
  const dates = weekDays(week.week_start);
  const fixedEmps = await Employee.find({ 'fixed_schedule.enabled': true, branch_id: week.branch_id });
  if (!fixedEmps.length) return { employees: 0, exceptions: 0, punchesRemoved: 0 };
  // Her day may be split across branches — collect her published entries in every branch this week.
  const weeks = await ShiftWeek.find({ week_start: week.week_start, branch_id: { $ne: week.branch_id }, 'published.employee_id': { $in: fixedEmps.map(e => e._id) } }).lean();
  const elsewhere = weeks.flatMap(w => (w.published || []).map(e => ({ ...e, branch_id: String(w.branch_id) })));
  let exceptions = 0; let punchesRemoved = 0;
  for (const emp of fixedEmps) {
    const own = (week.published || []).filter(e => String(e.employee_id) === String(emp._id)).map(e => ({ ...e, branch_id: e.branch_id || String(week.branch_id) }));
    const mine = [...own, ...elsewhere.filter(e => String(e.employee_id) === String(emp._id))];
    const list = emp.fixed_schedule.exceptions || [];
    const touched = [];
    for (const date of dates) {
      if (closedDates.has(date)) continue;
      const existing = list.findIndex(x => x.date === date);
      if (existing >= 0 && list[existing].source !== 'rota') continue;
      const day = rotaDay(mine, date);
      const ex = day
        ? { date, off: false, in: day.in, out: day.out, branch_id: day.branch_id, note: 'סידור עבודה', source: 'rota' }
        : { date, off: true, in: '', out: '', branch_id: null, note: 'סידור עבודה — לא משובצת', source: 'rota' };
      if (existing >= 0) list[existing] = ex; else list.push(ex);
      exceptions += 1;
      touched.push(date);
    }
    emp.fixed_schedule.exceptions = list;
    await emp.save();
    for (const date of touched.filter(d => d <= today)) {
      const { from, to } = ilDayBounds(date);
      const r = await Punch.deleteMany({ employee_id: emp._id, timestamp_source: 'fixed_schedule', schedule_edited: { $ne: true }, timestamp: { $gte: from, $lt: to } });
      punchesRemoved += r.deletedCount || 0;
    }
  }
  return { employees: fixedEmps.length, exceptions, punchesRemoved };
}

module.exports = { applyRotaToFixedSchedules };
```

In `shiftWeek.service.js` `publishWeek`, after `await week.save();` (the publish save) add:
```js
  try {
    const closed = await closedDatesFor(week.branch_id, weekDays(week.week_start), week);
    await rotaPay.applyRotaToFixedSchedules({ week: week.toObject(), closedDates: closed, today: todayIsrael() });
  } catch (err) { console.error('[shifts] rota → fixed schedule failed:', err.message); }
```
with requires `const rotaPay = require('./rotaPay.service');` and `todayIsrael` from `../fixedSchedule`.

- [ ] **Step 4: Run** `node scripts/rota-pay.test.js`, `node scripts/fixed-schedule-closure.test.js` and any other `server/scripts/fixed-schedule*.test.js`, plus shifts-service — all pass.
- [ ] **Step 5: Register, commit** `feat(cross-branch): fixed-schedule employees are paid by the published rota`.

---

### Task 5: Morning attendance-vs-rota report (service, job)

**Files:** Create `server/src/services/shifts/attendanceReport.service.js`, `server/src/services/shiftAttendanceReportJob.js`, `server/scripts/attendance-report.test.js`; modify `server/src/index.js`, `server/package.json` (`"test:attendance-report"`).

**Interfaces — Produces:** `attendanceVsRota({ branchId, date })` → `{ date, branch_id, rows: [{ employee_id, employee_name, scheduled_start, first_punch, kind: 'absent'|'late', minutes? }] }`; job `tick(now)` → `{ skipped } | { date, branches: n }`; `MARKER_KEY = 'shift_attendance_report_day'`.

- [ ] **Step 1: Failing test** — `server/scripts/attendance-report.test.js`

```js
#!/usr/bin/env node
/**
 * Yesterday's rota against yesterday's punches: absent, late > 30, fine;
 * fixed-schedule staff skipped; the 07:00 job runs once a day, never on Sunday
 * about Saturday.
 *
 *   node scripts/attendance-report.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
let failures = 0;
const eq = (a, b, l) => { const g = JSON.stringify(a) === JSON.stringify(b); console.log(`  ${g ? '✅' : '❌'} ${l}${g ? '' : ` (${JSON.stringify(a)} ≠ ${JSON.stringify(b)})`}`); if (!g) failures++; };

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const M = require('../src/models');
  const { attendanceVsRota } = require('../src/services/shifts/attendanceReport.service');
  const { tick } = require('../src/services/shiftAttendanceReportJob');
  const { ilDateTime } = require('../src/services/fixedSchedule');

  const b = await M.Branch.create({ name: 'כפר סבא - קפלן', is_active: true });
  await M.User.create({ full_name: 'מנהלת', id_number: '444000001', email: 'm@x.l', password_hash: 'x', role: 'branch_manager', is_active: true, managed_branch_ids: [b._id] });
  await M.User.create({ full_name: 'הנה״ח', id_number: '444000002', email: 'a@x.l', password_hash: 'x', role: 'accountant', is_active: true });
  const mk = (name, extra = {}) => M.Employee.create({ full_name: name, israeli_id: String(Math.floor(Math.random() * 1e9)), branch_id: b._id, is_active: true, ...extra });
  const onTime = await mk('בזמן'); const late = await mk('מאחרת'); const absent = await mk('נעדרת'); const fixed = await mk('קבועה', { fixed_schedule: { enabled: true, days: [] } });
  const D = '2026-10-12'; // Monday
  const E = (emp, s) => ({ employee_id: emp._id, employee_name: emp.full_name, date: D, area: 'floater', start_hhmm: s, end_hhmm: '15:00' });
  await M.ShiftWeek.create({ branch_id: b._id, week_start: '2026-10-11', published_at: new Date(), published: [E(onTime, '07:00'), E(late, '07:00'), E(absent, '07:30'), E(fixed, '07:00')] });
  let sn = 0;
  const punch = (emp, hhmm, extra = {}) => M.Punch.create({ branch_id: b._id, employee_id: emp._id, israeli_id: emp.israeli_id, device_user_sn: `p${sn++}`, timestamp: ilDateTime(D, hhmm), approval_status: 'auto', ...extra });
  await punch(onTime, '07:10'); await punch(late, '07:45'); await punch(absent, '07:20', { ignored: true });

  const rep = await attendanceVsRota({ branchId: String(b._id), date: D });
  eq(rep.rows.map(r => [r.employee_name, r.kind, r.minutes || null]), [['מאחרת', 'late', 45], ['נעדרת', 'absent', null]], 'איחור 45 ונעדרת (החתמה מבוטלת לא נספרת); קבועה מדולגת');

  eq((await tick(new Date('2026-10-13T03:00:00Z'))).skipped, 'not 07:00 yet', '06:00 — עוד לא');
  const r1 = await tick(new Date('2026-10-13T04:30:00Z')); // Tue 07:30 IL → about Monday
  eq([r1.date, r1.branches], [D, 1], '07:30 — דוח על אתמול');
  eq(await M.NotificationEvent.countDocuments({ type: 'shift_attendance_report' }), 1, 'מנהלת הסניף קיבלה');
  eq(await M.NotificationEvent.countDocuments({ type: 'shift_attendance_report_office' }), 1, 'המשרד קיבל סיכום');
  eq((await tick(new Date('2026-10-13T06:00:00Z'))).skipped, 'already ran', 'פעם אחת ביום');
  eq((await tick(new Date('2026-10-18T05:00:00Z'))).skipped, 'yesterday was Saturday', 'ראשון בבוקר — אין דוח על שבת');

  await new Promise(r => setTimeout(r, 300));
  await mongoose.disconnect(); await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Implement** — `server/src/services/shifts/attendanceReport.service.js`

```js
/**
 * Yesterday's published rota against yesterday's punches. Information for
 * managers and the office, nothing to approve: who was placed and never
 * punched, and who arrived more than 30 minutes after her scheduled start.
 */
const { ShiftWeek, Employee, Punch } = require('../../models');
const { weekStart } = require('../parentVisibility');
const { ilDayBounds, ISR_DAY } = require('../fixedSchedule');
const { lateness } = require('./crossRules');

const hhmmIL = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

async function attendanceVsRota({ branchId, date }) {
  const week = await ShiftWeek.findOne({ branch_id: branchId, week_start: weekStart(date), published_at: { $ne: null } }).lean();
  const out = { date, branch_id: String(branchId), rows: [] };
  if (!week) return out;
  const placed = (week.published || []).filter(e => e.date === date && e.start_hhmm);
  const ids = [...new Set(placed.map(e => String(e.employee_id)))];
  const emps = await Employee.find({ _id: { $in: ids } }).select('full_name israeli_id fixed_schedule').lean();
  const { from, to } = ilDayBounds(date);
  for (const emp of emps) {
    if (emp.fixed_schedule && emp.fixed_schedule.enabled) continue;
    const start = placed.filter(e => String(e.employee_id) === String(emp._id)).map(e => e.start_hhmm).sort()[0];
    const punches = await Punch.find({
      $or: [{ employee_id: emp._id }, { employee_id: null, israeli_id: emp.israeli_id }],
      timestamp: { $gte: from, $lt: to }, ignored: { $ne: true },
      approval_status: { $in: ['auto', 'approved'] }, timestamp_source: { $ne: 'fixed_schedule' },
    }).sort({ timestamp: 1 }).limit(1).lean();
    const first = punches.length && ISR_DAY(punches[0].timestamp) === date ? hhmmIL(punches[0].timestamp) : null;
    const verdict = lateness(first, start);
    if (verdict) out.rows.push({ employee_id: String(emp._id), employee_name: emp.full_name, scheduled_start: start, first_punch: first, ...verdict });
  }
  out.rows.sort((a, b) => a.employee_name.localeCompare(b.employee_name, 'he'));
  return out;
}

module.exports = { attendanceVsRota };
```

- [ ] **Step 3: Implement** — `server/src/services/shiftAttendanceReportJob.js`

```js
/**
 * 07:00 every weekday morning: yesterday's no-shows and late arrivals, per
 * branch to its managers and as one summary to the office. Gated like the
 * punch digest — hourly calls, once a day via a Setting marker.
 */
const { Branch, Setting, User } = require('../models');
const notificationService = require('./notification.service');
const { branchManagerFilter } = require('./branch-recipients.service');
const { attendanceVsRota } = require('./shifts/attendanceReport.service');

const MARKER_KEY = 'shift_attendance_report_day';
const HOUR_IL = 7;
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function ilParts(now) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hourCycle: 'h23' }).format(now));
  return { day, hour };
}
const pushOnce = (payload) => notificationService.notifyOnce(payload).catch(err => console.error('[attendance-report] notify failed:', err.message));

async function tick(now = new Date()) {
  const { day, hour } = ilParts(now);
  if (hour < HOUR_IL) return { skipped: 'not 07:00 yet' };
  const yesterday = addDays(day, -1);
  if (new Date(`${yesterday}T12:00:00Z`).getUTCDay() === 6) return { skipped: 'yesterday was Saturday' };
  const marker = await Setting.findOne({ key: MARKER_KEY }).lean();
  if (marker && marker.value === day) return { skipped: 'already ran' };
  await Setting.updateOne({ key: MARKER_KEY }, { $set: { value: day } }, { upsert: true });

  const branches = await Branch.find({ is_active: { $ne: false } }).select('name').lean();
  const summary = [];
  for (const b of branches) {
    const rep = await attendanceVsRota({ branchId: b._id, date: yesterday });
    if (!rep.rows.length) continue;
    const absent = rep.rows.filter(r => r.kind === 'absent').length;
    const late = rep.rows.length - absent;
    const text = [absent && `${absent} לא הגיעו`, late && `${late} איחרו`].filter(Boolean).join(', ');
    summary.push({ branch: b, text });
    const managers = await User.find({ ...branchManagerFilter(b._id), role: 'branch_manager' }).select('_id').lean();
    for (const m of managers) {
      await pushOnce({ type: 'shift_attendance_report', ref_collection: 'Branch', ref_id: b._id, recipient_id: m._id,
        title: `נוכחות מול סידור — אתמול`, body: `${b.name}: ${text}`, url: `/shifts?report=${yesterday}` });
    }
  }
  if (summary.length) {
    const office = await User.find({ role: { $in: ['system_admin', 'accountant'] }, is_active: { $ne: false } }).select('_id').lean();
    for (const u of office) {
      await pushOnce({ type: 'shift_attendance_report_office', ref_collection: 'Branch', ref_id: summary[0].branch._id, recipient_id: u._id,
        title: 'נוכחות מול סידור — אתמול', body: summary.map(s => `${s.branch.name}: ${s.text}`).join(' · ').slice(0, 300), url: `/shifts?report=${yesterday}` });
    }
  }
  return { date: yesterday, branches: summary.length };
}

module.exports = { tick, MARKER_KEY };
```

`server/src/index.js`, after the shift reminder block:
```js
    // נוכחות מול סידור: 07:00, על אתמול — למנהלות הסניפים ולמשרד, לידיעה.
    const attendanceReport = require('./services/shiftAttendanceReportJob');
    const runAttendanceReport = () => withJobLock('shift-attendance-report', 20 * 60 * 1000, () => attendanceReport.tick())
      .catch(err => console.error('[attendance-report] failed:', err.message));
    if (!platformMode) {
      setTimeout(runAttendanceReport, 120 * 1000);
      setInterval(runAttendanceReport, 60 * 60 * 1000);
    }
```

- [ ] **Step 4: Run** test → all ✅. **Step 5: Register, commit** `feat(cross-branch): 07:00 attendance-vs-rota report`.

---

### Task 6: HTTP routes

**Files:** Modify `server/src/controllers/shifts.controller.js`, `server/src/routes/shifts.routes.js`.

**Produces** (under `/api/shifts`, `board` guard unless noted):
- `POST /rate-requests` `{ employee_id, host_branch_id, proposed_rate }` → `{ request }`; `GET /rate-requests` → `{ requests }`; `POST /rate-requests/:id/decide` `{ approve, reason, final_rate }` → `{ request }` — guard: `requireTab('shifts', ...)` already includes accountant/system_admin.
- `POST /weeks/:id/cross/:entryId/decide` `{ approve, reason }` → `{ approved }`.
- `POST /arrangements/:id/confirm`, `POST /arrangements/:id/cancel` → `{ arrangement }`.
- `GET /report?branch=&date=` → report object (`canView(user, branch)` else 403).

- [ ] **Step 1: Controller** — add `const rates = require('../services/shifts/rateRequests.service'); const cross = require('../services/shifts/crossBranch.service'); const report = require('../services/shifts/attendanceReport.service'); const { canView } = require('../services/shifts/access');` and:

```js
  createRateRequest: handle(async (req, res) => {
    res.json({ request: await rates.createRateRequest({ user: req.user, employeeId: String(req.body.employee_id || ''), hostBranchId: String(req.body.host_branch_id || ''), proposedRate: req.body.proposed_rate }) });
  }),
  rateRequests: handle(async (req, res) => { res.json({ requests: await rates.listRateRequests({ user: req.user }) }); }),
  decideRateRequest: handle(async (req, res) => {
    res.json({ request: await rates.decideRateRequest({ user: req.user, id: req.params.id, approve: req.body.approve === true, reason: req.body.reason, finalRate: req.body.final_rate }) });
  }),
  decideCross: handle(async (req, res) => {
    res.json(await cross.decidePlacement({ user: req.user, weekId: req.params.id, entryId: req.params.entryId, approve: req.body.approve === true, reason: req.body.reason }));
  }),
  confirmArrangement: handle(async (req, res) => { res.json({ arrangement: await cross.confirmArrangement({ user: req.user, id: req.params.id }) }); }),
  cancelArrangement: handle(async (req, res) => { res.json({ arrangement: await cross.cancelArrangement({ user: req.user, id: req.params.id }) }); }),
  attendanceReport: handle(async (req, res) => {
    const branchId = String(req.query.branch || ''); const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'תאריך לא תקין' });
    if (!canView(req.user, branchId)) return res.status(403).json({ error: 'אין הרשאה לסניף הזה' });
    res.json(await report.attendanceVsRota({ branchId, date }));
  }),
```

- [ ] **Step 2: Routes** — before `module.exports`:
```js
router.post('/rate-requests', board, c.createRateRequest);
router.get('/rate-requests', board, c.rateRequests);
router.post('/rate-requests/:id/decide', board, c.decideRateRequest);
router.post('/weeks/:id/cross/:entryId/decide', board, c.decideCross);
router.post('/arrangements/:id/confirm', board, c.confirmArrangement);
router.post('/arrangements/:id/cancel', board, c.cancelArrangement);
router.get('/report', board, c.attendanceReport);
```
- [ ] **Step 3: Smoke** `node -e "require('./src/routes/shifts.routes'); console.log('routes ok')"` and rerun all shift/constraint/cross test scripts. **Commit** `feat(cross-branch): routes for rates, placements, arrangements, report`.

---

### Task 7: Client — foreign employees, approvals, arrangements, rates, report

**Files:** Create `client/src/components/shifts/CrossBranchPanel.jsx`, `client/src/components/shifts/RateRequestDialog.jsx`, `client/src/components/shifts/AttendanceReportDialog.jsx`. Modify `client/src/components/shifts/EntryDialog.jsx`, `client/src/components/shifts/ShiftsScreen.jsx`, `client/src/components/shifts/shiftRows.js`, `client/src/components/shifts/ShiftGrid.jsx`.

**Consumes:** board fields `foreign_candidates`, `away`, `cross_pending`, `arrangements`, `rate_requests`, entry `cross_branch`/`cross_status`; Task 6 endpoints.

- [ ] **Step 1: `RateRequestDialog.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Stack, Autocomplete, Alert } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

/** Ask for a rate so an employee of another branch can be placed here. */
export default function RateRequestDialog({ open, onClose, candidates, hostBranchId, initialEmployeeId, onSent }) {
  const [emp, setEmp] = useState(null);
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setEmp((candidates || []).find(c => c._id === initialEmployeeId) || null);
    setRate('');
  }, [open, candidates, initialEmployeeId]);
  const send = async () => {
    setBusy(true);
    try {
      await api.post('/shifts/rate-requests', { employee_id: emp._id, host_branch_id: hostBranchId, proposed_rate: rate ? Number(rate) : null });
      toast.success('הבקשה נשלחה למנהלת סניף הבית');
      onSent();
    } catch (err) { toast.error(err.response?.data?.error || 'שליחה נכשלה'); } finally { setBusy(false); }
  };
  const options = (candidates || []).filter(c => !c.has_rate);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>בקשת תעריף לעובדת מסניף אחר</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Alert severity="info">מנהלת סניף הבית מאשרת, ואחריה המשרד קובע את התעריף. אחרי זה אפשר לשבץ אותה.</Alert>
          <Autocomplete options={options} value={emp} getOptionLabel={o => `${o.full_name} — ${o.branch_name}`}
            onChange={(_, v) => setEmp(v)} renderInput={p => <TextField {...p} label="עובדת" />} />
          <TextField type="number" label="תעריף מוצע לשעה (לא חובה)" value={rate} onChange={e => setRate(e.target.value)} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" disabled={!emp || busy} onClick={send}>שליחה</Button>
      </DialogActions>
    </Dialog>
  );
}
```

- [ ] **Step 2: `CrossBranchPanel.jsx`**

```jsx
import { useState } from 'react';
import { Alert, Stack, Button, TextField, Typography } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { fmtDate } from './shiftRows';

const WEEKDAY = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/** What waits for this manager across branches: placements of her people, permanent arrangements, rate requests. */
export default function CrossBranchPanel({ board, onChanged }) {
  const [reason, setReason] = useState({});
  const [rate, setRate] = useState({});
  const [busy, setBusy] = useState({});
  const pending = board.cross_pending || [];
  const arrangements = board.arrangements || [];
  const requests = (board.rate_requests || []).filter(r => r.can_decide);
  if (!pending.length && !arrangements.length && !requests.length) return null;

  const post = async (key, url, body, ok) => {
    setBusy(b => ({ ...b, [key]: true }));
    try { await api.post(url, body); toast.success(ok); onChanged(); }
    catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
    finally { setBusy(b => ({ ...b, [key]: false })); }
  };

  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      {pending.map(p => (
        <Alert key={p._id} severity="info" icon={false}>
          <Typography fontWeight={700}>{p.employee_name} שובצה ב{p.branch_name} — {fmtDate(p.date)} <span dir="ltr">{p.start_hhmm}–{p.end_hhmm}</span></Typography>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
            <Button size="small" variant="contained" disabled={!!busy[p._id]} onClick={() => post(p._id, `/shifts/weeks/${p.week_id}/cross/${p._id}/decide`, { approve: true }, 'השיבוץ אושר')}>אישור</Button>
            <TextField size="small" placeholder="סיבת דחייה" value={reason[p._id] || ''} onChange={e => setReason(s => ({ ...s, [p._id]: e.target.value }))} />
            <Button size="small" color="error" disabled={!!busy[p._id] || !reason[p._id]?.trim()} onClick={() => post(p._id, `/shifts/weeks/${p.week_id}/cross/${p._id}/decide`, { approve: false, reason: reason[p._id] }, 'השיבוץ נדחה')}>דחייה</Button>
          </Stack>
        </Alert>
      ))}
      {arrangements.map(a => (
        <Alert key={a._id} severity={a.status === 'active' ? 'success' : 'warning'} icon={false}>
          <Typography fontWeight={700}>
            {a.status === 'active' ? 'סידור קבוע' : 'סידור קבוע?'}: {a.employee_name} ב{a.host_branch_name} — כל יום {WEEKDAY[a.weekday]} <span dir="ltr">{a.start_hhmm}–{a.end_hhmm}</span>
          </Typography>
          {a.status === 'proposed' && <Typography variant="body2">{a.host_confirmed ? 'הסניף המארח אישר. ' : ''}{a.home_confirmed ? 'סניף הבית אישר.' : ''}</Typography>}
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            {a.can_confirm && <Button size="small" variant="contained" disabled={!!busy[a._id]} onClick={() => post(a._id, `/shifts/arrangements/${a._id}/confirm`, {}, 'אישרת')}>אישור כסידור קבוע</Button>}
            {a.can_cancel && <Button size="small" color="inherit" disabled={!!busy[a._id]} onClick={() => post(a._id, `/shifts/arrangements/${a._id}/cancel`, {}, 'הסידור הקבוע בוטל')}>ביטול</Button>}
          </Stack>
        </Alert>
      ))}
      {requests.map(r => (
        <Alert key={r._id} severity="warning" icon={false}>
          <Typography fontWeight={700}>תעריף ל{r.employee_name} ({r.home_branch_name}) לעבודה ב{r.host_branch_name}{r.proposed_rate ? ` — הוצע ${r.proposed_rate} ₪ לשעה` : ''}</Typography>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1, flexWrap: 'wrap' }} useFlexGap>
            {r.status === 'pending_office' && <TextField size="small" type="number" label="תעריף לשעה" value={rate[r._id] ?? (r.proposed_rate || '')} onChange={e => setRate(s => ({ ...s, [r._id]: e.target.value }))} />}
            <Button size="small" variant="contained" disabled={!!busy[r._id]} onClick={() => post(r._id, `/shifts/rate-requests/${r._id}/decide`, { approve: true, final_rate: rate[r._id] ? Number(rate[r._id]) : undefined }, r.status === 'pending_office' ? 'התעריף נקבע' : 'אישרת — הבקשה עברה למשרד')}>אישור</Button>
            <TextField size="small" placeholder="סיבת דחייה" value={reason[r._id] || ''} onChange={e => setReason(s => ({ ...s, [r._id]: e.target.value }))} />
            <Button size="small" color="error" disabled={!!busy[r._id] || !reason[r._id]?.trim()} onClick={() => post(r._id, `/shifts/rate-requests/${r._id}/decide`, { approve: false, reason: reason[r._id] }, 'הבקשה נדחתה')}>דחייה</Button>
          </Stack>
        </Alert>
      ))}
    </Stack>
  );
}
```

- [ ] **Step 3: `AttendanceReportDialog.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Table, TableHead, TableRow, TableCell, TableBody, Alert, LinearProgress } from '@mui/material';
import api from '../../api/client';
import { fmtDate } from './shiftRows';

/** Yesterday's rota against punches: absent / late more than 30 minutes. */
export default function AttendanceReportDialog({ open, onClose, branchId, date }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open || !branchId || !date) return;
    setData(null); setError(false);
    api.get('/shifts/report', { params: { branch: branchId, date } }).then(r => setData(r.data)).catch(() => setError(true));
  }, [open, branchId, date]);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>נוכחות מול סידור — {date ? fmtDate(date) : ''}</DialogTitle>
      <DialogContent>
        {!data && !error && <LinearProgress />}
        {error && <Alert severity="error">לא הצלחנו לטעון את הדוח</Alert>}
        {data && data.rows.length === 0 && <Alert severity="success">כולן הגיעו בזמן.</Alert>}
        {data && data.rows.length > 0 && (
          <Table size="small">
            <TableHead><TableRow><TableCell>עובדת</TableCell><TableCell>משובצת מ-</TableCell><TableCell>החתמה ראשונה</TableCell><TableCell>מצב</TableCell></TableRow></TableHead>
            <TableBody>
              {data.rows.map(r => (
                <TableRow key={r.employee_id}>
                  <TableCell>{r.employee_name}</TableCell>
                  <TableCell dir="ltr">{r.scheduled_start}</TableCell>
                  <TableCell dir="ltr">{r.first_punch || '—'}</TableCell>
                  <TableCell>{r.kind === 'absent' ? 'לא הגיעה' : `איחור ${r.minutes} דקות`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>סגירה</Button></DialogActions>
    </Dialog>
  );
}
```

- [ ] **Step 4: Grid + rows** — `shiftRows.js`: add `AREA_ROWS` entry `{ key: 'away', label: 'בסניפים אחרים' }` is NOT added to AREA_ROWS; instead export `buildAwayRow(away) → { key: 'away', label: 'בסניפים אחרים', area: 'away', classroom_id: null, cells }` where cells group `away` entries by date with `employee_name` suffixed ` (${branch_name})`. `ShiftGrid.jsx`: an entry with `cross_status === 'pending'` shows a small Chip `'ממתין לאישור סניף הבית'`; the `away` row is never clickable (`row.area === 'away'` → no onCellClick/onEntryClick).

- [ ] **Step 5: EntryDialog** — the employee Autocomplete already lists `board.employees`, which now includes rated foreign employees (`foreign: true`, label includes the branch). Add below it, when the user can edit: a link-button `'עובדת מסניף אחר בלי תעריף? בקשת תעריף'` that calls a new prop `onRequestRate()`.

- [ ] **Step 6: ShiftsScreen wiring** — read it first. Imports: `CrossBranchPanel`, `RateRequestDialog`, `AttendanceReportDialog`, `buildAwayRow`. State `rateOpen`, `reportDate` initialised from `new URLSearchParams(window.location.search).get('report')`. Render `<CrossBranchPanel board={board} onChanged={load} />` above the ConstraintsPanel when `board` exists. Rows: `[...rows, ...(board?.away?.length ? [buildAwayRow(board.away)] : [])]` passed to the grid (not to the export). EntryDialog `onRequestRate={() => { setDlg(...closed); setRateOpen(true); }}`. `<RateRequestDialog open={rateOpen} onClose={() => setRateOpen(false)} candidates={board?.foreign_candidates} hostBranchId={board?.branch_id} onSent={() => { setRateOpen(false); load(); }} />`. Header `actions`: add `{ label: 'דוח נוכחות אתמול', onClick: () => setReportDate(yesterdayYmd()) }` where `yesterdayYmd` computes local yesterday as YYYY-MM-DD. `<AttendanceReportDialog open={!!reportDate} onClose={() => setReportDate(null)} branchId={board?.branch_id} date={reportDate} />`. The save error toast already shows the server message (no-rate / overlap); when the error carries `needs_rate`, open the RateRequestDialog preselected with that employee (`initialEmployeeId`).

- [ ] **Step 7: Build** `cd client && npx vite build` → ✓ built. **Commit** `feat(cross-branch): rate requests, home approvals, arrangements, away row, attendance report on the board`.

---

### Task 8: Help text + full verification

- [ ] **Step 1:** `client/src/config/screenHelp.js` — `shifts.can` add `'לשבץ עובדת מסניף אחר שיש לה תעריף לסניף, או לבקש לה תעריף'` and `'לאשר שיבוצים של העובדות שלך בסניפים אחרים, ולאשר סידור קבוע'`; `shifts.notes` add `'שיבוץ של עובדת מסניף אחר דורש אישור של מנהלת הסניף שלה, והסידור לא נסגר עד שאושר.'` and `'כל בוקר ב-07:00 מגיע דוח על אתמול: מי שהייתה משובצת ולא החתימה, ומי שאיחרה יותר מחצי שעה.'`
- [ ] **Step 2: Verify** (all must pass; `test:screen-help` stays red only for the 4 pre-existing screens):
```bash
cd server
for t in cross-rules cross-branch-service rota-pay attendance-report constraint-rules constraints-service shifts-rules shifts-service shift-reminder fixed-schedule-closure; do node scripts/$t.test.js || echo "FAIL $t"; done
npm run test:tabs-sync && npm run test:nav-model; npm run test:screen-help
cd ../client && npx vite build
```
- [ ] **Step 3: Commit** `docs(cross-branch): help text`.

## Self-review notes

- Spec A1 → Task 3 `hasBranchRate` in `prepareEntries`; A2 → Task 2 `rateRequests.service`; A3 → Task 3 status derivation + Task 2 `decidePlacement`; A4 → Task 3 publish guard; A5 → Task 1 `crossOverlaps` + Task 3; A6 → Task 3 board `away`/`cross_pending` + Task 7; A7 → Task 2 `maybeProposeArrangement`/`confirm`/`cancel` + Task 3 `arrangementCovers`; B → Task 4; C → Task 5 + Task 6 `/report` + Task 7 dialog.
- `branch_id` on own-branch entries in rotaPay: published entries of the week have no branch_id field; rotaPay fills it with the week's branch.
