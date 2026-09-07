# Admin Viewer Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new role `admin_viewer` ("מנהל מערכת - לצפייה בלבד") that reads everything a system admin reads across all branches, acts as a branch manager inside its own `managed_branch_ids`, and has every other write queued as a `ProposedChange` for the accountant or admin to approve (approval replays the stored request).

**Architecture:** The read/write split lives in one place, `requireRole` in `server/src/middleware/auth.js`, helped by pure functions in a new `server/src/utils/viewer.js`. Writes that cannot run as a branch manager become `ProposedChange` documents; approving one re-issues the stored HTTP request against the server itself with a short-lived token minted for the approver. The client adds the role to labels, tab defaults and route guards, shows a toast on `202 {proposed:true}`, and gets one new screen to decide proposals.

**Tech Stack:** Node 18+ / Express / Mongoose (server), React + MUI + axios + react-toastify (client). Tests are plain `node scripts/<name>.test.js` scripts registered in `server/package.json`, no framework, no database (stub `User.findById` where needed).

**Spec:** `docs/superpowers/specs/2026-09-07-admin-viewer-role-design.md`

## Global Constraints

- Role id is exactly `admin_viewer`; Hebrew label everywhere is exactly `מנהל מערכת - לצפייה בלבד`.
- A **read** is `GET`, `HEAD` or `OPTIONS`; anything else is a **write**.
- Nothing changes for the seven existing roles: `system_admin`, `branch_manager`, `accountant`, `class_leader`, `teacher`, `assistant`, `cook`.
- Viewer is refused (403, no proposal) under `/api/admin`.
- Multipart writes by a viewer that cannot run as a branch manager are refused with 403, never proposed.
- A viewer write that is queued answers `202 { proposed: true, id, message }`; the message starts with `השינוי נשמר וממתין לאישור`.
- Server tests: `node scripts/<name>.test.js`, print `✅`/`❌` lines, exit code 1 on any failure, register as `"test:<name>"` in `server/package.json`.
- Commit messages in English, conventional style, and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work stays on branch `feat/admin-viewer-role`; never push to `main`.
- Run commands from the repo root `/Users/amitkohta/Desktop/Claude Code Apps/gan-halomot` unless a step says otherwise.

---

## File map

Server, new:
- `server/src/constants/roles.js` — the one list of roles (+ viewer id) shared by model, admin controller and tests.
- `server/src/utils/viewer.js` — pure helpers: `isRead`, `isViewer`, `isBlockedForViewer`, `isMultipart`, `approverFor`, `screenLabelFor`, `summarizeBody`, `extractBranchId`.
- `server/src/models/ProposedChange.js` — the queue document.
- `server/src/services/proposedChanges.service.js` — `propose(req, res)` and `applyProposal(doc, approverUser, opts)`.
- `server/src/controllers/proposedChanges.controller.js`, `server/src/routes/proposedChanges.routes.js`.
- Tests: `server/scripts/viewer-helpers.test.js`, `server/scripts/viewer-require-role.test.js`, `server/scripts/viewer-branch-scope.test.js`, `server/scripts/proposed-change-apply.test.js`, `server/scripts/proposed-change-decisions.test.js`.

Server, modified:
- `server/src/models/User.js` (enum), `server/src/models/index.js` (export), `server/src/controllers/admin.controller.js` (role lists), `server/src/middleware/auth.js` (`requireRole`, `requireBranchScope`), `server/src/utils/branch-scope.js`, `server/src/routes/index.js` (mount), `server/src/controllers/payrollMonth.controller.js` (`decidesPayroll`-adjacent viewer handling in `createChangeRequest`/`listChangeRequests`), `server/src/controllers/decisions.controller.js` (fifth source), `server/package.json` (test scripts).

Client, new:
- `client/src/components/admin/ProposedChanges.jsx` — the approver screen.
- `client/src/hooks/usePendingProposals.js` — polled pending count for the nav badge.

Client, modified:
- `client/src/hooks/useAuth.jsx`, `client/src/config/tabs.js`, `client/src/components/admin/PermissionsManager.jsx`, `client/src/api/client.js`, `client/src/App.jsx`, `client/src/components/payroll/PayrollPage.jsx`, `client/src/components/layout/Header.jsx`, `client/src/components/employees/EmployeeManager.jsx`, `client/src/components/employees/Form101Center.jsx`, `client/src/components/attendance/PunchEntryTaskGate.jsx`.

---

### Task 1: The role exists (server constants, model, admin controller)

**Files:**
- Create: `server/src/constants/roles.js`
- Modify: `server/src/models/User.js:23-27`
- Modify: `server/src/controllers/admin.controller.js:4` and `:72`
- Test: `server/scripts/viewer-role-exists.test.js`
- Modify: `server/package.json` (add `"test:viewer-role": "node scripts/viewer-role-exists.test.js"`)

**Interfaces:**
- Produces: `require('../src/constants/roles')` → `{ ROLES: string[], ADMIN_VIEWER: 'admin_viewer', ROLE_LABELS: {[role]: hebrew} }`. Later tasks import `ADMIN_VIEWER` from here.

- [ ] **Step 1: Write the failing test**

```js
#!/usr/bin/env node
/**
 * The viewer role has to exist in exactly one list the model, the admin
 * screen's API and the tests all read — a role the model accepts but the
 * admin API refuses is a role nobody can be given.
 *
 *   node scripts/viewer-role-exists.test.js
 */
const { ROLES, ADMIN_VIEWER, ROLE_LABELS } = require('../src/constants/roles');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };

console.log('\n👀 תפקיד "מנהל מערכת - לצפייה בלבד"\n');
ok(ADMIN_VIEWER === 'admin_viewer', 'המזהה הוא admin_viewer');
ok(ROLES.includes('admin_viewer'), 'הרשימה המרכזית מכילה אותו');
ok(ROLE_LABELS.admin_viewer === 'מנהל מערכת - לצפייה בלבד', 'התווית בעברית מדויקת');
for (const r of ['system_admin', 'branch_manager', 'accountant', 'class_leader', 'teacher', 'assistant', 'cook']) {
  ok(ROLES.includes(r), `התפקיד הקיים ${r} עדיין ברשימה`);
}

// The model's enum must be the same list — not a copy that can drift.
const path = require('path');
const fs = require('fs');
const userSrc = fs.readFileSync(path.join(__dirname, '../src/models/User.js'), 'utf8');
ok(userSrc.includes("require('../constants/roles')"), 'User.js קורא את הרשימה מהקבוע המשותף');
const adminSrc = fs.readFileSync(path.join(__dirname, '../src/controllers/admin.controller.js'), 'utf8');
ok(adminSrc.includes("require('../constants/roles')"), 'admin.controller קורא את הרשימה מהקבוע המשותף');
ok(!/const ALLOWED_ROLES = \[/.test(adminSrc), 'אין עוד רשימה כפולה ALLOWED_ROLES');

console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node scripts/viewer-role-exists.test.js`
Expected: crash with `Cannot find module '../src/constants/roles'`.

- [ ] **Step 3: Create the constants module**

`server/src/constants/roles.js`:

```js
/**
 * The one list of roles. The User model's enum, the admin API that assigns
 * roles, and the tests all read this — a role that exists in one place and
 * not another is a role that cannot be given, or cannot be saved.
 *
 * `admin_viewer` — "מנהל מערכת - לצפייה בלבד": reads everything a system
 * admin reads, across every branch; acts as a branch manager inside its own
 * managed_branch_ids; every other write is queued for approval instead of
 * written. See utils/viewer.js and middleware/auth.js#requireRole.
 */
const ADMIN_VIEWER = 'admin_viewer';

const ROLES = [
  'system_admin', 'branch_manager', 'accountant',
  'class_leader', 'teacher', 'assistant', 'cook',
  ADMIN_VIEWER,
];

const ROLE_LABELS = {
  system_admin: 'מנהל מערכת',
  branch_manager: 'מנהל סניף',
  accountant: 'הנה"ח',
  class_leader: 'גננת אחראית',
  teacher: 'גננת',
  assistant: 'סייעת',
  cook: 'מבשלת',
  [ADMIN_VIEWER]: 'מנהל מערכת - לצפייה בלבד',
};

module.exports = { ROLES, ADMIN_VIEWER, ROLE_LABELS };
```

- [ ] **Step 4: Point the model and the admin controller at it**

In `server/src/models/User.js`, add near the top (after the mongoose require):
```js
const { ROLES } = require('../constants/roles');
```
and replace the enum line so the role field reads:
```js
  role: {
    type: String,
    enum: ROLES,
    default: 'teacher',
  },
```

In `server/src/controllers/admin.controller.js` replace line 4
```js
const ROLES = ['system_admin', 'branch_manager', 'accountant', 'class_leader', 'teacher', 'assistant', 'cook'];
```
with
```js
const { ROLES } = require('../constants/roles');
```
and inside `updateUserRole` delete the line
```js
    const ALLOWED_ROLES = ['system_admin', 'branch_manager', 'accountant', 'class_leader', 'teacher', 'assistant', 'cook'];
```
and change `if (!ALLOWED_ROLES.includes(role))` to `if (!ROLES.includes(role))`.

Check nothing else in that file used `ALLOWED_ROLES`: `grep -n ALLOWED_ROLES server/src/controllers/admin.controller.js` must print nothing.

- [ ] **Step 5: Register and run the test**

Add to `server/package.json` scripts: `"test:viewer-role": "node scripts/viewer-role-exists.test.js",`

Run: `cd server && node scripts/viewer-role-exists.test.js`
Expected: all `✅`, exit 0. Also run `cd server && node -e "require('./src/models/User')"` — expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/constants/roles.js server/src/models/User.js server/src/controllers/admin.controller.js server/scripts/viewer-role-exists.test.js server/package.json
git commit -m "feat(roles): one shared role list, plus the admin_viewer role

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Pure viewer helpers

**Files:**
- Create: `server/src/utils/viewer.js`
- Test: `server/scripts/viewer-helpers.test.js`
- Modify: `server/package.json` (add `"test:viewer-helpers"`)

**Interfaces:**
- Produces (all synchronous, no I/O):
  - `isRead(req)` → boolean (`GET`/`HEAD`/`OPTIONS`).
  - `isViewer(user)` → boolean (`user?.role === 'admin_viewer'`).
  - `isBlockedForViewer(path)` → boolean, true when the path (no query) starts with `/api/admin`.
  - `isMultipart(req)` → boolean from `content-type`.
  - `approverFor(path)` → `'accountant' | 'system_admin'`.
  - `screenLabelFor(path)` → Hebrew string, `'מסך אחר'` when unknown.
  - `summarizeBody(body)` → `[{ key, label, value }]`, top-level scalars only, max 40 rows, values stringified, booleans `כן`/`לא`, null/'' → `—`.
  - `extractBranchId(req)` → string | null from `req.body.branch_id`, `req.params.branchId`, `req.query.branch` (in that order; `'all'` counts as null).
  - `viewerMessage(approver)` → `'השינוי נשמר וממתין לאישור ' + ('הנה"ח' | 'מנהל המערכת')`.

- [ ] **Step 1: Write the failing test**

```js
#!/usr/bin/env node
/**
 * The viewer role's rules, without a request in flight: which requests are
 * reads, which paths are off limits, who approves what, what the approver
 * will read on the card.
 *
 *   node scripts/viewer-helpers.test.js
 */
const v = require('../src/utils/viewer');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

console.log('\n👀 כללי הצופה\n');

console.log('קריאה או כתיבה');
eq(['GET', 'HEAD', 'OPTIONS'].map(m => v.isRead({ method: m })), [true, true, true], 'GET/HEAD/OPTIONS = קריאה');
eq(['POST', 'PUT', 'PATCH', 'DELETE'].map(m => v.isRead({ method: m })), [false, false, false, false], 'כל השאר = כתיבה');

console.log('\nמי צופה');
ok(v.isViewer({ role: 'admin_viewer' }), 'admin_viewer הוא צופה');
ok(!v.isViewer({ role: 'system_admin' }) && !v.isViewer(null), 'אף אחד אחר לא');

console.log('\nאזורים חסומים');
ok(v.isBlockedForViewer('/api/admin/users'), '/api/admin חסום');
ok(v.isBlockedForViewer('/api/admin/role-tabs?x=1'), 'גם עם שאילתה');
ok(!v.isBlockedForViewer('/api/administration'), 'רק הקידומת המדויקת, לא כל מה שמתחיל ב-admin');
ok(!v.isBlockedForViewer('/api/employees'), 'שאר המסכים פתוחים');

console.log('\nקבצים');
ok(v.isMultipart({ headers: { 'content-type': 'multipart/form-data; boundary=abc' } }), 'multipart מזוהה');
ok(!v.isMultipart({ headers: { 'content-type': 'application/json' } }), 'JSON לא');
ok(!v.isMultipart({ headers: {} }), 'בלי כותרת — לא');

console.log('\nמי מאשר');
eq(v.approverFor('/api/payroll-month/x'), 'accountant', 'טבלת שכר → הנה"ח');
eq(v.approverFor('/api/payroll/punches/1'), 'accountant', 'החתמות → הנה"ח');
eq(v.approverFor('/api/rate-changes'), 'accountant', 'תעריפים → הנה"ח');
eq(v.approverFor('/api/collections/1'), 'accountant', 'גבייה → הנה"ח');
eq(v.approverFor('/api/children/1'), 'system_admin', 'ילדים → מנהל מערכת');
eq(v.approverFor('/api/gan-events'), 'system_admin', 'אירועים → מנהל מערכת');
eq(v.approverFor('/api/payroll-something-else'), 'system_admin', 'קידומת דומה אך שונה → מנהל מערכת');

console.log('\nשם המסך');
eq(v.screenLabelFor('/api/employees/5'), 'עובדים', 'עובדים');
eq(v.screenLabelFor('/api/payroll-month/5?month=2026-09'), 'שכר', 'שכר, בלי השאילתה');
eq(v.screenLabelFor('/api/nothing-like-this'), 'מסך אחר', 'לא ידוע');

console.log('\nתקציר לכרטיס');
eq(v.summarizeBody({ full_name: 'דנה', hourly_rate: 45, active: true, note: '', nested: { a: 1 }, list: [1, 2] }), [
  { key: 'full_name', label: 'שם מלא', value: 'דנה' },
  { key: 'hourly_rate', label: 'שכר שעתי', value: '45' },
  { key: 'active', label: 'active', value: 'כן' },
  { key: 'note', label: 'הערה', value: '—' },
], 'סקלרים בלבד, תוויות ידועות מתורגמות, השאר כשמם');
eq(v.summarizeBody(null), [], 'גוף ריק → רשימה ריקה');
eq(v.summarizeBody(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]))).length, 40, 'לכל היותר 40 שורות');

console.log('\nסניף מהבקשה');
eq(v.extractBranchId({ body: { branch_id: 'b1' }, params: {}, query: {} }), 'b1', 'מהגוף');
eq(v.extractBranchId({ body: {}, params: { branchId: 'b2' }, query: {} }), 'b2', 'מהנתיב');
eq(v.extractBranchId({ body: {}, params: {}, query: { branch: 'b3' } }), 'b3', 'מהשאילתה');
eq(v.extractBranchId({ body: {}, params: {}, query: { branch: 'all' } }), null, '"all" אינו סניף');
eq(v.extractBranchId({}), null, 'בלי כלום → null');

console.log('\nהודעה');
eq(v.viewerMessage('accountant'), 'השינוי נשמר וממתין לאישור הנה"ח', 'להנה"ח');
eq(v.viewerMessage('system_admin'), 'השינוי נשמר וממתין לאישור מנהל המערכת', 'למנהל המערכת');

console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node scripts/viewer-helpers.test.js`
Expected: crash with `Cannot find module '../src/utils/viewer'`.

- [ ] **Step 3: Implement the helpers**

`server/src/utils/viewer.js`:

```js
/**
 * The viewer role ("מנהל מערכת - לצפייה בלבד"), reduced to rules with no
 * request in flight. middleware/auth.js#requireRole applies them; the
 * proposed-changes service reads the labels. Nothing here touches the
 * database or the response.
 */
const { ADMIN_VIEWER } = require('../constants/roles');

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/** Prefixes (path only, no query) a viewer may not touch at all — not even to read. */
const BLOCKED_PREFIXES = ['/api/admin'];

/** Path prefixes whose proposals go to the accountant; everything else → system admin. */
const ACCOUNTANT_PREFIXES = [
  '/api/payroll', '/api/payroll-month', '/api/salary-requests', '/api/rate-changes',
  '/api/employment-contracts', '/api/collections', '/api/form-101',
  '/api/employee-letters', '/api/branch-pricing', '/api/suppliers',
];

/** Path prefix → the screen name a person knows. Mirrors client/src/config/tabs.js. */
const SCREEN_LABELS = [
  ['/api/payroll-month', 'שכר'],
  ['/api/payroll', 'שכר'],
  ['/api/salary-requests', 'בקשות העלאה'],
  ['/api/rate-changes', 'שינוי תעריף'],
  ['/api/employment-contracts', 'חוזי העסקה'],
  ['/api/employee-requests', 'בקשות'],
  ['/api/employee-documents', 'מסמכים לעובד'],
  ['/api/employee-letters', 'מסמכים לעובד'],
  ['/api/employees', 'עובדים'],
  ['/api/form-101', 'טופסי 101'],
  ['/api/recruitment', 'גיוס'],
  ['/api/holidays', 'חופשות'],
  ['/api/children', 'ילדים'],
  ['/api/registrations', 'רישום'],
  ['/api/external-enrollments', 'רישום חיצוני'],
  ['/api/tmt', 'רישום חיצוני'],
  ['/api/collections', 'גבייה'],
  ['/api/contracts', 'גבייה'],
  ['/api/leads', 'פניות הורים'],
  ['/api/parent-letters', 'מסמכים להורים'],
  ['/api/parent-changes', 'עדכונים מהורים'],
  ['/api/branch-pricing', 'מחירון'],
  ['/api/discounts', 'מחירון'],
  ['/api/archives', 'ארכיון'],
  ['/api/branches', 'סניפים'],
  ['/api/classrooms', 'כיתות'],
  ['/api/classes', 'מעקב חוגים'],
  ['/api/nursery', 'לוח תינוקייה'],
  ['/api/supplies', 'מה חסר'],
  ['/api/photos', 'תמונות'],
  ['/api/gifts', 'מתנות'],
  ['/api/gantt', 'גאנט'],
  ['/api/gan-events', 'אירועים'],
  ['/api/announcements', 'הודעות לגן'],
  ['/api/absences', 'היעדרויות'],
  ['/api/pickup', 'מורשי איסוף'],
  ['/api/contacts', 'דף קשר'],
  ['/api/orders', 'הזמנות'],
  ['/api/stock', 'מעקב מלאי'],
  ['/api/suppliers', 'ספקים'],
  ['/api/products', 'הזמנות'],
  ['/api/maintenance', 'אחזקה'],
  ['/api/activities', 'פעילויות'],
  ['/api/cibus-sync', 'סיבוס'],
];

/** Body keys the approver will read, in words. Unknown keys stay as they are. */
const FIELD_LABELS = {
  full_name: 'שם מלא', first_name: 'שם פרטי', last_name: 'שם משפחה',
  phone: 'טלפון', email: 'אימייל', note: 'הערה', notes: 'הערות', reason: 'סיבה',
  date: 'תאריך', month: 'חודש', amount: 'סכום', hourly_rate: 'שכר שעתי',
  global_salary: 'שכר גלובלי', salary_type: 'סוג שכר', effective_date: 'מתאריך',
  branch_id: 'סניף', employee_id: 'עובד/ת', child_id: 'ילד/ה', status: 'סטטוס',
  is_active: 'פעיל/ה', title: 'כותרת', description: 'תיאור', timestamp: 'שעה',
  type: 'סוג', start_date: 'מתאריך', end_date: 'עד תאריך',
};

function pathOnly(url) {
  return String(url || '').split('?')[0];
}

function isRead(req) {
  return READ_METHODS.includes(String(req?.method || '').toUpperCase());
}

function isViewer(user) {
  return !!user && user.role === ADMIN_VIEWER;
}

function startsWithPrefix(path, prefix) {
  return path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?');
}

function isBlockedForViewer(url) {
  const path = pathOnly(url);
  return BLOCKED_PREFIXES.some(p => startsWithPrefix(path, p));
}

function isMultipart(req) {
  const ct = req?.headers?.['content-type'] || '';
  return ct.toLowerCase().startsWith('multipart/');
}

function approverFor(url) {
  const path = pathOnly(url);
  return ACCOUNTANT_PREFIXES.some(p => startsWithPrefix(path, p)) ? 'accountant' : 'system_admin';
}

function screenLabelFor(url) {
  const path = pathOnly(url);
  const hit = SCREEN_LABELS.find(([p]) => startsWithPrefix(path, p));
  return hit ? hit[1] : 'מסך אחר';
}

function showValue(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'כן' : 'לא';
  return String(v);
}

function summarizeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const rows = [];
  for (const [key, value] of Object.entries(body)) {
    if (value !== null && typeof value === 'object') continue;   // nested / arrays: not readable on a card
    rows.push({ key, label: FIELD_LABELS[key] || key, value: showValue(value) });
    if (rows.length >= 40) break;
  }
  return rows;
}

function extractBranchId(req) {
  const cand = req?.body?.branch_id ?? req?.params?.branchId ?? req?.query?.branch ?? null;
  if (cand === null || cand === undefined || cand === '' || cand === 'all') return null;
  return String(cand);
}

function viewerMessage(approver) {
  return `השינוי נשמר וממתין לאישור ${approver === 'accountant' ? 'הנה"ח' : 'מנהל המערכת'}`;
}

module.exports = {
  isRead, isViewer, isBlockedForViewer, isMultipart, approverFor, screenLabelFor,
  summarizeBody, extractBranchId, viewerMessage, FIELD_LABELS,
};
```

- [ ] **Step 4: Run the test**

Add to `server/package.json` scripts: `"test:viewer-helpers": "node scripts/viewer-helpers.test.js",`

Run: `cd server && node scripts/viewer-helpers.test.js`
Expected: all `✅`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/src/utils/viewer.js server/scripts/viewer-helpers.test.js server/package.json
git commit -m "feat(viewer): pure rules for the admin_viewer role

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `ProposedChange` model and the `propose()` service

**Files:**
- Create: `server/src/models/ProposedChange.js`
- Modify: `server/src/models/index.js` (require + export, next to `PayrollChangeRequest`)
- Create: `server/src/services/proposedChanges.service.js` (only `propose` in this task; `applyProposal` comes in Task 5)
- Test: `server/scripts/proposed-change-propose.test.js`
- Modify: `server/package.json` (add `"test:proposed-propose"`)

**Interfaces:**
- Produces: `propose(req, res, { models } = {})` — async; builds the document from `req` (`method`, `originalUrl`, `headers.host`, `body`, `user`), saves it through `models.ProposedChange` (defaults to `require('../models').ProposedChange`, injectable for tests), then sends `202 { proposed: true, id, approver, message }` and returns the doc. Uses `approverFor`, `screenLabelFor`, `summarizeBody`, `extractBranchId`, `viewerMessage` from Task 2.
- Model fields exactly as the spec's "`ProposedChange` model" section.

- [ ] **Step 1: Write the failing test**

```js
#!/usr/bin/env node
/**
 * A viewer's write that cannot be made becomes a card the approver can read,
 * and the viewer is told so — with 202, not 403, because nothing failed.
 *
 *   node scripts/proposed-change-propose.test.js
 */
const { propose } = require('../src/services/proposedChanges.service');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

(async () => {
  console.log('\n📨 שמירת שינוי לאישור\n');
  const created = [];
  const models = { ProposedChange: { create: async (doc) => { const d = { _id: 'pc1', ...doc }; created.push(d); return d; } } };

  const req = {
    method: 'PATCH',
    originalUrl: '/api/employees/e9?x=1',
    headers: { host: 'gan-halomot.onrender.com', 'content-type': 'application/json' },
    body: { full_name: 'דנה', hourly_rate: 45, branch_id: '64f1a2b3c4d5e6f7a8b9c0d1' },
    params: {}, query: { x: '1' },
    user: { id: 'u1', full_name: 'אלעד', role: 'admin_viewer' },
  };
  const res = fakeRes();
  const doc = await propose(req, res, { models });

  eq(res.statusCode, 202, 'עונה 202');
  eq(res.body.proposed, true, 'proposed: true');
  eq(res.body.id, 'pc1', 'מחזיר את המזהה');
  eq(res.body.approver, 'system_admin', 'עובדים → מנהל המערכת');
  ok(res.body.message.startsWith('השינוי נשמר וממתין לאישור'), 'ההודעה בעברית');

  eq(created.length, 1, 'מסמך אחד נשמר');
  eq(doc.method, 'PATCH', 'השיטה נשמרה');
  eq(doc.path, '/api/employees/e9?x=1', 'הנתיב כולל השאילתה');
  eq(doc.host, 'gan-halomot.onrender.com', 'המארח נשמר (לזיהוי הלקוח בהפעלה מחדש)');
  eq(doc.body, { full_name: 'דנה', hourly_rate: 45, branch_id: '64f1a2b3c4d5e6f7a8b9c0d1' }, 'הגוף נשמר כמו שהוא');
  eq(doc.requested_by, 'u1', 'מי ביקש');
  eq(doc.requested_by_name, 'אלעד', 'ובשמו');
  eq(doc.requested_role, 'admin_viewer', 'ובאיזה תפקיד');
  eq(doc.screen_label, 'עובדים', 'שם המסך');
  eq(doc.branch_id, '64f1a2b3c4d5e6f7a8b9c0d1', 'הסניף מהגוף');
  {
    const r2 = fakeRes();
    const d2 = await propose({ ...req, body: { branch_id: 'not-an-id' } }, r2, { models });
    eq(d2.branch_id, null, 'סניף שאינו מזהה תקין → null, לא קריסה');
  }
  eq(doc.approver, 'system_admin', 'המאשר');
  eq(doc.status, 'pending', 'ממתין');
  eq(doc.summary.map(r => r.label), ['שם מלא', 'שכר שעתי', 'סניף'], 'התקציר קריא');

  console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
  process.exit(failures ? 1 : 0);
})();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node scripts/proposed-change-propose.test.js`
Expected: crash with `Cannot find module '../src/services/proposedChanges.service'`.

- [ ] **Step 3: Create the model**

`server/src/models/ProposedChange.js`:

```js
const mongoose = require('mongoose');

/**
 * A write a viewer ("מנהל מערכת - לצפייה בלבד") asked for and may not make.
 *
 * The request is kept whole — method, path, body, the host it came to — so
 * that approving it means re-issuing it as the approver, through the same
 * route and the same validation the approver would hit typing it herself.
 * `summary` is what the approver reads on the card; it is derived at save
 * time from the body, because the body is JSON and the approver is a person.
 *
 * `status: failed` is a proposal that was approved and whose replay did not
 * return 2xx. It stays on the screen with the error so it can be retried or
 * rejected; it is never silently dropped.
 */
const summaryRowSchema = new mongoose.Schema({
  key: { type: String, default: '' },
  label: { type: String, default: '' },
  value: { type: String, default: '' },
}, { _id: false });

const proposedChangeSchema = new mongoose.Schema({
  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  requested_by_name: { type: String, default: '' },
  requested_role: { type: String, default: '' },

  method: { type: String, required: true },
  path: { type: String, required: true },      // originalUrl, query included
  host: { type: String, default: '' },
  body: { type: mongoose.Schema.Types.Mixed, default: null },
  content_type: { type: String, default: 'application/json' },

  screen_label: { type: String, default: '' },
  summary: { type: [summaryRowSchema], default: [] },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  branch_name: { type: String, default: '' },

  approver: { type: String, enum: ['accountant', 'system_admin'], default: 'system_admin' },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'failed'], default: 'pending', index: true },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_by_name: { type: String, default: '' },
  decided_at: { type: Date, default: null },
  decision_note: { type: String, default: '' },
  apply_status: { type: Number, default: null },
  apply_error: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

proposedChangeSchema.index({ status: 1, created_at: -1 });
proposedChangeSchema.index({ requested_by: 1, created_at: -1 });

module.exports = mongoose.model('ProposedChange', proposedChangeSchema);
```

In `server/src/models/index.js` add after the `PayrollChangeRequest` require line:
```js
const ProposedChange = require('./ProposedChange');
```
and after `PayrollChangeRequest,` in the exported object:
```js
  ProposedChange,
```

- [ ] **Step 4: Create the service with `propose`**

`server/src/services/proposedChanges.service.js`:

```js
/**
 * Queue a viewer's write for approval, and (Task 5) apply it once approved.
 */
const {
  approverFor, screenLabelFor, summarizeBody, extractBranchId, viewerMessage,
} = require('../utils/viewer');

function defaultModels() {
  // Lazy: the models index opens mongoose, which the tests do not want.
  return require('../models');
}

/**
 * Save the request as a ProposedChange and answer 202.
 * Returns the saved document. `models` is injectable for tests.
 */
async function propose(req, res, { models } = {}) {
  const M = models || defaultModels();
  // Typed ObjectId on the document: a body carrying anything else would make
  // create() throw, and a bad branch id is not a reason to lose the request.
  const raw = extractBranchId(req);
  const branchId = /^[0-9a-fA-F]{24}$/.test(raw || '') ? raw : null;
  let branchName = '';
  if (branchId && M.Branch && typeof M.Branch.findById === 'function') {
    try {
      const b = await M.Branch.findById(branchId).select('name').lean();
      branchName = b?.name || '';
    } catch { /* the name is decoration */ }
  }
  const approver = approverFor(req.originalUrl);
  const doc = await M.ProposedChange.create({
    requested_by: req.user?.id || null,
    requested_by_name: req.user?.full_name || '',
    requested_role: req.user?.role || '',
    method: String(req.method || '').toUpperCase(),
    path: req.originalUrl || '',
    host: req.headers?.host || '',
    body: req.body ?? null,
    content_type: req.headers?.['content-type'] || 'application/json',
    screen_label: screenLabelFor(req.originalUrl),
    summary: summarizeBody(req.body),
    branch_id: branchId,
    branch_name: branchName,
    approver,
    status: 'pending',
  });
  res.status(202).json({
    proposed: true,
    id: String(doc._id),
    approver,
    message: viewerMessage(approver),
  });
  return doc;
}

module.exports = { propose };
```

- [ ] **Step 5: Run the test**

Add to `server/package.json` scripts: `"test:proposed-propose": "node scripts/proposed-change-propose.test.js",`

Run: `cd server && node scripts/proposed-change-propose.test.js`
Expected: all `✅`, exit 0. Also `cd server && node -e "require('./src/models')"` exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/models/ProposedChange.js server/src/models/index.js server/src/services/proposedChanges.service.js server/scripts/proposed-change-propose.test.js server/package.json
git commit -m "feat(viewer): ProposedChange model and the propose() service

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `requireRole`, `requireBranchScope`, `resolveBranchScope` learn the viewer

**Files:**
- Modify: `server/src/middleware/auth.js:158-168` (`requireRole`), `:185-195` (`requireBranchScope`)
- Modify: `server/src/utils/branch-scope.js:17-38`
- Test: `server/scripts/viewer-require-role.test.js`, `server/scripts/viewer-branch-scope.test.js`
- Modify: `server/package.json` (add `"test:viewer-gate"`, `"test:viewer-scope"`)

**Interfaces:**
- Consumes: Task 2 helpers; Task 3 `propose(req, res)`.
- Produces: `requireRole(...roles)` unchanged signature. New behaviour for `req.user.role === 'admin_viewer'` only, exactly:
  1. read + blocked prefix → 403 `{ error: 'אין לך הרשאה לפעולה זו' }`.
  2. read + roles include `system_admin` → next(). Read + roles do not include `system_admin` → the normal check (viewer is not in the list → 403).
  3. write + blocked prefix → 403.
  4. write + multipart → 403 `{ error: 'אי אפשר לשמור העלאת קובץ לאישור. העלאה אפשרית רק בסניפים שבניהולך — או דרך מנהל המערכת.', code: 'VIEWER_NO_UPLOAD' }` **unless** rule 5 applies (route allows `branch_manager` and viewer has managed branches) — then it continues under rule 5 and the controller's scope check decides.
  5. write + roles include `branch_manager` + `req.user.managed_branch_ids.length > 0` → `req.user.role = 'branch_manager'`, `req.viewerFallback = true`, install the 403→propose wrapper, next().
  6. otherwise write → `propose(req, res)` (202).
- The 403→propose wrapper: replace `res.json` on that response; when called while `res.statusCode === 403` and the request has not started sending, it restores the original `res.json`, resets `res.statusCode` to 200, restores `req.user.role = 'admin_viewer'`, and calls `propose(req, res)`. Multipart under rule 5 that reaches a 403 is **refused, not proposed** (send the rule-4 body instead).
- `requireBranchScope`: `admin_viewer` passes.
- `resolveBranchScope(req)`: after the DB read, `if (role === 'admin_viewer') return isRead(req) ? null : managed;` where `managed` falls back to `[]` (a pure viewer's write scope is empty). Exported unchanged.

- [ ] **Step 1: Write the failing gate test**

`server/scripts/viewer-require-role.test.js`:

```js
#!/usr/bin/env node
/**
 * The one gate every route passes through, and what it does with a viewer.
 *
 * Reads: wherever a system admin may read, except /api/admin.
 * Writes: as a branch manager when the route allows managers and the viewer
 * has branches; queued for approval otherwise; refused for uploads and for
 * /api/admin. A controller that answers 403 under the manager fallback (the
 * target was outside the viewer's branches) is turned into a proposal.
 * Every other role: exactly as before.
 *
 *   node scripts/viewer-require-role.test.js
 */
const Module = require('module');

// Stub the proposal service so no model is touched: record the call, answer 202.
const proposals = [];
const realLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request.endsWith('services/proposedChanges.service')) {
    return {
      propose: async (req, res) => {
        proposals.push({ method: req.method, url: req.originalUrl, role: req.user.role, body: req.body });
        res.status(202).json({ proposed: true, id: 'pc', message: 'השינוי נשמר וממתין לאישור מנהל המערכת' });
      },
    };
  }
  return realLoad.call(this, request, parent, ...rest);
};

const { requireRole, requireBranchScope } = require('../src/middleware/auth');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

function fakeRes() {
  const r = { statusCode: 200, body: null, headersSent: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; };
  return r;
}
const viewer = (managed = []) => ({ id: 'u', full_name: 'אלעד', role: 'admin_viewer', managed_branch_ids: managed });
const mkReq = (method, url, user, extra = {}) => ({
  method, originalUrl: url, headers: { 'content-type': 'application/json' }, body: {}, params: {}, query: {}, user, ...extra,
});

/** Run the gate; resolve with {nexted, res, req}. */
function run(gate, req) {
  return new Promise((resolve) => {
    const res = fakeRes();
    let nexted = false;
    const maybe = gate(req, res, () => { nexted = true; });
    Promise.resolve(maybe).then(() => setImmediate(() => resolve({ nexted, res, req })));
  });
}

(async () => {
  console.log('\n🚪 שער התפקידים והצופה\n');

  console.log('קריאות');
  {
    const r = await run(requireRole('system_admin', 'accountant'), mkReq('GET', '/api/payroll-month?month=2026-09', viewer()));
    ok(r.nexted, 'צופה קורא היכן שמנהל מערכת קורא');
  }
  {
    const r = await run(requireRole('branch_manager'), mkReq('GET', '/api/something', viewer(['b1'])));
    ok(!r.nexted && r.res.statusCode === 403, 'מסלול שמנהל מערכת אינו ברשימתו — הכלל הרגיל (403)');
  }
  {
    const r = await run(requireRole('system_admin'), mkReq('GET', '/api/admin/users', viewer()));
    ok(!r.nexted && r.res.statusCode === 403, '/api/admin חסום גם לקריאה');
  }

  console.log('\nכתיבות');
  proposals.length = 0;
  {
    const r = await run(requireRole('system_admin', 'accountant'), mkReq('PUT', '/api/payroll-month/special-days/1', viewer(['b1']), { body: { name: 'יום' } }));
    ok(!r.nexted && r.res.statusCode === 202 && r.res.body.proposed === true, 'כתיבה במסלול של המשרד → נשמר לאישור (202)');
    eq(proposals.length, 1, 'הצעה אחת נרשמה');
    eq(proposals[0].role, 'admin_viewer', 'ההצעה נרשמה בתפקיד הצופה');
  }
  {
    const r = await run(requireRole('system_admin', 'accountant', 'branch_manager'), mkReq('POST', '/api/payroll-month/punch-resolutions', viewer(['b1'])));
    ok(r.nexted && r.req.user.role === 'branch_manager' && r.req.viewerFallback === true, 'מסלול שמותר למנהל סניף + יש סניפים → ממשיך כמנהל סניף');
  }
  {
    const r = await run(requireRole('system_admin', 'accountant', 'branch_manager'), mkReq('POST', '/api/payroll-month/punch-resolutions', viewer([])));
    ok(!r.nexted && r.res.statusCode === 202, 'אותו מסלול בלי סניפים → נשמר לאישור');
  }
  {
    const r = await run(requireRole('system_admin'), mkReq('PATCH', '/api/admin/users/1/role', viewer(['b1'])));
    ok(!r.nexted && r.res.statusCode === 403, 'כתיבה תחת /api/admin → 403, בלי הצעה');
  }
  {
    const req = mkReq('POST', '/api/documents', viewer([]), { headers: { 'content-type': 'multipart/form-data; boundary=x' } });
    const r = await run(requireRole('system_admin', 'accountant'), req);
    ok(!r.nexted && r.res.statusCode === 403 && r.res.body.code === 'VIEWER_NO_UPLOAD', 'העלאת קובץ → 403 עם קוד, לא הצעה');
  }

  console.log('\n403 מהבקר תחת הגיבוי כמנהל סניף');
  proposals.length = 0;
  {
    const r = await run(requireRole('system_admin', 'accountant', 'branch_manager'), mkReq('PATCH', '/api/employees/e1', viewer(['b1']), { body: { full_name: 'x' } }));
    ok(r.nexted, 'השער העביר הלאה');
    // The controller now says "not your branch":
    r.res.status(403).json({ error: 'ניתן לערוך רק עובדי הסניפים שבניהולך' });
    await new Promise(res => setImmediate(res));
    eq(r.res.statusCode, 202, 'ה-403 הפך ל-202');
    eq(r.res.body.proposed, true, 'והתשובה היא הצעה');
    eq(proposals.length, 1, 'ההצעה נרשמה');
    eq(r.req.user.role, 'admin_viewer', 'התפקיד שוחזר לצופה לפני הרישום');
  }
  {
    const r = await run(requireRole('system_admin', 'accountant', 'branch_manager'), mkReq('PATCH', '/api/employees/e1', viewer(['b1'])));
    r.res.status(400).json({ error: 'חסר שדה' });
    eq(r.res.statusCode, 400, '400 מהבקר עובר כמו שהוא');
  }
  {
    const r = await run(requireRole('system_admin', 'accountant', 'branch_manager'), mkReq('PATCH', '/api/employees/e1', viewer(['b1'])));
    r.res.status(200).json({ ok: true });
    eq(r.res.body, { ok: true }, '200 מהבקר עובר כמו שהוא');
  }
  {
    const req = mkReq('POST', '/api/photos', viewer(['b1']), { headers: { 'content-type': 'multipart/form-data; boundary=x' } });
    const r = await run(requireRole('system_admin', 'branch_manager'), req);
    ok(r.nexted, 'העלאה במסלול של מנהלי סניף ממשיכה (הבקר יבדוק את הסניף)');
    r.res.status(403).json({ error: 'לא הסניף שלך' });
    await new Promise(res => setImmediate(res));
    ok(r.res.statusCode === 403 && r.res.body.code === 'VIEWER_NO_UPLOAD', 'ו-403 על העלאה נשאר סירוב, לא הצעה');
  }

  console.log('\nשבעת התפקידים הקיימים — ללא שינוי');
  for (const role of ['system_admin', 'branch_manager', 'accountant', 'class_leader', 'teacher', 'assistant', 'cook']) {
    const allowed = await run(requireRole(role), mkReq('POST', '/api/x', { role }));
    const denied = await run(requireRole('nobody'), mkReq('POST', '/api/x', { role }));
    ok(allowed.nexted && !denied.nexted && denied.res.statusCode === 403 && allowed.req.viewerFallback === undefined, role);
  }
  {
    const r = await run(requireRole('system_admin'), { method: 'GET', originalUrl: '/api/x', headers: {} });
    ok(r.res.statusCode === 401, 'בלי משתמש → 401');
  }

  console.log('\nrequireBranchScope');
  {
    const r = await run(requireBranchScope, mkReq('GET', '/api/payroll-month/my-updates', viewer([])));
    ok(r.nexted, 'צופה עובר, גם בלי סניפים');
  }

  console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
  process.exit(failures ? 1 : 0);
})();
```

- [ ] **Step 2: Write the failing scope test**

`server/scripts/viewer-branch-scope.test.js`:

```js
#!/usr/bin/env node
/**
 * Which branches a viewer's request may touch: all of them to read, only
 * the managed ones to write, none when there are no managed ones.
 *
 *   node scripts/viewer-branch-scope.test.js
 */
const Module = require('module');

// Stand-in for the User model: what the database says about each user.
let dbUsers = {};
const realLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === '../models' && parent && parent.filename.endsWith('utils/branch-scope.js')) {
    return {
      User: {
        findById: (id) => ({ select: () => ({ lean: async () => dbUsers[id] || null }) }),
      },
    };
  }
  return realLoad.call(this, request, parent, ...rest);
};

const { resolveBranchScope } = require('../src/utils/branch-scope');

let failures = 0;
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

(async () => {
  console.log('\n🗺️ טווח הסניפים של הצופה\n');
  dbUsers = {
    v1: { role: 'admin_viewer', managed_branch_ids: ['b1'], branch_id: 'b1' },
    v0: { role: 'admin_viewer', managed_branch_ids: [], branch_id: 'b9' },
    a1: { role: 'system_admin', managed_branch_ids: [], branch_id: null },
    m1: { role: 'branch_manager', managed_branch_ids: ['b2', 'b3'], branch_id: 'b2' },
    t1: { role: 'teacher', managed_branch_ids: [], branch_id: 'b4' },
  };
  const req = (id, method) => ({ method, user: { id, role: 'x' } });

  eq(await resolveBranchScope(req('v1', 'GET')), null, 'צופה קורא — כל הסניפים');
  eq(await resolveBranchScope(req('v1', 'PATCH')), ['b1'], 'צופה כותב — רק הסניפים שבניהולו');
  eq(await resolveBranchScope(req('v0', 'GET')), null, 'צופה בלי סניפים קורא — כל הסניפים');
  eq(await resolveBranchScope(req('v0', 'POST')), [], 'צופה בלי סניפים כותב — אף סניף (לא הסניף האישי)');
  eq(await resolveBranchScope(req('a1', 'POST')), null, 'מנהל מערכת — ללא שינוי');
  eq(await resolveBranchScope(req('m1', 'POST')), ['b2', 'b3'], 'מנהל סניף — ללא שינוי');
  eq(await resolveBranchScope(req('t1', 'GET')), ['b4'], 'גננת — ללא שינוי');

  console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
  process.exit(failures ? 1 : 0);
})();
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `cd server && node scripts/viewer-require-role.test.js; node scripts/viewer-branch-scope.test.js`
Expected: gate test prints `❌` on every viewer line (403 where 202/next expected); scope test prints `❌` on the viewer lines.

- [ ] **Step 4: Implement `requireRole` and `requireBranchScope`**

In `server/src/middleware/auth.js`, add after the `env` require at the top:

```js
const {
  isRead, isViewer, isBlockedForViewer, isMultipart,
} = require('../utils/viewer');
const { ADMIN_VIEWER } = require('../constants/roles');
```

Replace the whole `requireRole` function with:

```js
const DENIED = { error: 'אין לך הרשאה לפעולה זו' };
const NO_UPLOAD = {
  error: 'אי אפשר לשמור העלאת קובץ לאישור. העלאה אפשרית רק בסניפים שבניהולך — או דרך מנהל המערכת.',
  code: 'VIEWER_NO_UPLOAD',
};

/** Queue this write for approval. Lazy require: the service loads the models. */
function proposeInstead(req, res) {
  const { propose } = require('../services/proposedChanges.service');
  return propose(req, res).catch((err) => {
    if (!res.headersSent) res.status(500).json({ error: 'שמירת השינוי לאישור נכשלה', detail: err.message });
  });
}

/**
 * Under the manager fallback (below), a controller that answers 403 is saying
 * "not one of your branches". For a viewer that is not a refusal — it is the
 * case that goes to approval. Swap res.json once; anything but a 403 passes
 * through untouched, and an upload stays refused because a file cannot be
 * stored for later.
 */
function convert403ToProposal(req, res) {
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    if (res.statusCode !== 403 || res.headersSent) return originalJson(body);
    res.json = originalJson;
    req.user.role = ADMIN_VIEWER;
    delete req.viewerFallback;
    if (isMultipart(req)) return originalJson(NO_UPLOAD);
    res.statusCode = 200;
    proposeInstead(req, res);
    return res;
  };
}

/**
 * Role-based access control middleware factory
 * Usage: requireRole('system_admin', 'branch_manager')
 *
 * The viewer role ("מנהל מערכת - לצפייה בלבד") is decided here and only here:
 *   reads  — wherever a system admin may read, except /api/admin;
 *   writes — as a branch manager when the route allows managers and the
 *            viewer has managed branches (the controller's own scope check
 *            then decides, and its 403 becomes a proposal); refused for
 *            /api/admin and for uploads; queued for approval otherwise.
 * Every other role: the plain list check, as before.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (isViewer(req.user)) {
      if (isBlockedForViewer(req.originalUrl)) return res.status(403).json(DENIED);
      if (isRead(req)) {
        if (roles.includes('system_admin') || roles.includes(ADMIN_VIEWER)) return next();
        return res.status(403).json(DENIED);
      }
      const managed = req.user.managed_branch_ids || [];
      if (roles.includes('branch_manager') && managed.length > 0) {
        req.user.role = 'branch_manager';
        req.viewerFallback = true;
        convert403ToProposal(req, res);
        return next();
      }
      if (isMultipart(req)) return res.status(403).json(NO_UPLOAD);
      return proposeInstead(req, res);
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json(DENIED);
    }
    next();
  };
}
```

In `requireBranchScope`, change the role line to:
```js
  if (role === 'system_admin' || role === 'accountant' || role === 'branch_manager' || role === ADMIN_VIEWER) return next();
```

- [ ] **Step 5: Implement `resolveBranchScope`**

In `server/src/utils/branch-scope.js` add at the top:
```js
const { isRead } = require('./viewer');
const { ADMIN_VIEWER } = require('../constants/roles');
```
and replace the three closing lines of `resolveBranchScope` with:
```js
  if (role === 'system_admin' || role === 'accountant') return null;
  // The viewer reads every branch and writes only the ones she manages. A
  // viewer with no managed branches writes nowhere — her own branch_id is
  // where she is listed, not what she runs.
  if (role === ADMIN_VIEWER) return isRead(req) ? null : managed;
  if (managed.length) return managed;
  return ownBranch ? [ownBranch] : [];
```

- [ ] **Step 6: Run the tests**

Add to `server/package.json` scripts:
`"test:viewer-gate": "node scripts/viewer-require-role.test.js",` and `"test:viewer-scope": "node scripts/viewer-branch-scope.test.js",`

Run: `cd server && node scripts/viewer-require-role.test.js && node scripts/viewer-branch-scope.test.js`
Expected: all `✅`, both exit 0. Then run the older gate-adjacent suite to prove nothing moved: `cd server && node scripts/punch-approval-stage.test.js && node scripts/my-decisions.test.js` — expected: all `✅`.

- [ ] **Step 7: Commit**

```bash
git add server/src/middleware/auth.js server/src/utils/branch-scope.js server/scripts/viewer-require-role.test.js server/scripts/viewer-branch-scope.test.js server/package.json
git commit -m "feat(viewer): requireRole reads as admin, writes as manager or proposes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Applying an approved proposal (replay) + routes

**Files:**
- Modify: `server/src/services/proposedChanges.service.js` (add `applyProposal`, `mintApproverToken`)
- Create: `server/src/controllers/proposedChanges.controller.js`, `server/src/routes/proposedChanges.routes.js`
- Modify: `server/src/routes/index.js` (mount `/proposed-changes` right after the `/rate-changes` line)
- Test: `server/scripts/proposed-change-apply.test.js`
- Modify: `server/package.json` (add `"test:proposed-apply"`)

**Interfaces:**
- Consumes: `ProposedChange` (Task 3), `env.PORT`, `env.JWT_SECRET`, `jsonwebtoken`.
- Produces:
  - `mintApproverToken(approverUser, tenantSlug)` → JWT string, 5-minute expiry, payload `{ id, email, full_name, role, branch_id, managed_branch_ids, replay: true, tenant }`.
  - `applyProposal(doc, approverUser, { fetchImpl = global.fetch, baseUrl = 'http://127.0.0.1:' + env.PORT, tenantSlug = undefined } = {})` → `{ status: number, ok: boolean, error: string }`; performs the HTTP replay only, does not touch the DB.
  - Routes: `GET /api/proposed-changes?status=` (viewer: own only; admin/accountant: all), `GET /api/proposed-changes/count` → `{ pending_count }`, `POST /api/proposed-changes/:id/decide { decision: 'approve'|'reject', note }` → `{ proposal }`; `POST /api/proposed-changes/:id/retry` re-applies a `failed` one.

- [ ] **Step 1: Write the failing replay test**

```js
#!/usr/bin/env node
/**
 * Approving a proposal re-issues the stored request as the approver, at the
 * same address and host it came to. The replay's answer is the proposal's
 * fate: 2xx applied, anything else failed-with-reason.
 *
 *   node scripts/proposed-change-apply.test.js
 */
const jwt = require('jsonwebtoken');
const env = require('../src/config/env');
const { applyProposal, mintApproverToken } = require('../src/services/proposedChanges.service');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

(async () => {
  console.log('\n🔁 הפעלת שינוי מאושר\n');

  const approver = { id: 'acc1', email: 'a@x', full_name: 'רו"ח', role: 'accountant', branch_id: null, managed_branch_ids: [] };
  const doc = {
    _id: 'pc1', method: 'PATCH', path: '/api/employees/e9?x=1', host: 'gan-halomot.onrender.com',
    body: { full_name: 'דנה' }, content_type: 'application/json',
  };

  console.log('הטוקן');
  {
    const token = mintApproverToken(approver, 'demo');
    const payload = jwt.verify(token, env.JWT_SECRET);
    eq(payload.role, 'accountant', 'בתפקיד המאשר');
    eq(payload.id, 'acc1', 'ובזהותו');
    eq(payload.replay, true, 'מסומן כהפעלה חוזרת');
    eq(payload.tenant, 'demo', 'עם הלקוח');
    ok(payload.exp - payload.iat === 300, 'תוקף 5 דקות');
  }

  console.log('\nהבקשה שנשלחת');
  {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { status: 200, text: async () => '{"ok":true}' }; };
    const r = await applyProposal(doc, approver, { fetchImpl, baseUrl: 'http://127.0.0.1:3001', tenantSlug: 'demo' });
    eq(r, { status: 200, ok: true, error: '' }, '2xx → הצליח');
    eq(calls[0].url, 'http://127.0.0.1:3001/api/employees/e9?x=1', 'לאותו נתיב, כולל השאילתה, מול השרת עצמו');
    eq(calls[0].init.method, 'PATCH', 'באותה שיטה');
    eq(calls[0].init.headers.Host, 'gan-halomot.onrender.com', 'עם המארח המקורי');
    eq(calls[0].init.headers['Content-Type'], 'application/json', 'JSON');
    eq(calls[0].init.headers['X-Proposed-Change'], 'pc1', 'מסומן במזהה ההצעה');
    ok(calls[0].init.headers.Authorization.startsWith('Bearer '), 'עם טוקן');
    eq(jwt.verify(calls[0].init.headers.Authorization.slice(7), env.JWT_SECRET).role, 'accountant', 'של המאשר');
    eq(calls[0].init.body, JSON.stringify({ full_name: 'דנה' }), 'והגוף השמור');
  }
  {
    const fetchImpl = async () => ({ status: 200, text: async () => '' });
    const r = await applyProposal({ ...doc, method: 'DELETE', body: null }, approver, { fetchImpl, baseUrl: 'http://127.0.0.1:1' });
    eq(r.ok, true, 'מחיקה בלי גוף — עובר');
  }

  console.log('\nכישלונות');
  {
    const fetchImpl = async () => ({ status: 409, text: async () => '{"error":"החודש נעול"}' });
    const r = await applyProposal(doc, approver, { fetchImpl, baseUrl: 'http://127.0.0.1:1' });
    eq(r, { status: 409, ok: false, error: 'החודש נעול' }, 'תשובה שאינה 2xx → נכשל, עם הודעת השרת');
  }
  {
    const fetchImpl = async () => ({ status: 500, text: async () => 'not json' });
    const r = await applyProposal(doc, approver, { fetchImpl, baseUrl: 'http://127.0.0.1:1' });
    eq(r, { status: 500, ok: false, error: 'not json' }, 'גוף שאינו JSON — הטקסט עצמו');
  }
  {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const r = await applyProposal(doc, approver, { fetchImpl, baseUrl: 'http://127.0.0.1:1' });
    eq(r, { status: 0, ok: false, error: 'ECONNREFUSED' }, 'אין חיבור → 0 עם השגיאה');
  }

  console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
  process.exit(failures ? 1 : 0);
})();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node scripts/proposed-change-apply.test.js`
Expected: `TypeError: mintApproverToken is not a function` (or `applyProposal`).

- [ ] **Step 3: Add `mintApproverToken` and `applyProposal` to the service**

Append to `server/src/services/proposedChanges.service.js` (and add the requires at the top):

```js
const jwt = require('jsonwebtoken');
const env = require('../config/env');
```

```js
/**
 * A token for one replay: the approver's identity, five minutes, flagged.
 * Minted here rather than borrowed from the approver's own session so the
 * replay can run from a job later without a browser attached.
 */
function mintApproverToken(user, tenantSlug) {
  const payload = {
    id: user.id || user._id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    branch_id: user.branch_id || null,
    managed_branch_ids: (user.managed_branch_ids || []).map(String),
    replay: true,
    tenant: tenantSlug,
  };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: 300 });
}

/**
 * Re-issue the stored request against this server as the approver.
 * Returns { status, ok, error } and never throws. Does not touch the DB.
 */
async function applyProposal(doc, approver, {
  fetchImpl = global.fetch, baseUrl = `http://127.0.0.1:${env.PORT}`, tenantSlug = undefined,
} = {}) {
  const headers = {
    Authorization: `Bearer ${mintApproverToken(approver, tenantSlug)}`,
    'X-Proposed-Change': String(doc._id),
  };
  if (doc.host) headers.Host = doc.host;
  const init = { method: doc.method, headers };
  if (doc.body !== null && doc.body !== undefined && !['GET', 'HEAD'].includes(doc.method)) {
    headers['Content-Type'] = doc.content_type || 'application/json';
    init.body = JSON.stringify(doc.body);
  }
  try {
    const resp = await fetchImpl(`${baseUrl}${doc.path}`, init);
    const text = await resp.text();
    const ok = resp.status >= 200 && resp.status < 300;
    let error = '';
    if (!ok) {
      try { error = JSON.parse(text)?.error || text; } catch { error = text; }
    }
    return { status: resp.status, ok, error };
  } catch (err) {
    return { status: 0, ok: false, error: err.message };
  }
}

module.exports = { propose, applyProposal, mintApproverToken };
```

(Replace the earlier `module.exports = { propose };` line.)

Note: Node's `fetch` forbids setting `Host` in some versions (it is a forbidden header in undici for browser parity but **allowed** in Node's undici for server use as of Node 18.x; if the replay logs `Host` being dropped, fall back to `undici.request` — check with `node -e "fetch('http://127.0.0.1:1',{headers:{Host:'x'}}).catch(e=>console.log(e.message))"` which must print a connection error, not a header error). Tenant resolution only matters on the GanFlow platform; on the gan's own server `req.tenant` is absent and the `Host` header is decoration.

- [ ] **Step 4: Controller and routes**

`server/src/controllers/proposedChanges.controller.js`:

```js
const { ProposedChange, User } = require('../models');
const { applyProposal } = require('../services/proposedChanges.service');
const { ADMIN_VIEWER } = require('../constants/roles');

function decides(user) {
  return user?.role === 'system_admin' || user?.role === 'accountant';
}

/** GET /api/proposed-changes?status=pending  — approvers: all; viewer: own. */
async function list(req, res, next) {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (!decides(req.user)) filter.requested_by = req.user.id;
    const items = await ProposedChange.find(filter).sort({ created_at: -1 }).limit(200).lean();
    const pending_count = decides(req.user) ? await ProposedChange.countDocuments({ status: 'pending' }) : 0;
    res.json({ items, pending_count });
  } catch (err) { next(err); }
}

/** GET /api/proposed-changes/count */
async function count(req, res, next) {
  try {
    const pending_count = await ProposedChange.countDocuments({ status: 'pending' });
    res.json({ pending_count });
  } catch (err) { next(err); }
}

async function runApply(doc, req) {
  const approver = await User.findById(req.user.id)
    .select('email full_name role branch_id managed_branch_ids').lean();
  const result = await applyProposal(doc, { ...approver, id: String(approver._id) }, {
    tenantSlug: req.tenant ? req.tenant.slug : undefined,
  });
  doc.apply_status = result.status;
  doc.apply_error = result.ok ? '' : result.error;
  doc.status = result.ok ? 'approved' : 'failed';
}

/** POST /api/proposed-changes/:id/decide { decision: 'approve'|'reject', note } */
async function decide(req, res, next) {
  try {
    const { decision, note } = req.body || {};
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'decision חייב להיות approve או reject' });
    }
    const doc = await ProposedChange.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ההצעה לא נמצאה' });
    if (doc.status !== 'pending') return res.status(409).json({ error: 'ההצעה כבר הוכרעה' });

    doc.decided_by = req.user.id;
    doc.decided_by_name = req.user.full_name || '';
    doc.decided_at = new Date();
    doc.decision_note = note || '';
    if (decision === 'reject') {
      doc.status = 'rejected';
    } else {
      await runApply(doc, req);
    }
    await doc.save();
    res.json({ proposal: doc });
  } catch (err) { next(err); }
}

/** POST /api/proposed-changes/:id/retry — a failed apply, tried again. */
async function retry(req, res, next) {
  try {
    const doc = await ProposedChange.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ההצעה לא נמצאה' });
    if (doc.status !== 'failed') return res.status(409).json({ error: 'אפשר לנסות שוב רק הצעה שנכשלה' });
    doc.decided_by = req.user.id;
    doc.decided_by_name = req.user.full_name || '';
    doc.decided_at = new Date();
    await runApply(doc, req);
    await doc.save();
    res.json({ proposal: doc });
  } catch (err) { next(err); }
}

module.exports = { list, count, decide, retry, ADMIN_VIEWER };
```

`server/src/routes/proposedChanges.routes.js`:

```js
const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');
const c = require('../controllers/proposedChanges.controller');

// Mounted below the global authMiddleware in routes/index.js.
// A viewer lists her own; the office lists and decides everything.
router.get('/', requireRole('system_admin', 'accountant', 'admin_viewer'), c.list);
router.get('/count', requireRole('system_admin', 'accountant'), c.count);
router.post('/:id/decide', requireRole('system_admin', 'accountant'), c.decide);
router.post('/:id/retry', requireRole('system_admin', 'accountant'), c.retry);

module.exports = router;
```

In `server/src/routes/index.js`, directly after the line `router.use('/rate-changes', require('./rateChangeRequests.routes'));` add:
```js
// שינויים לאישור — writes a viewer ("מנהל מערכת - לצפייה בלבד") asked for.
router.use('/proposed-changes', require('./proposedChanges.routes'));
```

Note on `requireRole('…', 'admin_viewer')` for the viewer's own list: Task 4's read rule passes a viewer when `roles` includes `system_admin` **or** `ADMIN_VIEWER`; listing is a GET so either works. The write routes stay office-only; a viewer POSTing `/decide` is a write on a route without `branch_manager` → it would be *proposed*, which is absurd. Add to `utils/viewer.js` `BLOCKED_PREFIXES` the entry `'/api/proposed-changes/'` **only for writes**: simplest is a second list `WRITE_BLOCKED_PREFIXES = ['/api/proposed-changes']` and a helper `isWriteBlockedForViewer(url)`; in `requireRole`, before rule 5, `if (isWriteBlockedForViewer(req.originalUrl)) return res.status(403).json(DENIED);`. Add a test line to `viewer-helpers.test.js` (`ok(v.isWriteBlockedForViewer('/api/proposed-changes/1/decide'))`, `ok(!v.isWriteBlockedForViewer('/api/employees'))`) and to `viewer-require-role.test.js` (viewer POST `/api/proposed-changes/1/decide` under `requireRole('system_admin','accountant')` → 403, no proposal).

- [ ] **Step 5: Run the tests and boot check**

Add to `server/package.json` scripts: `"test:proposed-apply": "node scripts/proposed-change-apply.test.js",`

Run: `cd server && node scripts/proposed-change-apply.test.js && node scripts/viewer-helpers.test.js && node scripts/viewer-require-role.test.js`
Expected: all `✅`.
Boot check: `cd server && node -e "require('./src/routes/index.js')"` — expected exit 0 (routes load without a DB connection).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/proposedChanges.service.js server/src/controllers/proposedChanges.controller.js server/src/routes/proposedChanges.routes.js server/src/routes/index.js server/src/utils/viewer.js server/scripts/proposed-change-apply.test.js server/scripts/viewer-helpers.test.js server/scripts/viewer-require-role.test.js server/package.json
git commit -m "feat(viewer): decide proposals — approve replays the request as the approver

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Payroll change requests accept a viewer for every branch; decisions list proposals

**Files:**
- Modify: `server/src/controllers/payrollMonth.controller.js:3297-3390` (`createChangeRequest`, `listChangeRequests`)
- Modify: `server/src/controllers/decisions.controller.js:15`, `:57-77`, and the `items` loops (add a fifth source)
- Test: `server/scripts/proposed-change-decisions.test.js`
- Modify: `server/package.json` (add `"test:proposed-decisions"`)

**Interfaces:**
- Consumes: `ProposedChange` model; `ADMIN_VIEWER`.
- Produces: `decisions.controller.js` exports a new pure function `proposalToDecisionItem(doc)` → `{ id, kind: 'proposed', kind_label: 'שינוי לאישור', title, status, status_label, decided_at, decided_by_name, note, lines }` where `title = screen_label + (branch_name ? ' · ' + branch_name : '')`, `status_label` maps `approved→'אושרה'`, `rejected→'נדחתה'`, `failed→'נכשלה'`, `lines = summary.map(r => ({ label: r.label, who: '', from: '', to: r.value, decision: status }))`, and for `failed` `note = apply_error` when `decision_note` is empty.

- [ ] **Step 1: Write the failing test**

```js
#!/usr/bin/env node
/**
 * A decided proposal shows up in "ההחלטות שלי" like any other request the
 * viewer made — same card, same words — and a replay that failed says why.
 *
 *   node scripts/proposed-change-decisions.test.js
 */
const { proposalToDecisionItem } = require('../src/controllers/decisions.controller');

let failures = 0;
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

console.log('\n🗂️ הצעה כפריט החלטה\n');
const base = {
  _id: 'p1', screen_label: 'עובדים', branch_name: 'תל אביב', decided_at: '2026-09-07T08:00:00.000Z',
  decided_by_name: 'רו"ח', decision_note: '', apply_error: '',
  summary: [{ key: 'full_name', label: 'שם מלא', value: 'דנה' }],
};
eq(proposalToDecisionItem({ ...base, status: 'approved' }), {
  id: 'p1', kind: 'proposed', kind_label: 'שינוי לאישור', title: 'עובדים · תל אביב',
  status: 'approved', status_label: 'אושרה', decided_at: '2026-09-07T08:00:00.000Z',
  decided_by_name: 'רו"ח', note: '',
  lines: [{ label: 'שם מלא', who: '', from: '', to: 'דנה', decision: 'approved' }],
}, 'אושרה');
eq(proposalToDecisionItem({ ...base, status: 'rejected', decision_note: 'לא עכשיו' }).note, 'לא עכשיו', 'נדחתה עם הערה');
eq(proposalToDecisionItem({ ...base, status: 'rejected' }).status_label, 'נדחתה', 'תווית דחייה');
eq(proposalToDecisionItem({ ...base, status: 'failed', apply_error: 'החודש נעול' }).note, 'החודש נעול', 'נכשלה — הסיבה היא ההערה');
eq(proposalToDecisionItem({ ...base, status: 'failed', apply_error: 'x' }).status_label, 'נכשלה', 'תווית כישלון');
eq(proposalToDecisionItem({ ...base, branch_name: '', status: 'approved' }).title, 'עובדים', 'בלי סניף — רק המסך');

console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node scripts/proposed-change-decisions.test.js`
Expected: `TypeError: proposalToDecisionItem is not a function`.

- [ ] **Step 3: Add the fifth source to decisions**

In `server/src/controllers/decisions.controller.js`:

Change the models require to include `ProposedChange`:
```js
const {
  PayrollChangeRequest, EmployeeChangeRequest, RateChangeRequest, Employee, User, Punch, ProposedChange,
} = require('../models');
```

Extend `HE_STATUS` with `failed: 'נכשלה',`.

Add after `showValue`:
```js
/** A decided proposal (a viewer's queued write) as one card on this screen. */
function proposalToDecisionItem(p) {
  const note = p.decision_note || (p.status === 'failed' ? (p.apply_error || '') : '');
  return {
    id: String(p._id),
    kind: 'proposed',
    kind_label: 'שינוי לאישור',
    title: `${p.screen_label || 'מסך אחר'}${p.branch_name ? ` · ${p.branch_name}` : ''}`,
    status: p.status,
    status_label: HE_STATUS[p.status] || p.status,
    decided_at: p.decided_at,
    decided_by_name: p.decided_by_name || '',
    note,
    lines: (p.summary || []).map(r => ({ label: r.label, who: '', from: '', to: r.value, decision: p.status })),
  };
}
```

In `myDecisions`, change the `Promise.all` destructuring to `const [payroll, employee, rates, proposals] = await Promise.all([` and append a fourth query after the `RateChangeRequest.find(...)` entry:
```js
      ProposedChange.find({
        requested_by: userId,
        status: { $in: ['approved', 'rejected', 'failed'] },
        decided_at: { $gte: since },
      }).sort({ decided_at: -1 }).limit(100).lean(),
```
After the `for (const r of rates) { … }` loop add:
```js
    for (const p of proposals) items.push(proposalToDecisionItem(p));
```
Add `proposalToDecisionItem` to the file's `module.exports` (keep `showValue`, `myDecisions`, `markSeen` as they are — check the current export line with `grep -n "module.exports" server/src/controllers/decisions.controller.js`).

- [ ] **Step 4: Let a viewer file payroll change requests for any branch**

In `server/src/controllers/payrollMonth.controller.js`, add near `decidesPayroll` (line ~2212):
```js
const { ADMIN_VIEWER } = require('../constants/roles');
/** The viewer files for every branch: the approval is the gate, not the scope. */
function filesForAllBranches(user) {
  return user?.role === ADMIN_VIEWER;
}
```
(put the `require` with the other requires at the top of the file, not mid-file).

In `createChangeRequest` change
```js
    if (!decidesPayroll(req.user)) {
```
to
```js
    if (!decidesPayroll(req.user) && !filesForAllBranches(req.user)) {
```
Also the submitter's branch: for a viewer with no managed branch `submitterBranchId` becomes `req.user.branch_id`, which is fine (it labels the card; the rows carry their own `branch_id`).

`listChangeRequests` needs no change: `isReviewer` is false for a viewer so it lists her own requests.

Important: this request arrives at `POST /payroll-month/change-requests` guarded by `requireBranchScope` (Task 4 lets the viewer through) — **not** `requireRole` — so the viewer's `req.user.role` is still `admin_viewer` here, which is what `filesForAllBranches` reads.

- [ ] **Step 5: Run the tests**

Add to `server/package.json` scripts: `"test:proposed-decisions": "node scripts/proposed-change-decisions.test.js",`

Run: `cd server && node scripts/proposed-change-decisions.test.js && node scripts/my-decisions.test.js`
Expected: all `✅`. Boot: `cd server && node -e "require('./src/controllers/payrollMonth.controller'); require('./src/controllers/decisions.controller')"` exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/controllers/payrollMonth.controller.js server/src/controllers/decisions.controller.js server/scripts/proposed-change-decisions.test.js server/package.json
git commit -m "feat(viewer): payroll change requests for any branch; proposals in my decisions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Client foundation — auth flags, tabs, labels, route guards, 202 toast

**Files:**
- Modify: `client/src/hooks/useAuth.jsx:103-113`
- Modify: `client/src/config/tabs.js` (every `defaultRoles` containing `'system_admin'`)
- Modify: `client/src/components/admin/PermissionsManager.jsx:17-25`
- Modify: `client/src/App.jsx` (every `roles={[…'system_admin'…]}` except `admin/permissions` and `account`)
- Modify: `client/src/components/payroll/PayrollPage.jsx:31-41` (every `roles` containing `'system_admin'` except `settings`)
- Modify: `client/src/api/client.js:27-28` (add a success interceptor)

**Interfaces:**
- Produces from `useAuth()`: `isViewer` (boolean), `managesBranch(branchId)` (admin → true; otherwise `managed_branch_ids` includes `String(branchId)`), and `canSeeAllBranches` now `|| isViewer`.

- [ ] **Step 1: useAuth**

In `client/src/hooks/useAuth.jsx` replace the block from `const isAdmin = …` through the `canSeeAllBranches` line with:

```js
  const isAdmin = user?.role === 'system_admin';
  const isAccountant = user?.role === 'accountant';
  // "מנהל מערכת - לצפייה בלבד": reads what the admin reads across every
  // branch; acts as a branch manager inside managed_branch_ids; every other
  // write is queued for approval by the server (202 {proposed:true}).
  const isViewer = user?.role === 'admin_viewer';
  const isManager = user?.role === 'branch_manager' || isAdmin;
  // Can use the cross-branch "כל הסניפים" view: admins always; accountants
  // (they need cross-branch payroll consolidation); managers who oversee
  // more than one branch (multi-branch heads like Lidor); viewers always.
  const canSeeAllBranches = isAdmin || isAccountant || isViewer || (user?.managed_branch_ids?.length || 0) > 1;
  /** May this person edit rows of this branch directly? */
  const managesBranch = (branchId) => isAdmin
    || (user?.managed_branch_ids || []).map(String).includes(String(branchId));
```
and add `isViewer, managesBranch` to the `AuthContext.Provider value={{ … }}` object.

- [ ] **Step 2: tabs.js**

Run from the repo root:
```bash
grep -n "'system_admin'" client/src/config/tabs.js | wc -l
```
Note the count (N). Then, in every `defaultRoles: [...]` array in `client/src/config/tabs.js` that contains `'system_admin'`, add `'admin_viewer'` immediately after `'system_admin'`. Do it with an editor, not sed, because two tabs sit on multi-line entries. Verify:
```bash
grep -c "'admin_viewer'" client/src/config/tabs.js
```
must equal N. Add a comment above `TAB_GROUPS`:
```js
// 'admin_viewer' (מנהל מערכת - לצפייה בלבד) is listed wherever 'system_admin'
// is: the viewer sees every screen the admin sees. Edit rights are decided by
// the server per request, not by the tab.
```

- [ ] **Step 3: Role label**

In `client/src/components/admin/PermissionsManager.jsx` `ROLE_LABELS` add after the `system_admin` line:
```js
  admin_viewer: 'מנהל מערכת - לצפייה בלבד',
```
At `:368` and `:486` (chip colours) leave as they are — the viewer chip renders `default`.

- [ ] **Step 4: Route guards**

In `client/src/App.jsx`: for every `<ProtectedRoute roles={[…]}>` whose array contains `'system_admin'`, add `'admin_viewer'` after it — **except** the two routes `admin/permissions` and `account`, which stay `['system_admin']`. Check with:
```bash
grep -n "roles={\[" client/src/App.jsx
```
Every line that lists `'system_admin'` must now also list `'admin_viewer'`, except the two above.

In `client/src/components/payroll/PayrollPage.jsx` `TABS`: add `'admin_viewer'` after `'system_admin'` in every `roles` array **except** `settings`. Then find where `TABS` is filtered by role (search `roles.includes` in that file) and confirm it reads `user.role` — no change needed if so.

- [ ] **Step 5: The 202 toast**

In `client/src/api/client.js` replace the success handler of the response interceptor:
```js
api.interceptors.response.use(
  (response) => response,
```
with
```js
api.interceptors.response.use(
  (response) => {
    // A viewer's write was queued for approval instead of made. The screen
    // sees a success; the person sees why nothing changed yet.
    if (response?.status === 202 && response?.data?.proposed === true) {
      import('react-toastify')
        .then(({ toast }) => toast.info(response.data.message || 'השינוי נשמר וממתין לאישור', { autoClose: 7000 }))
        .catch(() => {});
    }
    return response;
  },
```

- [ ] **Step 6: Build**

Run: `cd client && npm run build 2>&1 | tail -5`
Expected: build succeeds (no `error` lines). If the project uses `npm run lint`, run it too and fix what it reports in the touched files only.

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/useAuth.jsx client/src/config/tabs.js client/src/components/admin/PermissionsManager.jsx client/src/App.jsx client/src/components/payroll/PayrollPage.jsx client/src/api/client.js
git commit -m "feat(viewer): client knows the admin_viewer role — tabs, guards, labels, 202 toast

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The approver screen "שינויים לאישור" + nav badge

**Files:**
- Create: `client/src/components/admin/ProposedChanges.jsx`
- Create: `client/src/hooks/usePendingProposals.js`
- Modify: `client/src/config/tabs.js` (new tab in group ניהול, after `collections`)
- Modify: `client/src/App.jsx` (route `proposed-changes`)
- Modify: `client/src/components/layout/Header.jsx:234-245` and the mobile list at `:366+` (badge on the menu item)

**Interfaces:**
- Consumes: `GET /api/proposed-changes?status=`, `GET /api/proposed-changes/count`, `POST /api/proposed-changes/:id/decide`, `POST /api/proposed-changes/:id/retry` (Task 5).
- Produces: `usePendingProposals()` → `number` (0 when the user is not admin/accountant), polled every 60s.

- [ ] **Step 1: Tab and route**

In `client/src/config/tabs.js`, in the ניהול group right after the `collections` entry add:
```js
      // שינויים שביקש "מנהל מערכת - לצפייה בלבד" ומחכים למשרד. The viewer
      // sees his own list on the same screen.
      { id: 'proposed_changes', label: 'שינויים לאישור', path: '/proposed-changes', defaultRoles: ['system_admin', 'accountant', 'admin_viewer'] },
```
In `client/src/App.jsx` import `ProposedChanges from './components/admin/ProposedChanges'` next to the `PermissionsManager` import and add, before the `admin/permissions` route:
```jsx
        <Route path="proposed-changes" element={
          <ProtectedRoute tab="proposed_changes">
            <ProposedChanges />
          </ProtectedRoute>
        } />
```
In `client/src/components/layout/Header.jsx`, `ICON_BY_TAB` (search for it) — add `proposed_changes: RuleFolderIcon` importing `RuleFolderIcon from '@mui/icons-material/RuleFolder'` if not already imported.

- [ ] **Step 2: The polling hook**

`client/src/hooks/usePendingProposals.js`:
```js
import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from './useAuth';

/** How many viewer proposals wait for the office. 0 for everyone else. */
export function usePendingProposals() {
  const { isAdmin, isAccountant } = useAuth();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!(isAdmin || isAccountant)) { setCount(0); return undefined; }
    let alive = true;
    const load = () => api.get('/proposed-changes/count')
      .then(res => { if (alive) setCount(res.data.pending_count || 0); })
      .catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [isAdmin, isAccountant]);
  return count;
}
```

- [ ] **Step 3: Badge in the nav**

In `Header.jsx`, import `Badge` from `@mui/material` (add to the existing import) and `import { usePendingProposals } from '../../hooks/usePendingProposals';`. Inside the component body (near where `useAuth()` is called) add `const pendingProposals = usePendingProposals();`. In **both** places that render `{item.label}` inside a menu item (desktop menu ~line 244 and the mobile list ~line 380), replace `{item.label}` with:
```jsx
                        {item.id === 'proposed_changes' && pendingProposals > 0
                          ? <Badge badgeContent={pendingProposals} color="error" sx={{ '& .MuiBadge-badge': { right: -14 } }}>{item.label}</Badge>
                          : item.label}
```

- [ ] **Step 4: The screen**

`client/src/components/admin/ProposedChanges.jsx`:

```jsx
import { useCallback, useEffect, useState } from 'react';
import {
  Box, Typography, Stack, Card, CardContent, Button, Chip, Tabs, Tab,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer, Paper,
  TextField, Alert, CircularProgress,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import ReplayIcon from '@mui/icons-material/Replay';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

/**
 * Writes a viewer ("מנהל מערכת - לצפייה בלבד") asked for and may not make.
 * The office approves — which re-issues the request as the approver — or
 * rejects with a note. A replay that failed stays here with the server's
 * reason and a retry.
 */
const STATUS = {
  pending: { label: 'ממתין', color: 'warning' },
  approved: { label: 'אושר', color: 'success' },
  rejected: { label: 'נדחה', color: 'error' },
  failed: { label: 'נכשל', color: 'error' },
};
const APPROVER = { accountant: 'הנה"ח', system_admin: 'מנהל המערכת' };

function ProposalCard({ item, canDecide, onDecided }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const st = STATUS[item.status] || { label: item.status, color: 'default' };

  const act = async (path, body) => {
    setBusy(true);
    try {
      const res = await api.post(`/proposed-changes/${item._id}/${path}`, body);
      const p = res.data.proposal;
      if (p.status === 'approved') toast.success('השינוי בוצע');
      else if (p.status === 'rejected') toast.info('ההצעה נדחתה');
      else toast.error(`הביצוע נכשל: ${p.apply_error || 'שגיאה'}`);
      onDecided(p);
    } catch (err) {
      toast.error(err.response?.data?.error || 'הפעולה נכשלה');
    } finally { setBusy(false); }
  };

  return (
    <Card variant="outlined" sx={{ mb: 1.5 }}>
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" sx={{ mb: 1 }}>
          <Typography sx={{ fontWeight: 800 }}>{item.screen_label || 'מסך אחר'}</Typography>
          {item.branch_name && <Chip size="small" label={item.branch_name} />}
          <Chip size="small" color={st.color} label={st.label} />
          <Chip size="small" variant="outlined" label={`ל${APPROVER[item.approver] || 'משרד'}`} />
          <Typography variant="body2" color="text.secondary">
            {item.requested_by_name} · {new Date(item.created_at).toLocaleString('he-IL')}
          </Typography>
          <Typography variant="caption" color="text.disabled" dir="ltr">{item.method} {item.path}</Typography>
        </Stack>

        {item.summary?.length > 0 ? (
          <TableContainer component={Paper} variant="outlined" sx={{ mb: 1 }}>
            <Table size="small">
              <TableHead><TableRow><TableCell>שדה</TableCell><TableCell>ערך מבוקש</TableCell></TableRow></TableHead>
              <TableBody>
                {item.summary.map(r => (
                  <TableRow key={r.key}><TableCell>{r.label}</TableCell><TableCell>{r.value}</TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <Alert severity="info" sx={{ mb: 1 }}>אין שדות להצגה (למשל מחיקה) — המסך והנתיב למעלה אומרים מה יקרה.</Alert>
        )}

        {item.status === 'failed' && (
          <Alert severity="error" sx={{ mb: 1 }}>הביצוע נכשל: {item.apply_error || 'שגיאה לא ידועה'}</Alert>
        )}
        {item.status !== 'pending' && item.status !== 'failed' && (
          <Typography variant="body2" color="text.secondary">
            {st.label} ע"י {item.decided_by_name || '—'} · {item.decided_at ? new Date(item.decided_at).toLocaleString('he-IL') : ''}
            {item.decision_note ? ` · ${item.decision_note}` : ''}
          </Typography>
        )}

        {canDecide && item.status === 'pending' && (
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <TextField size="small" label="הערה (לא חובה)" value={note} onChange={e => setNote(e.target.value)} sx={{ minWidth: 240 }} />
            <Button variant="contained" color="success" startIcon={<CheckCircleIcon />} disabled={busy}
              onClick={() => act('decide', { decision: 'approve', note })}>אשר ובצע</Button>
            <Button variant="outlined" color="error" startIcon={<CancelIcon />} disabled={busy}
              onClick={() => act('decide', { decision: 'reject', note })}>דחה</Button>
            {busy && <CircularProgress size={18} />}
          </Stack>
        )}
        {canDecide && item.status === 'failed' && (
          <Button variant="outlined" startIcon={<ReplayIcon />} disabled={busy} onClick={() => act('retry', {})}>נסה שוב</Button>
        )}
      </CardContent>
    </Card>
  );
}

export default function ProposedChanges() {
  const { isAdmin, isAccountant } = useAuth();
  const canDecide = isAdmin || isAccountant;
  const [tab, setTab] = useState('pending');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const params = tab === 'pending' ? { status: 'pending' } : {};
    api.get('/proposed-changes', { params })
      .then(res => setItems(tab === 'pending' ? res.data.items : res.data.items.filter(i => i.status !== 'pending')))
      .catch(() => toast.error('טעינת ההצעות נכשלה'))
      .finally(() => setLoading(false));
  }, [tab]);
  useEffect(() => { load(); }, [load]);

  const onDecided = (p) => setItems(list => list.map(i => (i._id === p._id ? p : i)).filter(i => tab !== 'pending' || i.status === 'pending' || i.status === 'failed'));

  return (
    <Box dir="rtl">
      <Typography variant="h5" sx={{ fontWeight: 800, mb: 1 }}>שינויים לאישור</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {canDecide
          ? 'שינויים שביקש מנהל מערכת לצפייה בלבד. אישור מבצע את השינוי בשמך; דחייה — לא.'
          : 'השינויים שביקשת ומצב האישור שלהם.'}
      </Typography>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab value="pending" label="ממתינים" />
        <Tab value="history" label="היסטוריה" />
      </Tabs>
      {loading ? <CircularProgress /> : items.length === 0
        ? <Alert severity="success">{tab === 'pending' ? 'אין שינויים שממתינים לאישור' : 'אין היסטוריה עדיין'}</Alert>
        : items.map(it => <ProposalCard key={it._id} item={it} canDecide={canDecide} onDecided={onDecided} />)}
    </Box>
  );
}
```

- [ ] **Step 5: Build and commit**

Run: `cd client && npm run build 2>&1 | tail -5` — expected: success.

```bash
git add client/src/components/admin/ProposedChanges.jsx client/src/hooks/usePendingProposals.js client/src/config/tabs.js client/src/App.jsx client/src/components/layout/Header.jsx
git commit -m "feat(viewer): the 'שינויים לאישור' screen and its nav badge

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Client sweep — the viewer sees what the admin sees

**Files:**
- Modify: `client/src/components/employees/EmployeeManager.jsx:989`
- Modify: `client/src/components/employees/Form101Center.jsx:623`
- Modify: `client/src/components/attendance/PunchEntryTaskGate.jsx:59`
- Review only (no change unless a *visibility* gate is found): every other `isAdmin` hit from `grep -rn "isAdmin" client/src/components`.

**Interfaces:** consumes `isViewer` from Task 7.

- [ ] **Step 1: Known visibility gates**

`EmployeeManager.jsx:989` — `{(isAdmin || isAllBranches) && (` shows the branch column. Change to `{(isAdmin || isViewer || isAllBranches) && (` and add `isViewer` to that component's `useAuth()` destructuring.

`Form101Center.jsx:623` — `const isAdmin = user?.role === 'system_admin' || user?.role === 'accountant';` gates the "סריקת מייל" settings tab. Change to `const isAdmin = ['system_admin', 'accountant', 'admin_viewer'].includes(user?.role);` (viewing settings is allowed; a save there will be proposed).

`PunchEntryTaskGate.jsx:59` — `relevant` for branch managers and admins: the gate nags about punch-entry tasks. Change to `['branch_manager', 'system_admin', 'admin_viewer'].includes(user.role)` so a viewer with a branch gets the same reminder.

- [ ] **Step 2: Review the rest**

Run: `grep -rn "isAdmin\|=== 'system_admin'" client/src/components client/src/hooks | grep -v "useAuth()"` and for each hit decide: *data visibility* → add the viewer; *edit/approve control or admin-only menu (Header 191/265/272/406/414/422, payroll settings, PermissionsManager)* → leave. Known edit gates to leave untouched: `DayPunchesDialog:60-61`, `PendingPunchApprovals:106,247`, `AttendanceMonitor:60,780`, `PayrollMonthTable:943,1088,1094,1916,2866-2901`, `VacationDetailDialog:214`, `EmployeeChangeRequests:33`, `RequestsManager:62-65`, `EmployeeManager:675,1361`, `adjustmentTypes.js:56`, `EmploymentContractDialog.jsx:37`. List in the commit body any additional visibility gate you changed.

- [ ] **Step 3: Build and commit**

Run: `cd client && npm run build 2>&1 | tail -5` — expected: success.

```bash
git add client/src/components/employees/EmployeeManager.jsx client/src/components/employees/Form101Center.jsx client/src/components/attendance/PunchEntryTaskGate.jsx
git commit -m "feat(viewer): the viewer sees the admin's columns and settings tabs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: End-to-end check against a local server, then the manual pass

**Files:** none new. Uses `server/.env` / local Mongo as the existing dev setup does (see `server/package.json` `dev` script and `server/src/config/env.js`).

- [ ] **Step 1: Run the whole viewer suite**

```bash
cd server && for t in viewer-role viewer-helpers proposed-propose viewer-gate viewer-scope proposed-apply proposed-decisions decisions punch-approval; do npm run -s test:$t || exit 1; done
```
Expected: every script ends with `✅ הכל עבר`.

- [ ] **Step 2: Live check with a test viewer**

Start the dev server and client the way the repo does (`.claude/launch.json` if present; otherwise `cd server && npm run dev` and `cd client && npm run dev`). In the permissions screen as the local admin, set a test user (not a real employee) to role "מנהל מערכת - לצפייה בלבד" with one managed branch. Log in as that user and verify, recording each result:

1. Menu shows every admin tab except הרשאות/משתמשים; "כל הסניפים" is in the branch selector.
2. `GET /api/admin/users` from the console returns 403.
3. Payroll table for a branch **not** managed: cells are editable, the toolbar offers "שלח לאישור", sending creates a request that the accountant sees under בקשות שינוי with the right branch.
4. Attendance fix in the managed branch → punch becomes `pending_accountant`. Same fix in another branch → toast "השינוי נשמר וממתין לאישור הנה"ח" and a card on שינויים לאישור.
5. As the admin: approve that card → the punch changes; reject another → nothing changes; both appear in the viewer's ההחלטות שלי popup.
6. Any settings save (e.g. pregnancy settings PUT) → toast, card routed to הנה"ח.
7. Upload a document outside the managed branch → error toast with the upload message; inside the managed branch → works.
8. Log in as each of: system_admin, accountant, branch_manager, teacher — one write each on their usual screen still works unchanged.

- [ ] **Step 3: Record and stop**

Write the outcome of every numbered check into the commit body below; anything failing gets fixed in its task's files with the same test-first steps before this commit.

```bash
git commit --allow-empty -m "test(viewer): manual pass of the admin_viewer role

1..8 results here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Do **not** merge to `main` or push `main`. Push the branch only: `git push -u origin feat/admin-viewer-role`. The deploy decision is the user's.
