# סידור עבודה — שלב 2: אילוצים — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Employees submit work constraints (day off, partial absence, expected sick day, other, move day, swap with a colleague or a branch-wide offer) with attachments before Thursday 18:00; managers see them on the rota board, decide them (or the system auto-accepts at publish when the rota already respects them), and accepted day-off / sick constraints become regular EmployeeRequests for accounting.

**Architecture:** A `ShiftConstraint` model and pure rules (`services/shifts/constraintRules.js`: submission window, "respected" checks, entry blocking) with a DB service (`services/shifts/constraints.service.js`). Phase-1 access helpers move to `services/shifts/access.js` so both services share them without a circular require. The rota service consults constraints in three places: the board payload, entry validation, and publish. Client: a constraints tab in "המשמרות שלי" and a constraints panel + future-constraints dialog on the manager board.

**Tech Stack:** Express + Mongoose + multer (server), React 18 + MUI 6 + Vite (client), `mongodb-memory-server` tests.

**Spec:** `docs/superpowers/specs/2026-10-04-shifts-phase2-constraints-design.md`

## Global Constraints

- Constraint types: `day_off`, `partial`, `sick_expected`, `other`, `move_day`, `swap`. Statuses: `pending_colleague`, `pending_broadcast`, `broadcast`, `open`, `accepted`, `rejected`, `declined`, `cancelled`. Final = `accepted`, `rejected`, `declined`, `cancelled`.
- Submission window (Israel time): date's week ≤ current week → refused; date in next week → allowed only before Thursday 18:00 of the current week; later weeks → always allowed. For move_day / mutual swap the earliest date decides.
- Rejection always needs a reason. Accepting a far-future constraint (week after next or later) needs `confirm_far: true`.
- Accepted `day_off` → EmployeeRequest `vacation`, accepted `sick_expected` → `sick`, both `status:'pending_accountant'`, `from_date = to_date = date`, `manager_reviewed_by` = decider.
- Nobody but managers sees who volunteered for a broadcast swap; the requester sees only a count.
- Attachments: ≤ 3 files, pdf/jpg/jpeg/png, ≤ 10MB each; stored with `storage.putObject` when `storage.isConfigured()`, else base64 in the document.
- Roles: employees = `['teacher','assistant','class_leader','cook']` (tab `my_shifts`); managers per phase 1 (`canEdit` = branch_manager of her branches; office/admin_viewer view only).
- Phase 2 does not touch punches, payroll or fixed_schedule (beyond creating EmployeeRequests as above).
- Server tests are node scripts in `server/scripts/<name>.test.js`, dotenv stubbed, registered in `server/package.json`. Client: `npx vite build` must pass. All user-facing text Hebrew. Commit per task with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

Server create: `src/services/shifts/access.js`, `src/services/shifts/constraintRules.js`, `src/models/ShiftConstraint.js`, `src/services/shifts/constraints.service.js`, `scripts/constraint-rules.test.js`, `scripts/constraints-service.test.js`.
Server modify: `src/services/shifts/shiftWeek.service.js`, `src/models/index.js`, `src/models/NotificationEvent.js`, `src/controllers/shifts.controller.js`, `src/routes/shifts.routes.js`, `scripts/shifts-service.test.js`, `package.json`.
Client create: `src/components/employee-portal/MyConstraints.jsx`, `src/components/employee-portal/ConstraintForm.jsx`, `src/components/shifts/ConstraintsPanel.jsx`, `src/components/shifts/FutureConstraintsDialog.jsx`, `src/components/shifts/constraintLabels.js`.
Client modify: `src/components/employee-portal/MyShifts.jsx`, `src/components/shifts/ShiftsScreen.jsx`, `src/components/shifts/ShiftGrid.jsx`, `src/config/screenHelp.js`.

---

### Task 1: Pure constraint rules

**Files:** Create `server/src/services/shifts/constraintRules.js`; Test `server/scripts/constraint-rules.test.js`; Modify `server/package.json` (`"test:constraint-rules": "node scripts/constraint-rules.test.js",` after `"test:shift-reminder"`).

**Interfaces — Produces:**
- `TYPES` (array of the 6 types), `FINAL` (Set of final statuses), `ACTIONABLE` (Set: `open`, `pending_broadcast`, `broadcast`)
- `addDays(ymd, n) → ymd`, `ilNow(now: Date) → { day: 'YYYY-MM-DD', hour: 0-23 }`
- `submissionWindow(dates: string[], now: Date) → { ok: true } | { ok: false, error: string }`
- `isFarFuture(date, now) → bool`
- `respected(constraint, entries) → true | false | null`
- `blocksEntry(constraint, entry) → bool` (only meaningful for accepted constraints)

- [ ] **Step 1: Failing test** — `server/scripts/constraint-rules.test.js`

```js
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
```

- [ ] **Step 2: Run, expect `Cannot find module '../src/services/shifts/constraintRules'`.** `cd server && node scripts/constraint-rules.test.js`

- [ ] **Step 3: Implement** — `server/src/services/shifts/constraintRules.js`

```js
/**
 * אילוצים — the rules that need no database.
 *
 * The window is the gan's: constraints for next week close Thursday 18:00,
 * because the manager builds on Friday morning and must not be chasing
 * requests that arrive while she builds. Further-out weeks stay open — a
 * planned surgery a month away is exactly what she wants to know early.
 */
const { weekStart } = require('../parentVisibility');

const TYPES = ['day_off', 'partial', 'sick_expected', 'other', 'move_day', 'swap'];
const FINAL = new Set(['accepted', 'rejected', 'declined', 'cancelled']);
const ACTIONABLE = new Set(['open', 'pending_broadcast', 'broadcast']);
const DEADLINE_HOUR = 18;

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function ilNow(now) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hourCycle: 'h23' }).format(now));
  return { day, hour };
}

const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

function submissionWindow(dates, now) {
  if (!dates.length || !dates.every(isYmd)) return { ok: false, error: 'תאריך לא תקין' };
  const earliest = [...dates].sort()[0];
  const { day, hour } = ilNow(now);
  const current = weekStart(day);
  const next = addDays(current, 7);
  const target = weekStart(earliest);
  if (target <= current) return { ok: false, error: 'אי אפשר להגיש אילוץ לשבוע הנוכחי או לתאריך שעבר' };
  if (target === next) {
    const thursday = addDays(current, 4);
    if (day > thursday || (day === thursday && hour >= DEADLINE_HOUR)) {
      return { ok: false, error: 'ההגשה לשבוע הבא נסגרה ביום חמישי ב-18:00' };
    }
  }
  return { ok: true };
}

/** A week after next or later — deciding it now is deciding early, and final. */
function isFarFuture(date, now) {
  const current = weekStart(ilNow(now).day);
  return weekStart(date) > addDays(current, 7);
}

const mins = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const overlaps = (s1, e1, s2, e2) => s1 !== null && e1 !== null && s2 !== null && e2 !== null && s1 < e2 && s2 < e1;
const on = (entries, empId, date) => entries.filter(e => String(e.employee_id) === String(empId) && e.date === date);

function respected(c, entries) {
  const me = String(c.employee_id);
  switch (c.type) {
    case 'day_off':
    case 'sick_expected':
      return on(entries, me, c.date).length === 0;
    case 'partial': {
      const s = mins(c.from_hhmm); const t = mins(c.to_hhmm);
      return !on(entries, me, c.date).some(e => overlaps(mins(e.start_hhmm), mins(e.end_hhmm), s, t));
    }
    case 'move_day':
      return on(entries, me, c.date).length === 0 && on(entries, me, c.target_date).length > 0;
    case 'swap': {
      if (!c.colleague_id) return false;
      const handover = on(entries, me, c.date).length === 0 && on(entries, c.colleague_id, c.date).length > 0;
      if (c.swap_mode !== 'mutual') return handover;
      return handover && on(entries, me, c.target_date).length > 0 && on(entries, c.colleague_id, c.target_date).length === 0;
    }
    default:
      return null;
  }
}

function blocksEntry(c, entry) {
  if (String(c.employee_id) !== String(entry.employee_id) || c.date !== entry.date) return false;
  if (c.type === 'partial') return overlaps(mins(entry.start_hhmm), mins(entry.end_hhmm), mins(c.from_hhmm), mins(c.to_hhmm));
  return ['day_off', 'sick_expected', 'move_day', 'swap'].includes(c.type);
}

module.exports = { TYPES, FINAL, ACTIONABLE, addDays, ilNow, submissionWindow, isFarFuture, respected, blocksEntry };
```

- [ ] **Step 4: Run, expect `all passed`.**
- [ ] **Step 5: Register script, commit** — `git add server/src/services/shifts/constraintRules.js server/scripts/constraint-rules.test.js server/package.json && git commit -m "feat(constraints): pure rules — Thursday window, far future, respected, blocking"`

---

### Task 2: Model, access module, constraints service

**Files:** Create `server/src/services/shifts/access.js`, `server/src/models/ShiftConstraint.js`, `server/src/services/shifts/constraints.service.js`, `server/scripts/constraints-service.test.js`. Modify `server/src/services/shifts/shiftWeek.service.js` (import access helpers instead of defining them; keep exporting `ShiftError`, `canView`, `canEdit`), `server/src/models/index.js`, `server/src/models/NotificationEvent.js`, `server/package.json` (`"test:constraints-service"`).

**Interfaces — Consumes:** Task 1 rules; `storage.service` (`isConfigured`, `makeKey`, `putObject`, `getObject`); `notificationService.notifyOnce`; `branchManagerFilter`.
**Produces (all async unless noted):**
- access.js: `ShiftError`, `OFFICE`, `VIEW_ALL`, `canView(user, branchId)`, `canEdit(user, branchId)`, `assertView`, `assertEdit` (sync).
- constraints.service.js: `createConstraint({ employee, body, files, now })`, `listMine({ employee })`, `colleaguesOf({ employee })`, `respondColleague({ employee, id, accept })`, `volunteer({ employee, id })`, `cancelConstraint({ employee, id })`, `decide({ user, id, accept, reason, confirmFar, now })`, `approveBroadcast({ user, id })`, `pickVolunteer({ user, id, employeeId })`, `forBoard({ branchId, dates, entries })`, `listFuture({ user, branchId, now })`, `acceptedFor({ branchId, dates })`, `resolveForPublish({ user, week, entries })`, `readFile({ user, employee, id, index })`.

- [ ] **Step 1: access.js (moved verbatim from shiftWeek.service.js)**

```js
/**
 * Who may see and who may change a branch's rota — shared by the rota and the
 * constraints services, so neither has to require the other.
 */
class ShiftError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const OFFICE = ['system_admin', 'accountant'];
const VIEW_ALL = ['system_admin', 'accountant', 'admin_viewer'];

function managedBranches(user) {
  const managed = (user.managed_branch_ids || []).map(String);
  return managed.length ? managed : (user.branch_id ? [String(user.branch_id)] : []);
}
function canView(user, branchId) {
  if (!user) return false;
  if (VIEW_ALL.includes(user.role)) return true;
  return user.role === 'branch_manager' && managedBranches(user).includes(String(branchId));
}
function canEdit(user, branchId) {
  return !!user && user.role === 'branch_manager' && managedBranches(user).includes(String(branchId));
}
function assertView(user, branchId) { if (!canView(user, branchId)) throw new ShiftError(403, 'אין הרשאה לסניף הזה'); }
function assertEdit(user, branchId) { if (!canEdit(user, branchId)) throw new ShiftError(403, 'רק מנהלת הסניף עורכת את הסידור'); }

module.exports = { ShiftError, OFFICE, VIEW_ALL, canView, canEdit, assertView, assertEdit };
```

In `shiftWeek.service.js` delete the `ShiftError` class, `OFFICE`, `VIEW_ALL`, `managedBranches`, `canView`, `canEdit`, `assertView`, `assertEdit` definitions (lines ~22-42) and add near the other requires:
`const { ShiftError, OFFICE, canView, canEdit, assertView, assertEdit } = require('./access');` (add `VIEW_ALL` only if still referenced). `module.exports` keeps exporting `ShiftError, canView, canEdit`. Run `node scripts/shifts-service.test.js` — must still pass.

- [ ] **Step 2: Model** — `server/src/models/ShiftConstraint.js`

```js
const mongoose = require('mongoose');

/**
 * אילוץ — what an employee asks the manager to take into account for one day.
 *
 * One document per request, never deleted: a cancelled or rejected constraint
 * is history the manager and the employee both look back at. Swaps carry the
 * colleague (chosen, or picked by the manager from volunteers); volunteers are
 * stored here and shown to managers only.
 */
const fileSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  mimetype: { type: String, default: '' },
  size: { type: Number, default: 0 },
  storage_key: { type: String, default: '' },
  file_data: { type: String, default: '' }, // base64, only when no bucket is configured
}, { _id: false });

const shiftConstraintSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  employee_name: { type: String, default: '' },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  type: { type: String, enum: ['day_off', 'partial', 'sick_expected', 'other', 'move_day', 'swap'], required: true },
  date: { type: String, required: true },
  target_date: { type: String, default: null },
  week_start: { type: String, required: true, index: true },
  from_hhmm: { type: String, default: '' },
  to_hhmm: { type: String, default: '' },
  details: { type: String, default: '' },
  swap_mode: { type: String, enum: ['handover', 'mutual', null], default: null },
  colleague_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  broadcast: { type: Boolean, default: false },
  volunteers: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  files: { type: [fileSchema], default: [] },
  status: {
    type: String,
    enum: ['pending_colleague', 'pending_broadcast', 'broadcast', 'open', 'accepted', 'rejected', 'declined', 'cancelled'],
    default: 'open', index: true,
  },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_by_name: { type: String, default: '' },
  decided_at: { type: Date, default: null },
  decided_auto: { type: Boolean, default: false },
  reject_reason: { type: String, default: '' },
  employee_request_id: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeRequest', default: null },
  cancelled_at: { type: Date, default: null },
  cancelled_after_publish: { type: Boolean, default: false },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

shiftConstraintSchema.index({ branch_id: 1, week_start: 1, status: 1 });

module.exports = mongoose.model('ShiftConstraint', shiftConstraintSchema);
```

Register in `models/index.js` next to `ShiftWeek` (require + export `ShiftConstraint`). In `NotificationEvent.js` enum, after the shift_* line add:

```js
      // אילוצים (docs/superpowers/specs/2026-10-04-shifts-phase2-constraints-design.md).
      'constraint_decision', 'constraint_cancelled',
      'swap_request', 'swap_response', 'swap_offer', 'swap_picked',
```

- [ ] **Step 3: Failing DB test** — `server/scripts/constraints-service.test.js`

```js
#!/usr/bin/env node
/**
 * אילוצים against an in-memory database: submitting (window, validation,
 * files), swaps (colleague, broadcast, volunteers, pick), deciding (reason,
 * far future, EmployeeRequest), cancelling, and what each side may see.
 *
 *   node scripts/constraints-service.test.js
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
  const svc = require('../src/services/shifts/constraints.service');

  const NOW = new Date('2026-10-07T09:00:00Z'); // Wed, next week = 2026-10-11..16
  const LATE = new Date('2026-10-08T16:00:00Z'); // Thu 19:00 IL
  const branch = await M.Branch.create({ name: 'כפר סבא - קפלן' });
  const other = await M.Branch.create({ name: 'הרצליה הרצוג' });
  let idn = 100000000;
  const mkUser = (role, extra = {}) => M.User.create({ full_name: role, id_number: String(idn++), email: `${idn}@x.l`, password_hash: 'x', role, is_active: true, ...extra });
  const mgrUser = await mkUser('branch_manager', { managed_branch_ids: [branch._id], branch_id: branch._id });
  const manager = { id: String(mgrUser._id), role: 'branch_manager', managed_branch_ids: [String(branch._id)], full_name: 'מנהלת' };
  const admin = { id: String((await mkUser('system_admin'))._id), role: 'system_admin', full_name: 'אדמין' };
  const mkEmp = async (name, b = branch) => {
    const u = await mkUser('teacher', { branch_id: b._id });
    return M.Employee.create({ full_name: name, israeli_id: String(idn++), branch_id: b._id, user_id: u._id, is_active: true });
  };
  const dana = await mkEmp('דנה'); const ruth = await mkEmp('רות'); const noa = await mkEmp('נועה'); const far = await mkEmp('זרה', other);

  console.log('\nהגשה');
  const c1 = await svc.createConstraint({ employee: dana, body: { type: 'day_off', date: '2026-10-13', details: 'חתונה' }, files: [], now: NOW });
  eq([c1.status, c1.week_start, c1.employee_name], ['open', '2026-10-11', 'דנה'], 'יום חופש לשבוע הבא — פתוח');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'day_off', date: '2026-10-13', details: 'x' }, files: [], now: LATE }), 400, 'ההגשה לשבוע הבא נסגרה ביום חמישי ב-18:00', 'אחרי חמישי 18:00 — חסום');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'day_off', date: '2026-10-13', details: '' }, files: [], now: NOW }), 400, 'יש לכתוב סיבה או פירוט', 'בלי פירוט — חסום');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'partial', date: '2026-10-13', from_hhmm: '12:00', to_hhmm: '10:00', details: 'רופא' }, files: [], now: NOW }), 400, 'שעת הסיום חייבת להיות אחרי שעת ההתחלה', 'טווח שעות הפוך — חסום');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'move_day', date: '2026-10-13' }, files: [], now: NOW }), 400, 'חסר היום שבו תעבדי במקום', 'העברת יום בלי יום יעד — חסום');
  const withFile = await svc.createConstraint({ employee: dana, body: { type: 'sick_expected', date: '2026-10-21', details: 'ניתוח' }, files: [{ originalname: 'a.pdf', mimetype: 'application/pdf', size: 3, buffer: Buffer.from('abc') }], now: LATE });
  eq([withFile.files.length, withFile.files[0].name, !!withFile.files[0].file_data], [1, 'a.pdf', true], 'מסמך נשמר; שבוע רחוק פתוח גם אחרי חמישי');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'other', date: '2026-10-21', details: 'x' }, files: [{ originalname: 'a.exe', mimetype: 'application/x-msdownload', size: 3, buffer: Buffer.from('a') }], now: NOW }), 400, 'אפשר לצרף רק PDF או תמונה (JPG/PNG)', 'סוג קובץ לא מורשה');

  console.log('\nהחלפה עם עובדת שנבחרה');
  const sw = await svc.createConstraint({ employee: dana, body: { type: 'swap', swap_mode: 'handover', date: '2026-10-14', colleague_id: String(ruth._id) }, files: [], now: NOW });
  eq(sw.status, 'pending_colleague', 'ממתינה לעובדת השנייה');
  eq(await M.NotificationEvent.countDocuments({ type: 'swap_request' }), 1, 'רות קיבלה התראה');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'swap', swap_mode: 'handover', date: '2026-10-14', colleague_id: String(far._id) }, files: [], now: NOW }), 400, 'העובדת לא נמצאה בסניף שלך', 'עובדת מסניף אחר — חסום');
  await throws(() => svc.respondColleague({ employee: noa, id: String(sw._id), accept: true }), 403, 'הבקשה לא מיועדת לך', 'עובדת אחרת לא יכולה לענות');
  const swOpen = await svc.respondColleague({ employee: ruth, id: String(sw._id), accept: true });
  eq(swOpen.status, 'open', 'רות הסכימה — עובר למנהלת');

  console.log('\nהצעה לכל הסניף');
  const bc = await svc.createConstraint({ employee: dana, body: { type: 'swap', swap_mode: 'handover', date: '2026-10-15', broadcast: true }, files: [], now: NOW });
  eq(bc.status, 'pending_broadcast', 'ממתינה לאישור המנהלת לפני שליחה');
  await throws(() => svc.volunteer({ employee: ruth, id: String(bc._id) }), 409, 'ההצעה עוד לא נשלחה', 'אי אפשר להתנדב לפני שליחה');
  await svc.approveBroadcast({ user: manager, id: String(bc._id) });
  eq(await M.NotificationEvent.countDocuments({ type: 'swap_offer' }), 2, 'רות ונועה קיבלו הצעה (לא דנה, לא סניף אחר)');
  await svc.volunteer({ employee: ruth, id: String(bc._id) });
  await svc.volunteer({ employee: noa, id: String(bc._id) });
  const mineDana = await svc.listMine({ employee: dana });
  const bcMine = mineDana.mine.find(x => String(x._id) === String(bc._id));
  eq([bcMine.volunteer_count, bcMine.volunteers], [2, undefined], 'המבקשת רואה רק כמה — לא מי');
  const mineRuth = await svc.listMine({ employee: ruth });
  eq(mineRuth.offers.map(o => [String(o._id), o.i_volunteered, o.volunteer_count]), [[String(bc._id), true, undefined]], 'מתנדבת רואה שסימנה — בלי ספירה');
  const picked = await svc.pickVolunteer({ user: manager, id: String(bc._id), employeeId: String(noa._id) });
  eq([picked.status, String(picked.colleague_id)], ['accepted', String(noa._id)], 'המנהלת בחרה את נועה');

  console.log('\nהחלטת מנהלת');
  await throws(() => svc.decide({ user: manager, id: String(c1._id), accept: false, reason: ' ', now: NOW }), 400, 'יש לכתוב סיבה לדחייה', 'דחייה בלי סיבה');
  await throws(() => svc.decide({ user: admin, id: String(c1._id), accept: true, now: NOW }), 403, 'רק מנהלת הסניף עורכת את הסידור', 'אדמין לא מחליט');
  const acc = await svc.decide({ user: manager, id: String(c1._id), accept: true, now: NOW });
  const er = await M.EmployeeRequest.findById(acc.employee_request_id).lean();
  eq([acc.status, er.type, er.status, er.from_date, er.to_date, String(er.employee_id)], ['accepted', 'vacation', 'pending_accountant', '2026-10-13', '2026-10-13', String(dana._id)], 'אושר → בקשת חופשה להנה״ח');
  eq(await M.NotificationEvent.countDocuments({ type: 'constraint_decision', ref_id: c1._id }), 1, 'דנה קיבלה התראה');
  await throws(() => svc.decide({ user: manager, id: String(withFile._id), accept: true, now: NOW }), 409, 'אילוץ לשבוע רחוק — יש לאשר שהפעולה סופית', 'שבוע רחוק בלי אישור סופי');
  const accFar = await svc.decide({ user: manager, id: String(withFile._id), accept: true, confirmFar: true, now: NOW });
  eq((await M.EmployeeRequest.findById(accFar.employee_request_id).lean()).type, 'sick', 'מחלה צפויה → בקשת מחלה');
  await throws(() => svc.decide({ user: manager, id: String(c1._id), accept: false, reason: 'x', now: NOW }), 409, 'האילוץ כבר טופל', 'החלטה כפולה');

  console.log('\nביטול');
  const er2 = await svc.cancelConstraint({ employee: dana, id: String(c1._id) });
  eq([er2.constraint.status, (await M.EmployeeRequest.findById(acc.employee_request_id).lean()).status], ['cancelled', 'rejected'], 'ביטול אילוץ מאושר מבטל גם את בקשת החופשה הממתינה');
  await M.EmployeeRequest.updateOne({ _id: accFar.employee_request_id }, { $set: { status: 'approved' } });
  await throws(() => svc.cancelConstraint({ employee: dana, id: String(withFile._id) }), 409, 'הבקשה כבר אושרה בהנהלת החשבונות — פני למשרד', 'בקשה שאושרה בהנה״ח — לא מבוטלת כאן');
  await throws(() => svc.cancelConstraint({ employee: ruth, id: String(withFile._id) }), 403, 'זה לא האילוץ שלך', 'עובדת אחרת לא מבטלת');
  await M.ShiftWeek.create({ branch_id: branch._id, week_start: '2026-10-11', published_at: new Date() });
  const late = await svc.cancelConstraint({ employee: dana, id: String(swOpen._id) });
  eq([late.after_publish, late.constraint.cancelled_after_publish], [true, true], 'ביטול אחרי פרסום — מסומן');
  eq(await M.NotificationEvent.countDocuments({ type: 'constraint_cancelled', recipient_id: mgrUser._id }), 1, 'המנהלת קיבלה התראה');

  console.log('\nקבצים והרשאות צפייה');
  const file = await svc.readFile({ employee: dana, id: String(withFile._id), index: 0 });
  eq([file.name, file.buffer.toString()], ['a.pdf', 'abc'], 'הבעלים מוריד');
  const fileMgr = await svc.readFile({ user: manager, id: String(withFile._id), index: 0 });
  eq(fileMgr.buffer.toString(), 'abc', 'המנהלת מורידה');
  await throws(() => svc.readFile({ employee: ruth, id: String(withFile._id), index: 0 }), 403, 'אין הרשאה לקובץ', 'עובדת אחרת לא מורידה');

  console.log('\nאילוצים עתידיים ולוח');
  const future = await svc.listFuture({ user: manager, branchId: String(branch._id), now: NOW });
  eq(future.map(f => String(f._id)), [], 'אין עתידיים פתוחים (הרחוק אושר)');
  const board = await svc.forBoard({ branchId: String(branch._id), dates: ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'], entries: [{ employee_id: String(ruth._id), date: '2026-10-15', start_hhmm: '07:00', end_hhmm: '15:00' }] });
  eq(board.map(b => b.type).sort(), ['swap'], 'בלוח: רק אילוצים פעילים או מאושרים של השבוע');
  eq(board[0].volunteers.map(v => [v.full_name, v.free_that_day]), [['רות', false], ['נועה', true]], 'המנהלת רואה מתנדבות ומי פנויה');

  await new Promise(r => setTimeout(r, 300));
  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Run, expect `Cannot find module '../src/services/shifts/constraints.service'`.**

- [ ] **Step 5: Implement** — `server/src/services/shifts/constraints.service.js`

```js
/**
 * אילוצים — every database read and write.
 *
 * The employee side and the manager side meet here, and so do the two privacy
 * rules that matter: a volunteer list is a manager's (the requester gets a
 * count, a volunteer gets only her own tick), and an attachment is the
 * employee's and her managers' only.
 */
const mongoose = require('mongoose');
const { ShiftConstraint, Employee, EmployeeRequest, ShiftWeek, User } = require('../../models');
const notificationService = require('../notification.service');
const { branchManagerFilter } = require('../branch-recipients.service');
const storage = require('../storage.service');
const { weekStart } = require('../parentVisibility');
const { ShiftError, canView, canEdit, assertEdit } = require('./access');
const { TYPES, FINAL, ACTIONABLE, addDays, ilNow, submissionWindow, isFarFuture, respected } = require('./constraintRules');

const MAX_FILES = 3;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'];
const HHMM = /^\d{2}:\d{2}$/;
const label = (ymd) => ymd.split('-').reverse().slice(0, 2).join('/');

async function loadOr404(id) {
  if (!mongoose.isValidObjectId(id)) throw new ShiftError(404, 'אילוץ לא נמצא');
  const c = await ShiftConstraint.findById(id);
  if (!c) throw new ShiftError(404, 'אילוץ לא נמצא');
  return c;
}

async function notifyEmployee(employeeId, payload) {
  const emp = await Employee.findById(employeeId).select('user_id').lean();
  if (!emp || !emp.user_id) return 0;
  await notificationService.notifyOnce({ ...payload, recipient_id: emp.user_id })
    .catch(err => console.error('[constraints] notify failed:', err.message));
  return 1;
}

async function managersOf(branchId) {
  const users = await User.find({ ...branchManagerFilter(branchId), role: 'branch_manager' }).select('_id').lean();
  return users.map(u => u._id);
}

async function storeFiles(files) {
  if ((files || []).length > MAX_FILES) throw new ShiftError(400, `אפשר לצרף עד ${MAX_FILES} קבצים`);
  const out = [];
  for (const f of files || []) {
    if (!ALLOWED_MIME.includes(f.mimetype)) throw new ShiftError(400, 'אפשר לצרף רק PDF או תמונה (JPG/PNG)');
    if (f.size > MAX_FILE_BYTES) throw new ShiftError(400, 'קובץ גדול מ-10MB');
    const doc = { name: f.originalname || 'file', mimetype: f.mimetype, size: f.size };
    if (storage.isConfigured()) {
      const ext = f.mimetype === 'application/pdf' ? 'pdf' : (f.mimetype === 'image/png' ? 'png' : 'jpg');
      doc.storage_key = storage.makeKey('shift-constraints', ext);
      await storage.putObject({ key: doc.storage_key, body: f.buffer, contentType: f.mimetype });
    } else {
      doc.file_data = f.buffer.toString('base64');
    }
    out.push(doc);
  }
  return out;
}

async function createConstraint({ employee, body, files, now = new Date() }) {
  const b = body || {};
  if (!TYPES.includes(b.type)) throw new ShiftError(400, 'סוג אילוץ לא תקין');
  const details = String(b.details || '').trim().slice(0, 1000);
  const doc = {
    employee_id: employee._id, employee_name: employee.full_name, branch_id: employee.branch_id,
    type: b.type, date: String(b.date || ''), details, status: 'open',
  };
  const dates = [doc.date];
  if (['day_off', 'partial', 'sick_expected', 'other'].includes(b.type) && !details) throw new ShiftError(400, 'יש לכתוב סיבה או פירוט');
  if (b.type === 'partial') {
    if (!HHMM.test(b.from_hhmm || '') || !HHMM.test(b.to_hhmm || '') || b.from_hhmm >= b.to_hhmm) throw new ShiftError(400, 'שעת הסיום חייבת להיות אחרי שעת ההתחלה');
    doc.from_hhmm = b.from_hhmm; doc.to_hhmm = b.to_hhmm;
  }
  if (b.type === 'move_day' || (b.type === 'swap' && b.swap_mode === 'mutual')) {
    if (!b.target_date) throw new ShiftError(400, 'חסר היום שבו תעבדי במקום');
    doc.target_date = String(b.target_date);
    dates.push(doc.target_date);
  }
  if (b.type === 'swap') {
    if (!['handover', 'mutual'].includes(b.swap_mode)) throw new ShiftError(400, 'יש לבחור סוג החלפה');
    doc.swap_mode = b.swap_mode;
    const broadcast = b.broadcast === true || b.broadcast === 'true';
    if (broadcast) {
      doc.broadcast = true; doc.status = 'pending_broadcast';
    } else {
      if (!mongoose.isValidObjectId(b.colleague_id)) throw new ShiftError(400, 'יש לבחור עובדת להחלפה');
      const colleague = await Employee.findOne({ _id: b.colleague_id, branch_id: employee.branch_id, is_active: true }).lean();
      if (!colleague || String(colleague._id) === String(employee._id)) throw new ShiftError(400, 'העובדת לא נמצאה בסניף שלך');
      doc.colleague_id = colleague._id; doc.status = 'pending_colleague';
    }
  }
  const win = submissionWindow(dates, now);
  if (!win.ok) throw new ShiftError(400, win.error);
  doc.week_start = weekStart(doc.date);
  doc.files = await storeFiles(files);
  const c = await ShiftConstraint.create(doc);
  if (c.status === 'pending_colleague') {
    await notifyEmployee(c.colleague_id, {
      type: 'swap_request', ref_collection: 'ShiftConstraint', ref_id: c._id,
      title: `${c.employee_name} מבקשת להחליף איתך`, body: `ב-${label(c.date)} — אפשר לאשר או לסרב`,
      url: '/my-shifts?tab=constraints',
    });
  }
  return c;
}

/** What the employee may see: her own, requests addressed to her, open offers in her branch. */
function publicView(c, viewerId) {
  const o = c.toObject ? c.toObject() : { ...c };
  const mine = String(o.employee_id) === String(viewerId);
  const volunteerCount = (o.volunteers || []).length;
  const iVolunteered = (o.volunteers || []).some(v => String(v) === String(viewerId));
  delete o.volunteers;
  o.files = (o.files || []).map(f => ({ name: f.name, mimetype: f.mimetype, size: f.size }));
  if (mine) o.volunteer_count = volunteerCount; else o.i_volunteered = iVolunteered;
  return o;
}

async function listMine({ employee }) {
  const [mine, incoming, offers] = await Promise.all([
    ShiftConstraint.find({ employee_id: employee._id }).sort({ date: -1 }).limit(100),
    ShiftConstraint.find({ colleague_id: employee._id, status: 'pending_colleague' }).sort({ date: 1 }),
    ShiftConstraint.find({ branch_id: employee.branch_id, status: 'broadcast', employee_id: { $ne: employee._id } }).sort({ date: 1 }),
  ]);
  return {
    mine: mine.map(c => publicView(c, employee._id)),
    incoming: incoming.map(c => publicView(c, employee._id)),
    offers: offers.map(c => publicView(c, employee._id)),
  };
}

async function colleaguesOf({ employee }) {
  const rows = await Employee.find({ branch_id: employee.branch_id, is_active: true, _id: { $ne: employee._id } }).select('full_name').sort({ full_name: 1 }).lean();
  return rows.map(r => ({ _id: String(r._id), full_name: r.full_name }));
}

async function respondColleague({ employee, id, accept }) {
  const c = await loadOr404(id);
  if (String(c.colleague_id) !== String(employee._id)) throw new ShiftError(403, 'הבקשה לא מיועדת לך');
  if (c.status !== 'pending_colleague') throw new ShiftError(409, 'הבקשה כבר טופלה');
  c.status = accept ? 'open' : 'declined';
  await c.save();
  await notifyEmployee(c.employee_id, {
    type: 'swap_response', ref_collection: 'ShiftConstraint', ref_id: c._id,
    title: accept ? `${employee.full_name} הסכימה להחלפה` : `${employee.full_name} לא יכולה להחליף`,
    body: accept ? 'הבקשה עברה למנהלת הסניף' : `ב-${label(c.date)}`, url: '/my-shifts?tab=constraints',
  });
  return c;
}

async function volunteer({ employee, id }) {
  const c = await loadOr404(id);
  if (String(c.branch_id) !== String(employee.branch_id) || String(c.employee_id) === String(employee._id)) throw new ShiftError(403, 'ההצעה לא זמינה לך');
  if (c.status !== 'broadcast') throw new ShiftError(409, c.status === 'pending_broadcast' ? 'ההצעה עוד לא נשלחה' : 'ההצעה כבר נסגרה');
  await ShiftConstraint.updateOne({ _id: c._id }, { $addToSet: { volunteers: employee._id } });
  return { ok: true };
}

async function cancelConstraint({ employee, id }) {
  const c = await loadOr404(id);
  if (String(c.employee_id) !== String(employee._id)) throw new ShiftError(403, 'זה לא האילוץ שלך');
  if (['rejected', 'declined', 'cancelled'].includes(c.status)) throw new ShiftError(409, 'האילוץ כבר סגור');
  if (c.employee_request_id) {
    const er = await EmployeeRequest.findById(c.employee_request_id);
    if (er && er.status === 'approved') throw new ShiftError(409, 'הבקשה כבר אושרה בהנהלת החשבונות — פני למשרד');
    if (er && er.status !== 'rejected') {
      er.status = 'rejected';
      er.reason = `${er.reason || ''} (בוטל על ידי העובדת)`.trim();
      await er.save();
    }
  }
  const week = await ShiftWeek.findOne({ branch_id: c.branch_id, week_start: c.week_start }).select('published_at').lean();
  const afterPublish = !!(week && week.published_at);
  c.status = 'cancelled'; c.cancelled_at = new Date(); c.cancelled_after_publish = afterPublish;
  await c.save();
  if (afterPublish) {
    for (const recipient_id of await managersOf(c.branch_id)) {
      await notificationService.notifyOnce({
        type: 'constraint_cancelled', ref_collection: 'ShiftConstraint', ref_id: c._id, recipient_id,
        title: `${c.employee_name} ביטלה אילוץ`, body: `ב-${label(c.date)} — הסידור לשבוע הזה כבר פורסם`,
        url: `/shifts?week=${c.week_start}`,
      }).catch(err => console.error('[constraints] notify failed:', err.message));
    }
  }
  return { constraint: c, after_publish: afterPublish };
}

/** Accept: the EmployeeRequest that carries a day off or a sick day on to accounting. */
async function acceptInto(c, user, auto) {
  c.status = 'accepted'; c.decided_by = user.id; c.decided_by_name = user.full_name || ''; c.decided_at = new Date(); c.decided_auto = !!auto;
  const requestType = { day_off: 'vacation', sick_expected: 'sick' }[c.type];
  if (requestType && !c.employee_request_id) {
    const emp = await Employee.findById(c.employee_id).select('user_id branch_id').lean();
    const er = await EmployeeRequest.create({
      user_id: emp ? emp.user_id || null : null, employee_id: c.employee_id, branch_id: c.branch_id,
      type: requestType, from_date: c.date, to_date: c.date, reason: `אילוץ: ${c.details}`.slice(0, 500),
      status: 'pending_accountant', manager_reviewed_by: user.id, manager_reviewed_at: new Date(),
    });
    c.employee_request_id = er._id;
  }
  await c.save();
  await notifyEmployee(c.employee_id, {
    type: 'constraint_decision', ref_collection: 'ShiftConstraint', ref_id: c._id,
    title: 'האילוץ שלך התקבל', body: `ב-${label(c.date)}`, url: '/my-shifts?tab=constraints',
  });
}

async function decide({ user, id, accept, reason, confirmFar, now = new Date() }) {
  const c = await loadOr404(id);
  assertEdit(user, c.branch_id);
  if (!ACTIONABLE.has(c.status)) throw new ShiftError(409, 'האילוץ כבר טופל');
  if (!accept) {
    const why = String(reason || '').trim();
    if (!why) throw new ShiftError(400, 'יש לכתוב סיבה לדחייה');
    c.status = 'rejected'; c.reject_reason = why.slice(0, 500);
    c.decided_by = user.id; c.decided_by_name = user.full_name || ''; c.decided_at = new Date();
    await c.save();
    await notifyEmployee(c.employee_id, {
      type: 'constraint_decision', ref_collection: 'ShiftConstraint', ref_id: c._id,
      title: 'האילוץ שלך לא התקבל', body: c.reject_reason, url: '/my-shifts?tab=constraints',
    });
    return c;
  }
  if (c.status !== 'open') throw new ShiftError(409, 'בהחלפה פתוחה לכל הסניף יש לבחור מתנדבת');
  if (isFarFuture(c.date, now) && !confirmFar) throw new ShiftError(409, 'אילוץ לשבוע רחוק — יש לאשר שהפעולה סופית', { needs_confirm: true });
  await acceptInto(c, user, false);
  return c;
}

async function approveBroadcast({ user, id }) {
  const c = await loadOr404(id);
  assertEdit(user, c.branch_id);
  if (c.status !== 'pending_broadcast') throw new ShiftError(409, 'האילוץ כבר טופל');
  c.status = 'broadcast';
  await c.save();
  const staff = await Employee.find({ branch_id: c.branch_id, is_active: true, _id: { $ne: c.employee_id }, user_id: { $ne: null } }).select('user_id').lean();
  await Promise.all(staff.map(s => notificationService.notifyOnce({
    type: 'swap_offer', ref_collection: 'ShiftConstraint', ref_id: c._id, recipient_id: s.user_id,
    title: 'מישהי יכולה להחליף?', body: `נדרשת החלפה ב-${label(c.date)}`, url: '/my-shifts?tab=constraints',
  }).catch(err => console.error('[constraints] notify failed:', err.message))));
  return c;
}

async function pickVolunteer({ user, id, employeeId }) {
  const c = await loadOr404(id);
  assertEdit(user, c.branch_id);
  if (c.status !== 'broadcast') throw new ShiftError(409, 'אין הצעה פתוחה');
  if (!c.volunteers.some(v => String(v) === String(employeeId))) throw new ShiftError(400, 'העובדת לא התנדבה');
  c.colleague_id = employeeId;
  await acceptInto(c, user, false);
  await notifyEmployee(employeeId, {
    type: 'swap_picked', ref_collection: 'ShiftConstraint', ref_id: c._id,
    title: 'נבחרת להחלפה', body: `ב-${label(c.date)} במקום ${c.employee_name}`, url: '/my-shifts',
  });
  return c;
}

/** The week's live constraints for the board, volunteers spelled out for the manager. */
async function forBoard({ branchId, dates, entries }) {
  const list = await ShiftConstraint.find({
    branch_id: branchId,
    status: { $in: ['open', 'pending_broadcast', 'broadcast', 'accepted'] },
    $or: [{ date: { $in: dates } }, { target_date: { $in: dates } }],
  }).sort({ date: 1, created_at: 1 }).lean();
  const ids = [...new Set(list.flatMap(c => [...(c.volunteers || []), c.colleague_id].filter(Boolean).map(String)))];
  const names = new Map((await Employee.find({ _id: { $in: ids } }).select('full_name').lean()).map(e => [String(e._id), e.full_name]));
  return list.map(c => ({
    ...c,
    files: (c.files || []).map(f => ({ name: f.name, mimetype: f.mimetype, size: f.size })),
    colleague_name: c.colleague_id ? names.get(String(c.colleague_id)) || '' : '',
    volunteers: (c.volunteers || []).map(v => ({
      employee_id: String(v), full_name: names.get(String(v)) || '',
      free_that_day: !(entries || []).some(e => String(e.employee_id) === String(v) && e.date === c.date),
    })),
  }));
}

async function listFuture({ user, branchId, now = new Date() }) {
  if (!canView(user, branchId)) throw new ShiftError(403, 'אין הרשאה לסניף הזה');
  const after = addDays(weekStart(ilNow(now).day), 7);
  const list = await ShiftConstraint.find({ branch_id: branchId, week_start: { $gt: after }, status: { $in: ['open', 'pending_broadcast', 'broadcast'] } }).sort({ date: 1 }).lean();
  return list.map(c => ({ ...c, files: (c.files || []).map(f => ({ name: f.name, mimetype: f.mimetype, size: f.size })), volunteers: undefined, volunteer_count: (c.volunteers || []).length }));
}

async function acceptedFor({ branchId, dates }) {
  return ShiftConstraint.find({ branch_id: branchId, status: 'accepted', date: { $in: dates } }).lean();
}

/**
 * Before a publish: auto-accept what the rota already respects; refuse the
 * publish while anything else of the week is undecided.
 */
async function resolveForPublish({ user, week, entries }) {
  const live = await ShiftConstraint.find({ branch_id: week.branch_id, week_start: week.week_start, status: { $in: ['open', 'pending_broadcast', 'broadcast'] } });
  const auto = live.filter(c => c.status === 'open' && respected(c, entries) === true);
  const blocking = live.filter(c => !auto.includes(c));
  if (blocking.length) {
    throw new ShiftError(409, `יש ${blocking.length} אילוצים שלא טופלו — יש לאשר או לדחות לפני סגירת הסידור`, { open_constraints: blocking.map(c => String(c._id)) });
  }
  for (const c of auto) await acceptInto(c, user, true);
  return auto.length;
}

async function readFile({ user, employee, id, index }) {
  const c = await loadOr404(id);
  const owner = employee && String(c.employee_id) === String(employee._id);
  if (!owner && !(user && canView(user, c.branch_id))) throw new ShiftError(403, 'אין הרשאה לקובץ');
  const f = c.files[Number(index)];
  if (!f) throw new ShiftError(404, 'קובץ לא נמצא');
  const buffer = f.storage_key ? await storage.getObject(f.storage_key) : Buffer.from(f.file_data || '', 'base64');
  return { name: f.name, mimetype: f.mimetype, buffer };
}

module.exports = {
  createConstraint, listMine, colleaguesOf, respondColleague, volunteer, cancelConstraint,
  decide, approveBroadcast, pickVolunteer, forBoard, listFuture, acceptedFor, resolveForPublish, readFile,
  FINAL,
};
```

- [ ] **Step 6: Run both tests** — `node scripts/constraints-service.test.js` (all ✅) and `node scripts/shifts-service.test.js` (still passes after the access refactor).
- [ ] **Step 7: Register, commit** — `git add server/src/services/shifts server/src/models server/scripts/constraints-service.test.js server/package.json && git commit -m "feat(constraints): model and service — submit, swaps, broadcast, decide, cancel, files"`

---

### Task 3: Hook constraints into the rota (board, validation, publish)

**Files:** Modify `server/src/services/shifts/shiftWeek.service.js`, `server/scripts/shifts-service.test.js`.

**Interfaces — Consumes:** `forBoard`, `acceptedFor`, `resolveForPublish` (Task 2), `blocksEntry` (Task 1). **Produces:** `getBoard` payload gains `constraints` (array from `forBoard`); `saveEntries`/approved requests refuse entries blocked by an accepted constraint (400 `${name} — יש לה אילוץ מאושר ב-${date}`); `publishWeek` returns `{ week, notified, auto_accepted }` and may throw 409 with `open_constraints`.

- [ ] **Step 1: Failing tests** — append to `server/scripts/shifts-service.test.js`, inside the async block before the disconnect lines (reuse its `M`, `svc`, `manager`, `branch`, `dana`, `ruth` fixtures; if a name differs in the file, adapt to the file's names):

```js
  console.log('\nאילוצים בסידור');
  const C = require('../src/services/shifts/constraints.service');
  const NEXT = '2026-10-18';
  const wk2 = await svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: NEXT });
  const accepted = await M.ShiftConstraint.create({ employee_id: dana._id, employee_name: 'דנה', branch_id: branch._id, type: 'day_off', date: '2026-10-19', week_start: NEXT, details: 'x', status: 'accepted' });
  const blockedEntries = wk2.entries.map(e => e.toObject()).filter(e => !(String(e.employee_id) === String(dana._id) && e.date === '2026-10-19'));
  blockedEntries.push({ employee_id: dana._id, date: '2026-10-19', area: 'class', classroom_id: infants._id, start_hhmm: '07:00', end_hhmm: '15:00' });
  await throwsStatus(() => svc.saveEntries({ user: manager, weekId: String(wk2._id), entries: blockedEntries }), 400, 'שיבוץ על אילוץ מאושר נדחה');
  const boardC = await svc.getBoard({ user: manager, branchId: String(branch._id), weekStart: NEXT });
  eq(boardC.constraints.map(c => String(c._id)), [String(accepted._id)], 'הלוח מחזיר את אילוצי השבוע');
  const openRespected = await M.ShiftConstraint.create({ employee_id: ruth._id, employee_name: 'רות', branch_id: branch._id, type: 'day_off', date: '2026-10-22', week_start: NEXT, details: 'x', status: 'open' });
  const openOther = await M.ShiftConstraint.create({ employee_id: ruth._id, employee_name: 'רות', branch_id: branch._id, type: 'other', date: '2026-10-20', week_start: NEXT, details: 'x', status: 'open' });
  await throwsStatus(() => svc.publishWeek({ user: manager, weekId: String(wk2._id) }), 409, 'פרסום נחסם כשיש אילוץ לא מטופל');
  eq((await M.ShiftConstraint.findById(openRespected._id)).status, 'open', 'ולא אישר כלום בינתיים');
  await M.ShiftConstraint.updateOne({ _id: openOther._id }, { $set: { status: 'rejected', reject_reason: 'x' } });
  const pub2 = await svc.publishWeek({ user: manager, weekId: String(wk2._id) });
  eq([pub2.auto_accepted, (await M.ShiftConstraint.findById(openRespected._id)).status, (await M.ShiftConstraint.findById(openRespected._id)).decided_auto], [1, 'accepted', true], 'מה שהסידור כבר מכבד — מתקבל אוטומטית בפרסום');
```

(Ruth has no commitment day on 2026-10-22 (Thursday) in the fixture, so the day_off is respected. If the fixture gives her a Thursday, pick a date she does not work.)

- [ ] **Step 2: Run, expect failures (`boardC.constraints` undefined, no 400, no 409).**

- [ ] **Step 3: Implement in `shiftWeek.service.js`**

Add require: `const constraints = require('./constraints.service');` and `const { blocksEntry } = require('./constraintRules');`.

In `getBoard`, before `return {`, add:
```js
  const weekConstraints = await constraints.forBoard({ branchId, dates, entries });
```
and add `constraints: weekConstraints,` to the returned object.

In `prepareEntries`, after the existing per-entry loop and before `return { entries, additions };`, add:
```js
  // An accepted constraint is final: the employee cannot be put back on it.
  const locked = await constraints.acceptedFor({ branchId: week.branch_id, dates });
  for (const e of entries) {
    const hit = locked.find(c => blocksEntry(c, e));
    if (hit) throw new ShiftError(400, `${e.employee_name || 'עובדת'} — יש לה אילוץ מאושר ב-${e.date}`);
  }
```

In `publishWeek`, after `assertEdit(...)` and before computing `first`, add:
```js
  const autoAccepted = await constraints.resolveForPublish({ user, week, entries: week.entries.map(e => e.toObject()) });
```
and return `{ week, notified: recipients.length, auto_accepted: autoAccepted }`.

- [ ] **Step 4: Run** `node scripts/shifts-service.test.js`, `node scripts/constraints-service.test.js`, `node scripts/constraint-rules.test.js` — all pass.
- [ ] **Step 5: Commit** — `git add server/src/services/shifts/shiftWeek.service.js server/scripts/shifts-service.test.js && git commit -m "feat(constraints): rota board shows constraints, accepted ones block placement, publish resolves them"`

---

### Task 4: HTTP — routes, controller, uploads

**Files:** Modify `server/src/controllers/shifts.controller.js`, `server/src/routes/shifts.routes.js`.

**Interfaces — Produces** (under `/api/shifts`):
- Employee (`mine` guard): `POST /constraints` (multipart `files` ≤3 + fields) → `{ constraint }`; `GET /constraints/mine` → `{ mine, incoming, offers }`; `GET /constraints/colleagues` → `{ colleagues }`; `POST /constraints/:id/cancel` → `{ constraint, after_publish }`; `POST /constraints/:id/colleague-response` `{accept}` → `{ constraint }`; `POST /constraints/:id/volunteer` → `{ ok }`.
- Manager (`board` guard): `GET /constraints/future?branch=` → `{ constraints }`; `POST /constraints/:id/decide` `{accept, reason, confirm_far}` → `{ constraint }`; `POST /constraints/:id/approve-broadcast` → `{ constraint }`; `POST /constraints/:id/pick` `{employee_id}` → `{ constraint }`.
- Both: `GET /constraints/:id/files/:index` → file bytes (`Content-Disposition: inline`).

- [ ] **Step 1: Controller additions** — in `shifts.controller.js` add `const cs = require('../services/shifts/constraints.service');`, then add to `module.exports`:

```js
  // ── אילוצים: employee side ─────────────────────────────────────────
  createConstraint: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req);
    if (!employee) return res.status(400).json({ error: 'לא נמצא כרטיס עובדת מקושר' });
    res.json({ constraint: await cs.createConstraint({ employee, body: req.body, files: req.files || [] }) });
  }),
  myConstraints: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req);
    if (!employee) return res.json({ reason: 'no_employee', mine: [], incoming: [], offers: [] });
    res.json(await cs.listMine({ employee }));
  }),
  colleagues: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req);
    res.json({ colleagues: employee ? await cs.colleaguesOf({ employee }) : [] });
  }),
  cancelConstraint: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req);
    if (!employee) return res.status(400).json({ error: 'לא נמצא כרטיס עובדת מקושר' });
    res.json(await cs.cancelConstraint({ employee, id: req.params.id }));
  }),
  colleagueResponse: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req);
    if (!employee) return res.status(400).json({ error: 'לא נמצא כרטיס עובדת מקושר' });
    res.json({ constraint: await cs.respondColleague({ employee, id: req.params.id, accept: req.body.accept === true }) });
  }),
  volunteer: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req);
    if (!employee) return res.status(400).json({ error: 'לא נמצא כרטיס עובדת מקושר' });
    res.json(await cs.volunteer({ employee, id: req.params.id }));
  }),
  // ── אילוצים: manager side ──────────────────────────────────────────
  futureConstraints: handle(async (req, res) => {
    res.json({ constraints: await cs.listFuture({ user: req.user, branchId: String(req.query.branch || '') }) });
  }),
  decideConstraint: handle(async (req, res) => {
    res.json({ constraint: await cs.decide({ user: req.user, id: req.params.id, accept: req.body.accept === true, reason: req.body.reason, confirmFar: req.body.confirm_far === true }) });
  }),
  approveBroadcast: handle(async (req, res) => {
    res.json({ constraint: await cs.approveBroadcast({ user: req.user, id: req.params.id }) });
  }),
  pickVolunteer: handle(async (req, res) => {
    res.json({ constraint: await cs.pickVolunteer({ user: req.user, id: req.params.id, employeeId: String(req.body.employee_id || '') }) });
  }),
  constraintFile: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req).catch(() => null);
    const f = await cs.readFile({ user: req.user, employee, id: req.params.id, index: req.params.index });
    res.setHeader('Content-Type', f.mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.send(f.buffer);
  }),
```

- [ ] **Step 2: Routes** — in `shifts.routes.js` add after the requires:

```js
const multer = require('multer');

// Attachments for a constraint: in memory (Render's disk is ephemeral), the
// service applies type and size rules and says so in Hebrew.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 3 } });
function uploadErrors(err, _req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'קובץ גדול מ-10MB' });
  if (err && err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: 'אפשר לצרף עד 3 קבצים' });
  if (err) return res.status(400).json({ error: err.message });
  next();
}
// The attachment is the employee's and her managers' — the service decides which.
const anyone = requireTab('my_shifts', 'teacher', 'assistant', 'class_leader', 'cook', 'system_admin', 'admin_viewer', 'branch_manager', 'accountant');
```

and before `module.exports`:

```js
router.post('/constraints', mine, upload.array('files', 3), uploadErrors, c.createConstraint);
router.get('/constraints/mine', mine, c.myConstraints);
router.get('/constraints/colleagues', mine, c.colleagues);
router.get('/constraints/future', board, c.futureConstraints);
router.post('/constraints/:id/cancel', mine, c.cancelConstraint);
router.post('/constraints/:id/colleague-response', mine, c.colleagueResponse);
router.post('/constraints/:id/volunteer', mine, c.volunteer);
router.post('/constraints/:id/decide', board, c.decideConstraint);
router.post('/constraints/:id/approve-broadcast', board, c.approveBroadcast);
router.post('/constraints/:id/pick', board, c.pickVolunteer);
router.get('/constraints/:id/files/:index', anyone, c.constraintFile);
```

Note: `requireTab('my_shifts', …roles)` with managers listed lets managers through the file route by role default (requireTab uses the passed role list when no per-user override exists — read `server/src/middleware/auth.js:584-612` to confirm; if it does not, use `requireRole(...)` from the same module with all nine roles instead).

- [ ] **Step 3: Smoke** — `cd server && node -e "require('./src/routes/shifts.routes'); console.log('routes ok')"` and re-run the three test scripts.
- [ ] **Step 4: Commit** — `git add server/src/controllers/shifts.controller.js server/src/routes/shifts.routes.js && git commit -m "feat(constraints): /api/shifts/constraints routes and uploads"`

---

### Task 5: Client — employee constraints tab

**Files:** Create `client/src/components/shifts/constraintLabels.js`, `client/src/components/employee-portal/ConstraintForm.jsx`, `client/src/components/employee-portal/MyConstraints.jsx`. Modify `client/src/components/employee-portal/MyShifts.jsx`.

**Interfaces — Produces:** `constraintLabels.js`: `TYPE_LABEL`, `STATUS_LABEL`, `STATUS_COLOR`, `describe(c) → string` (one line: type label + date + hours/target), `openConstraintFile(id, index)` (fetches via `api` as blob, opens a new tab).

- [ ] **Step 1: `constraintLabels.js`**

```js
import api from '../../api/client';
import { fmtDate } from './shiftRows';

export const TYPE_LABEL = {
  day_off: 'בקשת יום חופש', partial: 'היעדרות זמנית', sick_expected: 'יום מחלה צפוי',
  other: 'אחר', move_day: 'העברת יום עבודה', swap: 'החלפה עם עובדת',
};
export const STATUS_LABEL = {
  pending_colleague: 'ממתין לעובדת השנייה', pending_broadcast: 'ממתין לאישור שליחה', broadcast: 'נשלח לכל הסניף',
  open: 'ממתין למנהלת', accepted: 'התקבל', rejected: 'לא התקבל', declined: 'העובדת סירבה', cancelled: 'בוטל',
};
export const STATUS_COLOR = {
  pending_colleague: 'warning', pending_broadcast: 'warning', broadcast: 'info', open: 'warning',
  accepted: 'success', rejected: 'error', declined: 'default', cancelled: 'default',
};

export function describe(c) {
  const parts = [TYPE_LABEL[c.type] || c.type, fmtDate(c.date)];
  if (c.type === 'partial') parts.push(`${c.from_hhmm}–${c.to_hhmm}`);
  if (c.target_date) parts.push(`במקום: ${fmtDate(c.target_date)}`);
  if (c.type === 'swap') parts.push(c.swap_mode === 'mutual' ? 'החלפה הדדית' : 'מסירת משמרת');
  return parts.join(' · ');
}

/** Attachments are behind auth, so they are fetched with the token and opened as a blob. */
export async function openConstraintFile(id, index) {
  const win = window.open('', '_blank');
  try {
    const res = await api.get(`/shifts/constraints/${id}/files/${index}`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    if (win) win.location.href = url; else window.location.href = url;
  } catch {
    if (win) win.close();
    alert('לא הצלחנו לפתוח את הקובץ');
  }
}
```

- [ ] **Step 2: `ConstraintForm.jsx`**

```jsx
import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Stack,
  ToggleButtonGroup, ToggleButton, Alert, Typography,
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { TYPE_LABEL } from '../shifts/constraintLabels';

const EMPTY = { type: 'day_off', date: '', target_date: '', from_hhmm: '10:00', to_hhmm: '12:00', details: '', swap_mode: 'handover', target: 'colleague', colleague_id: '' };

/** One constraint: the type decides which fields appear. Files go up as multipart. */
export default function ConstraintForm({ open, onClose, onSaved }) {
  const [f, setF] = useState(EMPTY);
  const [files, setFiles] = useState([]);
  const [colleagues, setColleagues] = useState([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setF(EMPTY); setFiles([]);
    api.get('/shifts/constraints/colleagues').then(r => setColleagues(r.data.colleagues || [])).catch(() => setColleagues([]));
  }, [open]);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const needsDetails = ['day_off', 'partial', 'sick_expected', 'other'].includes(f.type);
  const needsTarget = f.type === 'move_day' || (f.type === 'swap' && f.swap_mode === 'mutual');

  const submit = async () => {
    const fd = new FormData();
    fd.append('type', f.type); fd.append('date', f.date); fd.append('details', f.details);
    if (f.type === 'partial') { fd.append('from_hhmm', f.from_hhmm); fd.append('to_hhmm', f.to_hhmm); }
    if (needsTarget) fd.append('target_date', f.target_date);
    if (f.type === 'swap') {
      fd.append('swap_mode', f.swap_mode);
      if (f.target === 'all') fd.append('broadcast', 'true'); else fd.append('colleague_id', f.colleague_id);
    }
    files.forEach(file => fd.append('files', file));
    setSaving(true);
    try {
      await api.post('/shifts/constraints', fd);
      toast.success('האילוץ נשלח');
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שליחה נכשלה');
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>אילוץ חדש</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Alert severity="info">אילוצים לשבוע הבא אפשר להגיש עד יום חמישי ב-18:00. לשבועות רחוקים יותר — בכל זמן.</Alert>
          <TextField select label="סוג" value={f.type} onChange={set('type')}>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
          </TextField>
          <TextField type="date" label={f.type === 'move_day' ? 'היום שאני לא עובדת בו' : 'תאריך'} value={f.date} onChange={set('date')} InputLabelProps={{ shrink: true }} />
          {f.type === 'partial' && (
            <Stack direction="row" spacing={1}>
              <TextField type="time" label="משעה" value={f.from_hhmm} onChange={set('from_hhmm')} InputLabelProps={{ shrink: true }} fullWidth />
              <TextField type="time" label="עד שעה" value={f.to_hhmm} onChange={set('to_hhmm')} InputLabelProps={{ shrink: true }} fullWidth />
            </Stack>
          )}
          {f.type === 'swap' && (
            <>
              <ToggleButtonGroup exclusive size="small" value={f.swap_mode} onChange={(_, v) => v && setF(s => ({ ...s, swap_mode: v }))}>
                <ToggleButton value="handover">מסירת משמרת</ToggleButton>
                <ToggleButton value="mutual">החלפה הדדית</ToggleButton>
              </ToggleButtonGroup>
              <ToggleButtonGroup exclusive size="small" value={f.target} onChange={(_, v) => v && setF(s => ({ ...s, target: v }))}>
                <ToggleButton value="colleague">עובדת מסוימת</ToggleButton>
                <ToggleButton value="all">הצעה לכל הסניף</ToggleButton>
              </ToggleButtonGroup>
              {f.target === 'colleague' ? (
                <TextField select label="עם מי" value={f.colleague_id} onChange={set('colleague_id')}>
                  {colleagues.map(c => <MenuItem key={c._id} value={c._id}>{c.full_name}</MenuItem>)}
                </TextField>
              ) : (
                <Typography variant="caption" color="text.secondary">ההצעה תישלח לכל העובדות בסניף אחרי אישור המנהלת. אף אחת לא תראה מי עוד הסכימה.</Typography>
              )}
            </>
          )}
          {needsTarget && <TextField type="date" label={f.type === 'move_day' ? 'היום שאעבוד בו במקום' : 'היום שאעבוד במקומה'} value={f.target_date} onChange={set('target_date')} InputLabelProps={{ shrink: true }} />}
          <TextField label={needsDetails ? 'סיבה / פירוט' : 'הערה (לא חובה)'} value={f.details} onChange={set('details')} multiline minRows={2} />
          <Button component="label" variant="outlined">
            צירוף מסמכים ({files.length}/3)
            <input hidden type="file" multiple accept=".pdf,.jpg,.jpeg,.png" onChange={e => setFiles([...e.target.files].slice(0, 3))} />
          </Button>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={submit} disabled={saving || !f.date || (needsDetails && !f.details.trim())}>שליחה</Button>
      </DialogActions>
    </Dialog>
  );
}
```

- [ ] **Step 3: `MyConstraints.jsx`**

```jsx
import { useCallback, useEffect, useState } from 'react';
import { Box, Stack, Typography, Button, Chip, Card, CardContent, Alert, LinearProgress, Link } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import ConstraintForm from './ConstraintForm';
import { STATUS_LABEL, STATUS_COLOR, describe, openConstraintFile } from '../shifts/constraintLabels';
import { fmtDate } from '../shifts/shiftRows';

const CANCELLABLE = new Set(['pending_colleague', 'pending_broadcast', 'broadcast', 'open', 'accepted']);

export default function MyConstraints() {
  const [data, setData] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const load = useCallback(() => {
    api.get('/shifts/constraints/mine').then(r => setData(r.data)).catch(() => setData({ error: true }));
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (url, body, ok) => {
    try { const r = await api.post(url, body); toast.success(ok(r.data)); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
  };
  const cancel = (c) => {
    if (!window.confirm('לבטל את האילוץ?')) return;
    act(`/shifts/constraints/${c._id}/cancel`, {}, d => (d.after_publish ? 'האילוץ בוטל. הסידור לשבוע הזה כבר נבנה — ייתכן שלא יתחשבו בביטול.' : 'האילוץ בוטל'));
  };

  if (!data) return <LinearProgress />;
  if (data.error) return <Alert severity="error">לא הצלחנו לטעון את האילוצים</Alert>;
  if (data.reason === 'no_employee') return <Alert severity="warning">לא נמצא כרטיס עובדת מקושר למשתמש שלך. פני למשרד.</Alert>;

  return (
    <Box>
      <Button variant="contained" onClick={() => setFormOpen(true)} sx={{ mb: 2 }}>אילוץ חדש</Button>

      {(data.incoming.length > 0 || data.offers.length > 0) && (
        <Stack spacing={1} sx={{ mb: 3 }}>
          <Typography fontWeight={700}>בקשות אליי</Typography>
          {data.incoming.map(c => (
            <Alert key={c._id} severity="info" action={
              <Stack direction="row" spacing={1}>
                <Button size="small" onClick={() => act(`/shifts/constraints/${c._id}/colleague-response`, { accept: true }, () => 'אישרת — הבקשה עברה למנהלת')}>מסכימה</Button>
                <Button size="small" color="inherit" onClick={() => act(`/shifts/constraints/${c._id}/colleague-response`, { accept: false }, () => 'סירבת')}>לא יכולה</Button>
              </Stack>
            }>{c.employee_name} מבקשת: {describe(c)}</Alert>
          ))}
          {data.offers.map(c => (
            <Alert key={c._id} severity="info" action={
              c.i_volunteered
                ? <Chip size="small" color="success" label="סימנת שאת יכולה" />
                : <Button size="small" onClick={() => act(`/shifts/constraints/${c._id}/volunteer`, {}, () => 'תודה! המנהלת תחליט')}>אני יכולה</Button>
            }>מחפשים מחליפה ב-{fmtDate(c.date)}</Alert>
          ))}
        </Stack>
      )}

      <Typography fontWeight={700} sx={{ mb: 1 }}>האילוצים שלי</Typography>
      {data.mine.length === 0 && <Typography color="text.secondary">עוד לא הגשת אילוצים.</Typography>}
      <Stack spacing={1}>
        {data.mine.map(c => (
          <Card key={c._id} variant="outlined">
            <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                <Typography fontWeight={600}>{describe(c)}</Typography>
                <Chip size="small" color={STATUS_COLOR[c.status]} label={STATUS_LABEL[c.status]} />
              </Stack>
              {c.details && <Typography variant="body2" color="text.secondary">{c.details}</Typography>}
              {c.status === 'rejected' && c.reject_reason && <Typography variant="body2" color="error.main">סיבה: {c.reject_reason}</Typography>}
              {c.status === 'broadcast' && <Typography variant="body2">{c.volunteer_count ? `${c.volunteer_count} עובדות הסכימו להחלפה` : 'עוד אף אחת לא הסכימה'}</Typography>}
              <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
                {c.files.map((file, i) => <Link key={i} component="button" variant="caption" onClick={() => openConstraintFile(c._id, i)}>{file.name}</Link>)}
                {CANCELLABLE.has(c.status) && <Button size="small" color="inherit" onClick={() => cancel(c)} sx={{ mr: 'auto' }}>ביטול</Button>}
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Stack>
      <ConstraintForm open={formOpen} onClose={() => setFormOpen(false)} onSaved={() => { setFormOpen(false); load(); }} />
    </Box>
  );
}
```

- [ ] **Step 4: Tabs in `MyShifts.jsx`** — read the file first. Add `import { Tabs, Tab } from '@mui/material';` (merge into the existing MUI import) and `import MyConstraints from './MyConstraints';`. Add state `const [tab, setTab] = useState(new URLSearchParams(window.location.search).get('tab') === 'constraints' ? 'constraints' : 'rota');`. Right under the `<Typography variant="h5">המשמרות שלי</Typography>` heading render:

```jsx
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab value="rota" label="הסידור" />
        <Tab value="constraints" label="האילוצים שלי" />
      </Tabs>
      {tab === 'constraints' ? <MyConstraints /> : (
        <>
          {/* existing week toggle + alerts + grid, unchanged */}
        </>
      )}
```
Wrap the existing content (ToggleButtonGroup through the published grid) inside the fragment.

- [ ] **Step 5: Build** — `cd client && npx vite build` → ✓ built.
- [ ] **Step 6: Commit** — `git add client/src/components/shifts/constraintLabels.js client/src/components/employee-portal && git commit -m "feat(constraints): האילוצים שלי — submit, swaps, offers, cancel"`

---

### Task 6: Client — manager constraints panel, grid alerts, future dialog

**Files:** Create `client/src/components/shifts/ConstraintsPanel.jsx`, `client/src/components/shifts/FutureConstraintsDialog.jsx`. Modify `client/src/components/shifts/ShiftGrid.jsx`, `client/src/components/shifts/ShiftsScreen.jsx`.

**Interfaces — Consumes:** `board.constraints` (Task 3), Task 4 endpoints, `constraintLabels.js`. **Produces:** `ShiftGrid` optional prop `alerts: Map<string, string[]>` keyed `${employee_id}|${date}` → labels; entries with a key in it show a ⚠ mark with a tooltip.

- [ ] **Step 1: `ShiftGrid.jsx`** — add `alerts` to the props (default `new Map()` is not allowed as a default param identity issue; use `alerts` possibly undefined). Inside the entry `Box`, after the alternating chip, add:

```jsx
                          {alerts && alerts.get(`${e.employee_id}|${e.date}`) && (
                            <Tooltip title={alerts.get(`${e.employee_id}|${e.date}`).join(' · ')}>
                              <Chip size="small" color="warning" label="⚠ אילוץ" sx={{ height: 16, fontSize: '0.6rem', mt: 0.25 }} />
                            </Tooltip>
                          )}
```

- [ ] **Step 2: `ConstraintsPanel.jsx`**

```jsx
import { useState } from 'react';
import { Alert, Stack, Button, TextField, Typography, Chip, Link, Accordion, AccordionSummary, AccordionDetails } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { STATUS_LABEL, describe, openConstraintFile } from './constraintLabels';

/** The week's constraints that need the manager, with the actions each one allows. */
export default function ConstraintsPanel({ constraints, canEdit, onChanged }) {
  const [reason, setReason] = useState({});
  const [busy, setBusy] = useState({});
  const list = constraints || [];
  const actionable = list.filter(c => ['open', 'pending_broadcast', 'broadcast'].includes(c.status));
  const accepted = list.filter(c => c.status === 'accepted');
  if (!list.length) return null;

  const post = async (c, url, body, ok) => {
    setBusy(b => ({ ...b, [c._id]: true }));
    try { await api.post(url, body); toast.success(ok); onChanged(); }
    catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
    finally { setBusy(b => ({ ...b, [c._id]: false })); }
  };

  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      {actionable.map(c => (
        <Alert key={c._id} severity="warning" icon={false}>
          <Typography fontWeight={700}>{c.employee_name} — {describe(c)} <Chip size="small" label={STATUS_LABEL[c.status]} sx={{ mr: 1 }} /></Typography>
          {c.details && <Typography variant="body2">{c.details}</Typography>}
          {c.colleague_name && <Typography variant="body2">עם: {c.colleague_name}</Typography>}
          {c.files.map((f, i) => <Link key={i} component="button" variant="caption" sx={{ ml: 1 }} onClick={() => openConstraintFile(c._id, i)}>{f.name}</Link>)}
          {canEdit && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1, flexWrap: 'wrap' }} useFlexGap>
              {c.status === 'open' && <Button size="small" variant="contained" disabled={!!busy[c._id]} onClick={() => post(c, `/shifts/constraints/${c._id}/decide`, { accept: true }, 'האילוץ התקבל')}>אישור</Button>}
              {c.status === 'pending_broadcast' && <Button size="small" variant="contained" disabled={!!busy[c._id]} onClick={() => post(c, `/shifts/constraints/${c._id}/approve-broadcast`, {}, 'ההצעה נשלחה לכל הסניף')}>אישור שליחה לכל הסניף</Button>}
              {c.status === 'broadcast' && (c.volunteers.length
                ? c.volunteers.map(v => (
                  <Button key={v.employee_id} size="small" variant="outlined" disabled={!!busy[c._id]} onClick={() => post(c, `/shifts/constraints/${c._id}/pick`, { employee_id: v.employee_id }, `${v.full_name} נבחרה`)}>
                    {v.full_name}{v.free_that_day ? ' (פנויה ביום הזה)' : ''}
                  </Button>
                ))
                : <Typography variant="body2">עוד אף אחת לא התנדבה</Typography>)}
              <TextField size="small" placeholder="סיבת דחייה" value={reason[c._id] || ''} onChange={e => setReason(s => ({ ...s, [c._id]: e.target.value }))} />
              <Button size="small" color="error" disabled={!!busy[c._id] || !reason[c._id]?.trim()} onClick={() => post(c, `/shifts/constraints/${c._id}/decide`, { accept: false, reason: reason[c._id] }, 'האילוץ נדחה')}>דחייה</Button>
            </Stack>
          )}
        </Alert>
      ))}
      {accepted.length > 0 && (
        <Accordion disableGutters>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}><Typography>אילוצים שהתקבלו השבוע ({accepted.length})</Typography></AccordionSummary>
          <AccordionDetails>
            {accepted.map(c => <Typography key={c._id} variant="body2">{c.employee_name} — {describe(c)}{c.decided_auto ? ' (אוטומטית)' : ''}</Typography>)}
          </AccordionDetails>
        </Accordion>
      )}
    </Stack>
  );
}
```

- [ ] **Step 3: `FutureConstraintsDialog.jsx`**

```jsx
import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography, TextField, Alert } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { describe } from './constraintLabels';

/** Every constraint of the weeks after next — decided early, and finally. */
export default function FutureConstraintsDialog({ open, onClose, branchId, canEdit }) {
  const [list, setList] = useState(null);
  const [reason, setReason] = useState({});
  const load = useCallback(() => {
    if (!branchId) return;
    api.get('/shifts/constraints/future', { params: { branch: branchId } }).then(r => setList(r.data.constraints)).catch(() => setList([]));
  }, [branchId]);
  useEffect(() => { if (open) { setList(null); load(); } }, [open, load]);

  const decide = async (c, accept) => {
    if (accept && !window.confirm(`הפעולה סופית: ${c.employee_name} תקבל הודעה שהאילוץ התקבל, ולא יהיה אפשר לשבץ אותה ביום הזה. לאשר?`)) return;
    try {
      await api.post(`/shifts/constraints/${c._id}/decide`, accept ? { accept: true, confirm_far: true } : { accept: false, reason: reason[c._id] });
      toast.success(accept ? 'האילוץ התקבל' : 'האילוץ נדחה');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>אילוצים עתידיים</DialogTitle>
      <DialogContent>
        {list === null && <Typography>טוען…</Typography>}
        {list && list.length === 0 && <Alert severity="info">אין אילוצים פתוחים לשבועות הבאים.</Alert>}
        <Stack spacing={1.5}>
          {(list || []).map(c => (
            <Stack key={c._id} spacing={0.5} sx={{ borderBottom: '1px solid', borderColor: 'divider', pb: 1 }}>
              <Typography fontWeight={700}>{c.employee_name} — {describe(c)}</Typography>
              {c.details && <Typography variant="body2" color="text.secondary">{c.details}</Typography>}
              {canEdit && c.status === 'open' && (
                <Stack direction="row" spacing={1} alignItems="center">
                  <Button size="small" variant="contained" onClick={() => decide(c, true)}>אישור</Button>
                  <TextField size="small" placeholder="סיבת דחייה" value={reason[c._id] || ''} onChange={e => setReason(s => ({ ...s, [c._id]: e.target.value }))} />
                  <Button size="small" color="error" disabled={!reason[c._id]?.trim()} onClick={() => decide(c, false)}>דחייה</Button>
                </Stack>
              )}
            </Stack>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>סגירה</Button></DialogActions>
    </Dialog>
  );
}
```

- [ ] **Step 4: Wire into `ShiftsScreen.jsx`** — read it first. Imports: `ConstraintsPanel`, `FutureConstraintsDialog`, `{ describe }` from `./constraintLabels`. State `const [futureOpen, setFutureOpen] = useState(false);`. Compute:

```jsx
  const alerts = useMemo(() => {
    const m = new Map();
    for (const c of board?.constraints || []) {
      if (!['open', 'accepted', 'pending_broadcast', 'broadcast'].includes(c.status)) continue;
      const key = `${c.employee_id}|${c.date}`;
      m.set(key, [...(m.get(key) || []), describe(c)]);
    }
    return m;
  }, [board]);
```
Pass `alerts={alerts}` to `ShiftGrid`. Render `{board?.week && <ConstraintsPanel constraints={board.constraints} canEdit={board.can_edit} onChanged={load} />}` just above the grid (next to `EditRequestsPanel`). Add to the header `actions` array (for everyone who views the board): `{ label: 'אילוצים עתידיים', onClick: () => setFutureOpen(true) }` (keep the existing הגדרות action for can_edit). Render `<FutureConstraintsDialog open={futureOpen} onClose={() => setFutureOpen(false)} branchId={board?.branch_id} canEdit={!!board?.can_edit} />`. The publish error toast already shows the server's 409 message.

- [ ] **Step 5: Build** — `cd client && npx vite build` → ✓ built.
- [ ] **Step 6: Commit** — `git add client/src/components/shifts && git commit -m "feat(constraints): manager panel, grid alerts, future constraints dialog"`

---

### Task 7: Help text + full verification

**Files:** Modify `client/src/config/screenHelp.js` (`shifts` and `my_shifts` entries).

- [ ] **Step 1:** In `shifts.can` add `'לאשר או לדחות אילוצים של העובדות, ולבחור מתנדבת להחלפה'`; in `shifts.notes` add `'כשסוגרים סידור, אילוצים שהסידור כבר מתחשב בהם מתקבלים לבד. אילוץ שלא טופל עוצר את הסגירה.'`. In `my_shifts.can` add `'להגיש אילוצים לשבוע הבא עד יום חמישי ב-18:00, ולשבועות רחוקים בכל זמן'` and `'לבקש החלפה מעובדת אחרת או מכל הסניף'`.
- [ ] **Step 2: Verify** (all must pass; `test:screen-help` stays red only for the 4 pre-existing screens bank, expenses, income, product-matches):
```bash
cd server
node scripts/constraint-rules.test.js
node scripts/constraints-service.test.js
node scripts/shifts-rules.test.js
node scripts/shifts-service.test.js
node scripts/shift-reminder.test.js
npm run test:tabs-sync
npm run test:nav-model
npm run test:screen-help
cd ../client && npx vite build
```
- [ ] **Step 3: Commit** — `git add client/src/config/screenHelp.js && git commit -m "docs(constraints): help text for the constraints flows"`

## Self-review notes

- Spec types/fields → Task 1 `TYPES` + Task 2 `createConstraint`; window → `submissionWindow`; statuses → model enum + service transitions; manager actions → `decide`/`approveBroadcast`/`pickVolunteer` + Task 6 panel; far-future confirm → `decide` 409 `needs_confirm` + dialog confirm; blocking → Task 3 `prepareEntries`; publish auto-accept/refusal → `resolveForPublish` in Task 3; EmployeeRequest creation → `acceptInto`; cancel rules → `cancelConstraint`; privacy of volunteers → `publicView`; notifications → enum + service calls; attachments → `storeFiles`/`readFile` + Task 4 multer + `openConstraintFile`.
- `swap` accepted via pickVolunteer blocks the requester on date (blocksEntry) — consistent with "accepted constraints block placement".
