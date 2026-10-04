# סידור עבודה שבועי — שלב 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekly staff-rota board for branch managers, seeded from each employee's commitment, with ratio warnings, closed days, class close/reopen, PDF/PNG export, publishing to employees with push, a Friday reminder, and management edits that need the branch manager's approval.

**Architecture:** One `ShiftWeek` document per branch per week holds a working copy (`entries`) and the last published snapshot (`published`). All rules that can be pure are pure functions in `server/src/services/shifts/` with node-script tests; one service file owns every DB write; a thin controller/route exposes it under `/api/shifts`. The client is one screen (`/shifts`) built from small components plus a shared `shiftRows.js` that turns entries into display rows (used by the board, the export and the employee screen).

**Tech Stack:** Express + Mongoose (server), React 18 + MUI 6 + Vite (client), `mongodb-memory-server` for DB tests, `html2canvas` for PNG, print window for PDF.

**Spec:** `docs/superpowers/specs/2026-10-04-shifts-phase1-design.md`

## Global Constraints

- Week = Sunday–Friday (6 dates). `week_start` is always a Sunday, `'YYYY-MM-DD'`.
- Fixed rows: `מטבח` (area `kitchen`), `מחליפות` (area `floater`), `ללא כיתה` (area `unassigned`, shown only while non-empty).
- Ratio defaults: branch name starts with `כפר סבא` → infants 5, young 7, older 9; otherwise infants 5, young 8, older 10. Warnings never block a save and are never shown to employees.
- Roles: edit = `branch_manager` for branches in `managed_branch_ids` (fallback `[branch_id]`). `system_admin` / `accountant` = view all + edit only through `ShiftEditRequest`. `admin_viewer` = view only. Employees = `['teacher','assistant','class_leader','cook']`, screen `/my-shifts` only.
- Phase 1 must not touch punches, payroll or `fixed_schedule`.
- Server tests are standalone node scripts in `server/scripts/<name>.test.js`, registered in `server/package.json` as `"test:<name>"`. They stub dotenv first (copy the 5-line block from any existing test).
- Every user-facing string is Hebrew. Code comments follow the repo's style: explain *why*.
- Client has no test runner — client tasks end with `npx vite build` passing and a manual check in the browser.
- Commit after every task, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

Server (create):
- `server/src/models/ShiftWeek.js` — the week document + Entry sub-schema.
- `server/src/models/ShiftEditRequest.js` — management's proposed edit.
- `server/src/services/shifts/ratio.js` — default/effective ratios, `ratioWarnings`.
- `server/src/services/shifts/seed.js` — `buildSeedEntries`, `areaFromCommitmentText`.
- `server/src/services/shifts/rules.js` — `findOverlaps`, `affectedEmployeeIds`, `suggestPrimary`, `needsPrimaryPrompt`, `weekDays`.
- `server/src/services/shifts/shiftWeek.service.js` — every DB read/write for shifts.
- `server/src/services/shiftReminderJob.js` — Friday 12:00 reminder.
- `server/src/controllers/shifts.controller.js`, `server/src/routes/shifts.routes.js`.
- Tests: `server/scripts/shifts-rules.test.js`, `server/scripts/shifts-service.test.js`, `server/scripts/shift-reminder.test.js`.

Server (modify): `server/src/models/index.js`, `server/src/models/Branch.js`, `server/src/models/NotificationEvent.js`, `server/src/routes/index.js`, `server/src/constants/tabs.js`, `server/src/index.js`, `server/package.json`.

Client (create): `client/src/components/shifts/ShiftsScreen.jsx`, `ShiftGrid.jsx`, `EntryDialog.jsx`, `PrimaryClassDialog.jsx`, `ShiftSettingsDialog.jsx`, `EditRequestsPanel.jsx`, `shiftRows.js`, `shiftExport.js`; `client/src/components/employee-portal/MyShifts.jsx`.

Client (modify): `client/src/config/tabs.js`, `client/src/components/layout/navIcons.js`, `client/src/config/screenHelp.js`, `client/src/App.jsx`, `client/package.json`.

---

### Task 1: Pure rules — ratios, seeding, overlaps, diff, primary suggestion

**Files:**
- Create: `server/src/services/shifts/ratio.js`, `server/src/services/shifts/seed.js`, `server/src/services/shifts/rules.js`
- Test: `server/scripts/shifts-rules.test.js`
- Modify: `server/package.json` (add `"test:shifts-rules": "node scripts/shifts-rules.test.js",` after `"test:bank-watch"`)

**Interfaces:**
- Produces (ratio.js): `CATEGORY_KEY` (`{'תינוקייה':'infants','צעירים':'young','בוגרים':'older'}`), `defaultRatios(branchName) → {infants,young,older}`, `effectiveRatios(branch) → {infants,young,older}`, `ratioWarnings({entries, classrooms, dates, closedDates, ratios}) → [{date, classroom_id, enrolled, staff, needed}]` where `classrooms = [{_id, category, enrolled}]`, `closedDates` is a `Set<string>`.
- Produces (seed.js): `areaFromCommitmentText(text) → 'kitchen'|'floater'|null`, `buildSeedEntries({dates, employees, commitments, activeClassroomIds, closedDates}) → Entry[]` (no `_id`). `dates` = 6 Sun–Fri strings; `employees = [{_id, full_name, primary_classroom_id}]`; `commitments = [{employee_id, classroom, days:[{day,is_off,start_hhmm,end_hhmm}], is_alternating_off, alternating_day}]`; `activeClassroomIds: Set<string>`.
- Produces (rules.js): `weekDays(weekStart) → string[6]`, `isSunday(ymd) → bool`, `findOverlaps(entries) → [{employee_id, employee_name, date}]`, `affectedEmployeeIds(prev, next) → Set<string>`, `suggestPrimary({commitmentText, classrooms}) → {suggestion: string|null, candidates: string[]}` (`classrooms = [{_id,name,category}]` active only), `needsPrimaryPrompt(employee, commitment) → bool`.

- [ ] **Step 1: Write the failing test** — `server/scripts/shifts-rules.test.js`

```js
#!/usr/bin/env node
/**
 * The rota's rules that need no database: what a fresh week looks like, when
 * a class is short-staffed, when two entries collide, who must be told about
 * a re-publish, and which class to suggest as an employee's primary one.
 *
 *   node scripts/shifts-rules.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};
const assert = require('assert');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

const { defaultRatios, effectiveRatios, ratioWarnings } = require('../src/services/shifts/ratio');
const { buildSeedEntries, areaFromCommitmentText } = require('../src/services/shifts/seed');
const { weekDays, isSunday, findOverlaps, affectedEmployeeIds, suggestPrimary, needsPrimaryPrompt } = require('../src/services/shifts/rules');

const DATES = weekDays('2026-10-11');

console.log('\nweekDays');
check('Sunday to Friday, six dates', () => assert.deepStrictEqual(DATES, ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']));
check('isSunday', () => { assert.ok(isSunday('2026-10-11')); assert.ok(!isSunday('2026-10-12')); assert.ok(!isSunday('bad')); });

console.log('\nratios');
check('Kfar Saba defaults', () => assert.deepStrictEqual(defaultRatios('כפר סבא - קפלן'), { infants: 5, young: 7, older: 9 }));
check('other cities', () => assert.deepStrictEqual(defaultRatios('הרצליה הרצוג'), { infants: 5, young: 8, older: 10 }));
check('branch override wins per key, blanks fall back', () => assert.deepStrictEqual(
  effectiveRatios({ name: 'תל אביב', staff_ratios: { infants: 4, young: null, older: 0 } }),
  { infants: 4, young: 8, older: 10 },
));
check('14 infants at 1/5 need 3; 2 placed → one warning', () => {
  const entries = [
    { employee_id: 'a', date: DATES[0], area: 'class', classroom_id: 'r1' },
    { employee_id: 'b', date: DATES[0], area: 'class', classroom_id: 'r1' },
    { employee_id: 'b', date: DATES[0], area: 'class', classroom_id: 'r1' }, // same person twice counts once
  ];
  const w = ratioWarnings({ entries, classrooms: [{ _id: 'r1', category: 'תינוקייה', enrolled: 14 }], dates: [DATES[0]], closedDates: new Set(), ratios: { infants: 5, young: 7, older: 9 } });
  assert.deepStrictEqual(w, [{ date: DATES[0], classroom_id: 'r1', enrolled: 14, staff: 2, needed: 3 }]);
});
check('closed day, empty class and uncategorised class never warn', () => {
  const w = ratioWarnings({
    entries: [],
    classrooms: [{ _id: 'r1', category: 'בוגרים', enrolled: 20 }, { _id: 'r2', category: 'צעירים', enrolled: 0 }, { _id: 'r3', category: null, enrolled: 9 }],
    dates: [DATES[0]], closedDates: new Set([DATES[0]]), ratios: { infants: 5, young: 7, older: 9 },
  });
  assert.deepStrictEqual(w, []);
});

console.log('\nseed');
check('areaFromCommitmentText', () => {
  assert.strictEqual(areaFromCommitmentText('מטבח'), 'kitchen');
  assert.strictEqual(areaFromCommitmentText('מחליפה'), 'floater');
  assert.strictEqual(areaFromCommitmentText('תינוקייה'), null);
});
check('commitment days become entries; off days, closed days skipped; alternating flagged', () => {
  const entries = buildSeedEntries({
    dates: DATES,
    employees: [{ _id: 'e1', full_name: 'דנה', primary_classroom_id: 'r1' }, { _id: 'e2', full_name: 'רות', primary_classroom_id: null }],
    commitments: [
      { employee_id: 'e1', classroom: 'תינוקייה', is_alternating_off: true, alternating_day: 2,
        days: [{ day: 0, start_hhmm: '07:00', end_hhmm: '15:00' }, { day: 1, is_off: true }, { day: 2, start_hhmm: '07:00', end_hhmm: '13:00' }, { day: 3, start_hhmm: '08:00', end_hhmm: '16:00' }] },
      { employee_id: 'e2', classroom: 'מטבח', days: [{ day: 0, start_hhmm: '06:30', end_hhmm: '14:00' }] },
    ],
    activeClassroomIds: new Set(['r1']),
    closedDates: new Set([DATES[3]]),
  });
  assert.deepStrictEqual(entries.map(e => [e.employee_id, e.date, e.area, e.classroom_id, e.start_hhmm, e.end_hhmm, e.alternating]), [
    ['e1', DATES[0], 'class', 'r1', '07:00', '15:00', false],
    ['e1', DATES[2], 'class', 'r1', '07:00', '13:00', true],
    ['e2', DATES[0], 'kitchen', null, '06:30', '14:00', false],
  ]);
  assert.strictEqual(entries[0].employee_name, 'דנה');
});
check('primary class that is no longer active → ללא כיתה', () => {
  const [e] = buildSeedEntries({
    dates: DATES,
    employees: [{ _id: 'e1', full_name: 'דנה', primary_classroom_id: 'gone' }],
    commitments: [{ employee_id: 'e1', classroom: '', days: [{ day: 0, start_hhmm: '07:00', end_hhmm: '15:00' }] }],
    activeClassroomIds: new Set(['r1']), closedDates: new Set(),
  });
  assert.strictEqual(e.area, 'unassigned');
  assert.strictEqual(e.classroom_id, null);
});

console.log('\noverlaps');
check('same employee, same day, touching is fine, overlapping is not', () => {
  const base = { employee_id: 'e1', employee_name: 'דנה', date: DATES[0] };
  assert.deepStrictEqual(findOverlaps([{ ...base, start_hhmm: '07:00', end_hhmm: '13:00' }, { ...base, start_hhmm: '13:00', end_hhmm: '16:00' }]), []);
  assert.deepStrictEqual(findOverlaps([{ ...base, start_hhmm: '07:00', end_hhmm: '13:30' }, { ...base, start_hhmm: '13:00', end_hhmm: '16:00' }]), [{ employee_id: 'e1', employee_name: 'דנה', date: DATES[0] }]);
});
check('entries without hours are not compared', () => {
  const base = { employee_id: 'e1', employee_name: 'דנה', date: DATES[0] };
  assert.deepStrictEqual(findOverlaps([{ ...base, start_hhmm: '', end_hhmm: '' }, { ...base, start_hhmm: '07:00', end_hhmm: '16:00' }]), []);
});

console.log('\nwho is told on re-publish');
check('first publish: everybody on the rota', () => {
  const next = [{ employee_id: 'a', date: DATES[0], area: 'class', classroom_id: 'r1', start_hhmm: '07:00', end_hhmm: '15:00' }, { employee_id: 'b', date: DATES[0], area: 'kitchen', classroom_id: null, start_hhmm: '07:00', end_hhmm: '15:00' }];
  assert.deepStrictEqual([...affectedEmployeeIds([], next)].sort(), ['a', 'b']);
});
check('later publish: only employees whose own entries changed (incl. removed)', () => {
  const a = { employee_id: 'a', date: DATES[0], area: 'class', classroom_id: 'r1', start_hhmm: '07:00', end_hhmm: '15:00' };
  const b = { employee_id: 'b', date: DATES[0], area: 'class', classroom_id: 'r1', start_hhmm: '07:00', end_hhmm: '15:00' };
  const c = { employee_id: 'c', date: DATES[1], area: 'class', classroom_id: 'r1', start_hhmm: '07:00', end_hhmm: '15:00' };
  const next = [{ ...a, _id: 'x1' }, { ...b, end_hhmm: '16:00' }];
  assert.deepStrictEqual([...affectedEmployeeIds([a, b, c], next)].sort(), ['b', 'c']);
});

console.log('\nprimary class suggestion');
const rooms = [{ _id: 'r1', name: 'תינוקייה 20', category: 'תינוקייה' }, { _id: 'r2', name: 'צעירים א', category: 'צעירים' }, { _id: 'r3', name: 'צעירים ב', category: 'צעירים' }];
check('exact class name', () => assert.deepStrictEqual(suggestPrimary({ commitmentText: 'תינוקייה 20', classrooms: rooms }), { suggestion: 'r1', candidates: ['r1'] }));
check('category with one class', () => assert.deepStrictEqual(suggestPrimary({ commitmentText: 'תינוקייה', classrooms: rooms }), { suggestion: 'r1', candidates: ['r1'] }));
check('category with two classes → no suggestion, both candidates', () => assert.deepStrictEqual(suggestPrimary({ commitmentText: 'צעירים', classrooms: rooms }), { suggestion: null, candidates: ['r2', 'r3'] }));
check('unknown text → every class is a candidate', () => assert.deepStrictEqual(suggestPrimary({ commitmentText: '', classrooms: rooms }), { suggestion: null, candidates: ['r1', 'r2', 'r3'] }));
check('needsPrimaryPrompt', () => {
  assert.strictEqual(needsPrimaryPrompt({ primary_classroom_id: null }, { classroom: 'צעירים' }), true);
  assert.strictEqual(needsPrimaryPrompt({ primary_classroom_id: 'r1' }, { classroom: 'צעירים' }), false);
  assert.strictEqual(needsPrimaryPrompt({ primary_classroom_id: null }, { classroom: 'מטבח' }), false);
  assert.strictEqual(needsPrimaryPrompt({ primary_classroom_id: null }, null), false);
});

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node scripts/shifts-rules.test.js`
Expected: crash `Cannot find module '../src/services/shifts/ratio'`.

- [ ] **Step 3: Implement `server/src/services/shifts/ratio.js`**

```js
/**
 * How many staff a class needs, and where the rota falls short.
 *
 * A warning, never a block: the day changes under the plan (children off sick,
 * children collected early) and the manager moves people during it. What the
 * board owes her is to show, while she plans, which class on which day is
 * below the ratio the licence asks for.
 */
const CATEGORY_KEY = { 'תינוקייה': 'infants', 'צעירים': 'young', 'בוגרים': 'older' };
const KFAR_SABA = { infants: 5, young: 7, older: 9 };
const OTHER = { infants: 5, young: 8, older: 10 };

function defaultRatios(branchName = '') {
  return String(branchName).trim().startsWith('כפר סבא') ? { ...KFAR_SABA } : { ...OTHER };
}

/** The city default, with any positive number the branch set replacing it. */
function effectiveRatios(branch) {
  const out = defaultRatios(branch && branch.name);
  const own = (branch && branch.staff_ratios) || {};
  for (const key of Object.keys(out)) {
    const v = Number(own[key]);
    if (Number.isFinite(v) && v > 0) out[key] = v;
  }
  return out;
}

function ratioWarnings({ entries, classrooms, dates, closedDates, ratios }) {
  const out = [];
  for (const date of dates) {
    if (closedDates.has(date)) continue;
    for (const room of classrooms) {
      const key = CATEGORY_KEY[room.category];
      if (!key || !(room.enrolled > 0)) continue;
      const staff = new Set(entries
        .filter(e => e.date === date && e.area === 'class' && String(e.classroom_id) === String(room._id))
        .map(e => String(e.employee_id))).size;
      const needed = Math.ceil(room.enrolled / ratios[key]);
      if (staff < needed) out.push({ date, classroom_id: String(room._id), enrolled: room.enrolled, staff, needed });
    }
  }
  return out;
}

module.exports = { CATEGORY_KEY, defaultRatios, effectiveRatios, ratioWarnings };
```

- [ ] **Step 4: Implement `server/src/services/shifts/seed.js`**

```js
/**
 * A new week, before the manager touches it: each employee where her
 * commitment says she works, for the hours it says.
 *
 * The commitment's `classroom` is free text (תינוקייה / מטבח / מחליפה …). It
 * decides the row only for kitchen and floater staff; a class row comes from
 * the employee card's primary class, and with none she waits in "ללא כיתה"
 * for the manager to place her.
 */
function areaFromCommitmentText(text) {
  const t = String(text || '');
  if (/מטבח/.test(t)) return 'kitchen';
  if (/מחליפ/.test(t)) return 'floater';
  return null;
}

function buildSeedEntries({ dates, employees, commitments, activeClassroomIds, closedDates }) {
  const byEmployee = new Map(commitments.map(c => [String(c.employee_id), c]));
  const out = [];
  for (const emp of employees) {
    const c = byEmployee.get(String(emp._id));
    if (!c) continue;
    const textArea = areaFromCommitmentText(c.classroom);
    const primary = emp.primary_classroom_id && activeClassroomIds.has(String(emp.primary_classroom_id))
      ? String(emp.primary_classroom_id) : null;
    const area = primary ? 'class' : (textArea || 'unassigned');
    const days = [...(c.days || [])].sort((a, b) => a.day - b.day);
    for (const d of days) {
      if (d.is_off) continue;
      const date = dates[d.day];
      if (!date || closedDates.has(date)) continue;
      out.push({
        employee_id: String(emp._id),
        employee_name: emp.full_name,
        date,
        area,
        classroom_id: area === 'class' ? primary : null,
        start_hhmm: d.start_hhmm || '',
        end_hhmm: d.end_hhmm || '',
        alternating: !!(c.is_alternating_off && c.alternating_day === d.day),
        new_class: false,
      });
    }
  }
  return out;
}

module.exports = { areaFromCommitmentText, buildSeedEntries };
```

- [ ] **Step 5: Implement `server/src/services/shifts/rules.js`**

```js
const { weekDates } = require('../parentVisibility');
const { areaFromCommitmentText } = require('./seed');

/** Sunday to Friday of the week starting `weekStart`. */
function weekDays(weekStart) {
  return weekDates(weekStart).slice(0, 6);
}

function isSunday(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return false;
  return new Date(`${ymd}T12:00:00.000Z`).getUTCDay() === 0;
}

const minutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * One person cannot be in two rooms at once. Back-to-back (13:00 out, 13:00
 * in) is the normal mid-day switch and is allowed; any real overlap is not.
 */
function findOverlaps(entries) {
  const groups = new Map();
  for (const e of entries) {
    const s = minutes(e.start_hhmm); const t = minutes(e.end_hhmm);
    if (s === null || t === null) continue;
    const key = `${e.employee_id}|${e.date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ s, t, e });
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.s - b.s);
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].s < list[i - 1].t) {
        const { employee_id, employee_name, date } = list[i].e;
        out.push({ employee_id: String(employee_id), employee_name, date });
        break;
      }
    }
  }
  return out;
}

/** What one employee's week looks like, independent of entry ids and order. */
function signatures(entries) {
  const map = new Map();
  for (const e of entries || []) {
    const id = String(e.employee_id);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push([e.date, e.area, e.classroom_id ? String(e.classroom_id) : '', e.start_hhmm || '', e.end_hhmm || ''].join('|'));
  }
  for (const [id, list] of map) map.set(id, list.sort().join(';'));
  return map;
}

/** Employees whose own entries differ between two snapshots (added, changed or removed). */
function affectedEmployeeIds(prev, next) {
  const a = signatures(prev); const b = signatures(next);
  const out = new Set();
  for (const id of new Set([...a.keys(), ...b.keys()])) if (a.get(id) !== b.get(id)) out.add(id);
  return out;
}

function suggestPrimary({ commitmentText, classrooms }) {
  const text = String(commitmentText || '').trim();
  const all = classrooms.map(r => String(r._id));
  const exact = classrooms.find(r => r.name === text);
  if (exact) return { suggestion: String(exact._id), candidates: [String(exact._id)] };
  const sameCategory = classrooms.filter(r => r.category && r.category === text).map(r => String(r._id));
  if (sameCategory.length === 1) return { suggestion: sameCategory[0], candidates: sameCategory };
  if (sameCategory.length > 1) return { suggestion: null, candidates: sameCategory };
  return { suggestion: null, candidates: all };
}

/** A class employee with a commitment and no primary class. Kitchen and floaters have no class to ask about. */
function needsPrimaryPrompt(employee, commitment) {
  if (!commitment || employee.primary_classroom_id) return false;
  return areaFromCommitmentText(commitment.classroom) === null;
}

module.exports = { weekDays, isSunday, findOverlaps, affectedEmployeeIds, suggestPrimary, needsPrimaryPrompt };
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd server && node scripts/shifts-rules.test.js`
Expected: every line `✓`, last line `all passed`, exit 0.

- [ ] **Step 7: Register and commit**

Add `"test:shifts-rules": "node scripts/shifts-rules.test.js",` to `server/package.json` scripts after `"test:bank-watch"`.

```bash
git add server/src/services/shifts server/scripts/shifts-rules.test.js server/package.json
git commit -m "feat(shifts): pure rules — seed from commitment, ratio warnings, overlaps, publish diff, primary suggestion"
```

---

### Task 2: Models and the shifts service (DB)

**Files:**
- Create: `server/src/models/ShiftWeek.js`, `server/src/models/ShiftEditRequest.js`, `server/src/services/shifts/shiftWeek.service.js`
- Modify: `server/src/models/index.js` (require + export both models, next to `Holiday`), `server/src/models/Branch.js` (add `staff_ratios` after `licensed_capacity`), `server/src/models/NotificationEvent.js` (enum)
- Test: `server/scripts/shifts-service.test.js`; register `"test:shifts-service"` in `server/package.json`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces (service, all `async` unless noted):
  - `canView(user, branchId) → bool` (sync), `canEdit(user, branchId) → bool` (sync)
  - `getBoard({ user, branchId, weekStart }) → { week|null, preview: Entry[]|null, dates, closed_dates, classrooms:[{_id,name,category,enrolled}], inactive_classrooms:[{_id,name}], employees:[{_id,full_name,primary_classroom_id,extra_classroom_ids}], ratios, warnings, pending_primary:[{employee_id,full_name,commitment_text,suggestion,candidates}], edit_requests, can_edit, can_request, branch_id, branch_name, has_unpublished_changes }`
  - `createWeek({ user, branchId, weekStart }) → ShiftWeek`
  - `saveEntries({ user, weekId, entries }) → ShiftWeek` (throws `ShiftError(400)` with `overlaps`)
  - `setClosedDay({ user, weekId, date, closed }) → ShiftWeek`
  - `publishWeek({ user, weekId }) → { week, notified }`
  - `setPrimaryClassroom({ user, employeeId, classroomId })`
  - `closeClassroom({ user, classroomId })`, `reopenClassroom({ user, classroomId })`
  - `setRatios({ user, branchId, ratios })`
  - `createEditRequest({ user, weekId, entries }) → ShiftEditRequest`
  - `decideEditRequest({ user, requestId, approve, reason }) → ShiftEditRequest`
  - `myShifts({ employee, weekStart }) → { week_start, dates, branch_name, published, entries, classrooms:[{_id,name}], me }`
  - `class ShiftError extends Error { status; extra }`

- [ ] **Step 1: Models**

`server/src/models/ShiftWeek.js`:

```js
const mongoose = require('mongoose');

/**
 * One branch's rota for one week (Sunday–Friday).
 *
 * Two copies of the same list, on purpose. `entries` is what the manager is
 * editing; `published` is what the staff were told at the last "סגירת סידור".
 * Employees only ever read `published`, so a half-finished edit is never a
 * schedule somebody acts on, and the diff between the two is exactly the set
 * of people a re-publish has to notify.
 */
const entrySchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  // Snapshot: the printed rota must still read right after a rename or a departure.
  employee_name: { type: String, default: '' },
  date: { type: String, required: true }, // YYYY-MM-DD
  area: { type: String, enum: ['class', 'kitchen', 'floater', 'unassigned'], required: true },
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null },
  start_hhmm: { type: String, default: '' },
  end_hhmm: { type: String, default: '' },
  // The commitment's alternating day off, seeded as working; the manager decides per week.
  alternating: { type: Boolean, default: false },
  // Placed in a class that was not hers before this week — shown to the manager.
  new_class: { type: Boolean, default: false },
});

const shiftWeekSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  week_start: { type: String, required: true }, // a Sunday
  entries: { type: [entrySchema], default: [] },
  published: { type: [entrySchema], default: [] },
  published_at: { type: Date, default: null },
  published_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Days the manager closed for this week only, beyond the gan's own calendar.
  closed_days: { type: [String], default: [] },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

shiftWeekSchema.index({ branch_id: 1, week_start: 1 }, { unique: true });

module.exports = mongoose.model('ShiftWeek', shiftWeekSchema);
```

`server/src/models/ShiftEditRequest.js`:

```js
const mongoose = require('mongoose');

/**
 * The office edits a branch's rota only through its manager.
 *
 * She is the one who answers for who stands in which room, so an admin or the
 * accountant proposes the whole week as they want it, and it lands only when
 * she approves. A rejection carries a reason, same as every other request in
 * the system that a person is told "no" about.
 */
const shiftEditRequestSchema = new mongoose.Schema({
  shift_week_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiftWeek', required: true, index: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  entries: { type: [mongoose.Schema.Types.Mixed], default: [] },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requested_by_name: { type: String, default: '' },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_by_name: { type: String, default: '' },
  decided_at: { type: Date, default: null },
  reject_reason: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('ShiftEditRequest', shiftEditRequestSchema);
```

`server/src/models/Branch.js` — add after `licensed_capacity: { type: Number, default: null },`:

```js
  // Staff-to-children ratio per age group, for the rota's warnings. null =
  // the city default (services/shifts/ratio.js) — set only where a branch
  // differs, so a change in the regulation is one edit, not one per branch.
  staff_ratios: {
    infants: { type: Number, default: null },
    young: { type: Number, default: null },
    older: { type: Number, default: null },
  },
```

`server/src/models/NotificationEvent.js` — append inside the `enum` array, after `'bank_feed_stale',`:

```js
      // סידור עבודה (docs/superpowers/specs/2026-10-04-shifts-phase1-design.md):
      // published / changed for the employee, Friday reminder and the office's
      // edit request for the manager, the decision back to the office.
      'shift_published', 'shift_changed', 'shift_close_reminder',
      'shift_edit_request', 'shift_edit_decision',
```

`server/src/models/index.js` — next to `const Holiday = require('./Holiday');` add `const ShiftWeek = require('./ShiftWeek');` and `const ShiftEditRequest = require('./ShiftEditRequest');`, and add `ShiftWeek,` and `ShiftEditRequest,` to the exported object next to `Holiday,`.

- [ ] **Step 2: Write the failing DB test** — `server/scripts/shifts-service.test.js`

```js
#!/usr/bin/env node
/**
 * The rota against a real (in-memory) database: opening a week, saving,
 * closing a day, publishing and who is told, the office's edit request, class
 * close/reopen, primary class, ratios, and what an employee sees.
 *
 *   node scripts/shifts-service.test.js
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
async function throwsStatus(fn, status, label) {
  try { await fn(); eq('no throw', status, label); } catch (e) { eq(e.status, status, label); }
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const M = require('../src/models');
  const svc = require('../src/services/shifts/shiftWeek.service');

  const branch = await M.Branch.create({ name: 'כפר סבא - קפלן' });
  const other = await M.Branch.create({ name: 'הרצליה הרצוג' });
  const mk = (role, extra = {}) => M.User.create({ full_name: role, id_number: String(Math.random()).slice(2, 11), email: `${role}${Math.random()}@x.l`, password_hash: 'x', role, is_active: true, ...extra });
  const managerUser = await mk('branch_manager', { managed_branch_ids: [branch._id], branch_id: branch._id });
  const adminUser = await mk('system_admin');
  const empUser = await mk('teacher', { branch_id: branch._id });
  const manager = { id: String(managerUser._id), role: 'branch_manager', managed_branch_ids: [String(branch._id)], full_name: 'מנהלת' };
  const admin = { id: String(adminUser._id), role: 'system_admin', full_name: 'אדמין' };

  const infants = await M.Classroom.create({ name: 'תינוקייה 20', category: 'תינוקייה', academic_year: '2026-2027', branch_id: branch._id });
  const young = await M.Classroom.create({ name: 'צעירים א', category: 'צעירים', academic_year: '2026-2027', branch_id: branch._id });
  const reg = await M.Registration.create({ unique_id: 'r1', child_name: 'ילד', parent_name: 'הורה', monthly_fee: 1, start_date: new Date('2026-09-01'), end_date: new Date('2027-08-31') });
  for (let i = 0; i < 6; i += 1) await M.Child.create({ registration_id: reg._id, child_name: `ילד ${i}`, academic_year: '2026-2027', classroom_id: infants._id, is_active: true });

  const dana = await M.Employee.create({ full_name: 'דנה', israeli_id: '111111111', branch_id: branch._id, user_id: empUser._id, primary_classroom_id: infants._id, is_active: true });
  const ruth = await M.Employee.create({ full_name: 'רות', israeli_id: '222222222', branch_id: branch._id, is_active: true });
  await M.EmployeeCommitment.create({ employee_id: dana._id, branch_id: branch._id, classroom: 'תינוקייה', days: [0, 1, 2, 3, 4].map(day => ({ day, start_hhmm: '07:00', end_hhmm: '15:00' })) });
  await M.EmployeeCommitment.create({ employee_id: ruth._id, branch_id: branch._id, classroom: 'צעירים', days: [{ day: 0, start_hhmm: '08:00', end_hhmm: '16:00' }] });
  // Sukkot-style closure on the Tuesday of the week.
  await M.Holiday.create({ branch_id: branch._id, academic_year: '2026-2027', name: 'חג', start_date: new Date('2026-10-13T00:00:00+03:00'), end_date: new Date('2026-10-13T00:00:00+03:00'), kind: 'closure' });

  const WEEK = '2026-10-11';

  console.log('\nהרשאות');
  eq(svc.canEdit(manager, branch._id), true, 'מנהלת עורכת את הסניף שלה');
  eq(svc.canEdit(manager, other._id), false, 'ולא סניף אחר');
  eq(svc.canEdit(admin, branch._id), false, 'אדמין לא עורך ישירות');
  eq(svc.canView(admin, other._id), true, 'אבל רואה הכל');

  console.log('\nלוח לפני פתיחה');
  let board = await svc.getBoard({ user: manager, branchId: String(branch._id), weekStart: WEEK });
  eq(board.week, null, 'אין שבוע עדיין');
  eq(board.preview.length, 5, 'תצוגה מקדימה: 4 ימים של דנה (שלישי סגור) + יום של רות');
  eq(board.pending_primary.map(p => p.full_name), ['רות'], 'רות בלי כיתה ראשית — נשאלת');
  eq(board.pending_primary[0].suggestion, String(young._id), 'הצעה: הכיתה היחידה בקטגוריה');
  eq(board.ratios, { infants: 5, young: 7, older: 9 }, 'יחסי כפר סבא');

  console.log('\nפתיחת שבוע');
  const week = await svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: WEEK });
  eq(week.entries.length, 5, 'נזרע מההתחייבות');
  await throwsStatus(() => svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: WEEK }), 409, 'פתיחה כפולה נדחית');
  await throwsStatus(() => svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: '2026-10-12' }), 400, 'שבוע חייב להתחיל בראשון');
  await throwsStatus(() => svc.createWeek({ user: admin, branchId: String(branch._id), weekStart: '2026-10-18' }), 403, 'אדמין לא פותח');

  console.log('\nשמירה');
  const entries = week.entries.map(e => e.toObject());
  const ruthEntry = entries.find(e => String(e.employee_id) === String(ruth._id));
  ruthEntry.area = 'class'; ruthEntry.classroom_id = infants._id;
  let saved = await svc.saveEntries({ user: manager, weekId: String(week._id), entries });
  eq(saved.entries.find(e => String(e.employee_id) === String(ruth._id)).new_class, true, 'כיתה חדשה לרות מסומנת');
  eq((await M.Employee.findById(ruth._id)).extra_classroom_ids.map(String), [String(infants._id)], 'ונוספה לכיתות שלה לצמיתות');
  const clash = saved.entries.map(e => e.toObject());
  clash.push({ ...clash[0], _id: undefined, start_hhmm: '14:00', end_hhmm: '17:00', area: 'class', classroom_id: young._id });
  await throwsStatus(() => svc.saveEntries({ user: manager, weekId: String(week._id), entries: clash }), 400, 'חפיפה נדחית');

  console.log('\nיחס חניכה');
  board = await svc.getBoard({ user: manager, branchId: String(branch._id), weekStart: WEEK });
  eq(board.warnings.length, 3, '6 תינוקות ב-1/5 צריכים 2: ראשון יש 2, שני/רביעי/חמישי רק דנה');

  console.log('\nסגירת יום');
  saved = await svc.setClosedDay({ user: manager, weekId: String(week._id), date: '2026-10-15', closed: true });
  eq(saved.entries.some(e => e.date === '2026-10-15'), false, 'סגירת יום מוחקת את השיבוצים בו');
  eq(saved.closed_days, ['2026-10-15'], 'ונשמרת');

  console.log('\nפרסום');
  let pub = await svc.publishWeek({ user: manager, weekId: String(week._id) });
  eq(pub.notified, 1, 'פרסום ראשון: דנה (לרות אין משתמש)');
  eq(await M.NotificationEvent.countDocuments({ type: 'shift_published', recipient_id: empUser._id }), 1, 'התראה לדנה');
  const again = pub.week.entries.map(e => e.toObject());
  again.find(e => String(e.employee_id) === String(ruth._id)).end_hhmm = '15:00';
  await svc.saveEntries({ user: manager, weekId: String(week._id), entries: again });
  pub = await svc.publishWeek({ user: manager, weekId: String(week._id) });
  eq(pub.notified, 0, 'פרסום חוזר: רק מי שהשתנה לה (רות, בלי משתמש) — דנה לא');

  console.log('\nמה העובדת רואה');
  const mine = await svc.myShifts({ employee: dana, weekStart: WEEK });
  eq(mine.published, true, 'הסידור פורסם');
  eq(mine.entries.length, pub.week.published.length, 'רואה את כל הסניף');
  eq(mine.me, String(dana._id), 'ויודעת מי היא');

  console.log('\nבקשת שינוי מהמשרד');
  const proposed = pub.week.entries.map(e => e.toObject()).filter(e => String(e.employee_id) !== String(ruth._id));
  const reqDoc = await svc.createEditRequest({ user: admin, weekId: String(week._id), entries: proposed });
  eq(reqDoc.status, 'pending', 'ממתינה');
  eq(await M.NotificationEvent.countDocuments({ type: 'shift_edit_request', recipient_id: managerUser._id }), 1, 'המנהלת קיבלה התראה');
  await throwsStatus(() => svc.decideEditRequest({ user: manager, requestId: String(reqDoc._id), approve: false, reason: '' }), 400, 'דחייה בלי סיבה נדחית');
  const decided = await svc.decideEditRequest({ user: manager, requestId: String(reqDoc._id), approve: true });
  eq(decided.status, 'approved', 'אושרה');
  const afterApprove = await M.ShiftWeek.findById(week._id);
  eq(afterApprove.entries.some(e => String(e.employee_id) === String(ruth._id)), false, 'והשינוי הוחל על העותק בעבודה');

  console.log('\nכיתות ויחסים');
  await throwsStatus(() => svc.closeClassroom({ user: manager, classroomId: String(infants._id) }), 409, 'כיתה עם ילדים לא נסגרת');
  await svc.closeClassroom({ user: manager, classroomId: String(young._id) });
  eq((await M.Classroom.findById(young._id)).is_active, false, 'כיתה ריקה נסגרת');
  await svc.reopenClassroom({ user: manager, classroomId: String(young._id) });
  eq((await M.Classroom.findById(young._id)).is_active, true, 'ונפתחת מחדש');
  await svc.setPrimaryClassroom({ user: manager, employeeId: String(ruth._id), classroomId: String(young._id) });
  eq(String((await M.Employee.findById(ruth._id)).primary_classroom_id), String(young._id), 'כיתה ראשית נשמרה בכרטיס');
  await svc.setRatios({ user: manager, branchId: String(branch._id), ratios: { infants: 4, young: '', older: 10 } });
  board = await svc.getBoard({ user: manager, branchId: String(branch._id), weekStart: WEEK });
  eq(board.ratios, { infants: 4, young: 7, older: 10 }, 'יחס סניף גובר, ריק חוזר לברירת מחדל');

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && node scripts/shifts-service.test.js`
Expected: crash `Cannot find module '../src/services/shifts/shiftWeek.service'`.

- [ ] **Step 4: Implement `server/src/services/shifts/shiftWeek.service.js`**

```js
/**
 * Every database read and write of סידור עבודה.
 *
 * The controller only translates HTTP; the rules that need no database live
 * in ratio.js / seed.js / rules.js. Keeping all writes here is what lets the
 * permission checks sit next to the writes they guard.
 */
const mongoose = require('mongoose');
const {
  ShiftWeek, ShiftEditRequest, Branch, Classroom, Child, Employee,
  EmployeeCommitment, Holiday,
} = require('../../models');
const notificationService = require('../notification.service');
const { closureDateSet } = require('../fixedSchedule');
const { effectiveRatios, ratioWarnings } = require('./ratio');
const { buildSeedEntries } = require('./seed');
const {
  weekDays, isSunday, findOverlaps, affectedEmployeeIds, suggestPrimary, needsPrimaryPrompt,
} = require('./rules');

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

async function loadWeekOr404(weekId) {
  if (!mongoose.isValidObjectId(weekId)) throw new ShiftError(404, 'סידור לא נמצא');
  const week = await ShiftWeek.findById(weekId);
  if (!week) throw new ShiftError(404, 'סידור לא נמצא');
  return week;
}

/** Holiday closures of the branch inside these dates, plus the week's own closed days. */
async function closedDatesFor(branchId, dates, week) {
  const holidays = await Holiday.find({
    branch_id: branchId, kind: 'closure',
    start_date: { $lte: new Date(`${dates[dates.length - 1]}T23:59:59+03:00`) },
    end_date: { $gte: new Date(`${dates[0]}T00:00:00+03:00`) },
  }).lean();
  const set = closureDateSet(holidays, branchId);
  for (const d of (week && week.closed_days) || []) set.add(d);
  return new Set(dates.filter(d => set.has(d)));
}

async function classroomsWithCounts(branchId) {
  const rooms = await Classroom.find({ branch_id: branchId, is_active: true }).select('name category').sort({ name: 1 }).lean();
  const counts = await Child.aggregate([
    { $match: { classroom_id: { $in: rooms.map(r => r._id) }, is_active: true } },
    { $group: { _id: '$classroom_id', n: { $sum: 1 } } },
  ]);
  const byId = new Map(counts.map(c => [String(c._id), c.n]));
  return rooms.map(r => ({ _id: String(r._id), name: r.name, category: r.category || null, enrolled: byId.get(String(r._id)) || 0 }));
}

async function seedFor(branchId, dates, closedDates) {
  const [employees, commitments, rooms] = await Promise.all([
    Employee.find({ branch_id: branchId, is_active: true }).select('full_name primary_classroom_id').lean(),
    EmployeeCommitment.find({ branch_id: branchId }).lean(),
    Classroom.find({ branch_id: branchId, is_active: true }).select('_id').lean(),
  ]);
  return buildSeedEntries({
    dates, employees, commitments, closedDates,
    activeClassroomIds: new Set(rooms.map(r => String(r._id))),
  });
}

async function getBoard({ user, branchId, weekStart }) {
  if (!isSunday(weekStart)) throw new ShiftError(400, 'שבוע מתחיל ביום ראשון');
  assertView(user, branchId);
  const branch = await Branch.findById(branchId).lean();
  if (!branch) throw new ShiftError(404, 'סניף לא נמצא');
  const dates = weekDays(weekStart);
  const week = await ShiftWeek.findOne({ branch_id: branchId, week_start: weekStart });
  const closed = await closedDatesFor(branchId, dates, week);
  const classrooms = await classroomsWithCounts(branchId);
  const ratios = effectiveRatios(branch);
  const preview = week ? null : await seedFor(branchId, dates, closed);
  const entries = week ? week.entries.map(e => e.toObject()) : preview;

  const [employees, commitments, inactive, editRequests] = await Promise.all([
    Employee.find({ branch_id: branchId, is_active: true }).select('full_name primary_classroom_id extra_classroom_ids').sort({ full_name: 1 }).lean(),
    EmployeeCommitment.find({ branch_id: branchId }).lean(),
    Classroom.find({ branch_id: branchId, is_active: false }).select('name academic_year').sort({ academic_year: -1, name: 1 }).lean(),
    week ? ShiftEditRequest.find({ shift_week_id: week._id, status: 'pending' }).sort({ created_at: -1 }).lean() : [],
  ]);
  const commitmentOf = new Map(commitments.map(c => [String(c.employee_id), c]));
  const pending_primary = employees
    .filter(e => needsPrimaryPrompt(e, commitmentOf.get(String(e._id))))
    .map(e => {
      const text = commitmentOf.get(String(e._id)).classroom;
      return { employee_id: String(e._id), full_name: e.full_name, commitment_text: text, ...suggestPrimary({ commitmentText: text, classrooms }) };
    });

  return {
    week: week ? week.toObject() : null,
    preview,
    dates,
    closed_dates: [...closed],
    classrooms,
    inactive_classrooms: inactive.map(r => ({ _id: String(r._id), name: r.name, academic_year: r.academic_year })),
    employees: employees.map(e => ({ _id: String(e._id), full_name: e.full_name, primary_classroom_id: e.primary_classroom_id ? String(e.primary_classroom_id) : null, extra_classroom_ids: (e.extra_classroom_ids || []).map(String) })),
    ratios,
    warnings: ratioWarnings({ entries, classrooms, dates, closedDates: closed, ratios }),
    pending_primary,
    edit_requests: editRequests,
    can_edit: canEdit(user, branchId),
    can_request: OFFICE.includes(user.role),
    branch_id: String(branch._id),
    branch_name: branch.name,
    has_unpublished_changes: week ? affectedEmployeeIds(week.published, week.entries).size > 0 || !week.published_at : false,
  };
}

async function createWeek({ user, branchId, weekStart }) {
  if (!isSunday(weekStart)) throw new ShiftError(400, 'שבוע מתחיל ביום ראשון');
  assertEdit(user, branchId);
  if (await ShiftWeek.exists({ branch_id: branchId, week_start: weekStart })) throw new ShiftError(409, 'הסידור לשבוע הזה כבר נפתח');
  const dates = weekDays(weekStart);
  const closed = await closedDatesFor(branchId, dates, null);
  const entries = await seedFor(branchId, dates, closed);
  return ShiftWeek.create({ branch_id: branchId, week_start: weekStart, entries, created_by: user.id });
}

/** Clean what the client sent into Entry shape, refusing what cannot be stored. */
function normalizeEntries(raw, dates, closed) {
  const allowed = new Set(dates);
  return (Array.isArray(raw) ? raw : []).map((e) => {
    if (!mongoose.isValidObjectId(e.employee_id)) throw new ShiftError(400, 'עובדת לא תקינה בשיבוץ');
    if (!allowed.has(e.date)) throw new ShiftError(400, `תאריך ${e.date} לא בשבוע הזה`);
    if (closed.has(e.date)) throw new ShiftError(400, `${e.date} — יום שהגן סגור`);
    if (!['class', 'kitchen', 'floater', 'unassigned'].includes(e.area)) throw new ShiftError(400, 'שורה לא תקינה');
    if (e.area === 'class' && !mongoose.isValidObjectId(e.classroom_id)) throw new ShiftError(400, 'חסרה כיתה');
    const hhmm = (v) => (/^\d{2}:\d{2}$/.test(String(v || '')) ? String(v) : '');
    return {
      ...(mongoose.isValidObjectId(e._id) ? { _id: e._id } : {}),
      employee_id: e.employee_id,
      employee_name: String(e.employee_name || ''),
      date: e.date,
      area: e.area,
      classroom_id: e.area === 'class' ? e.classroom_id : null,
      start_hhmm: hhmm(e.start_hhmm),
      end_hhmm: hhmm(e.end_hhmm),
      alternating: !!e.alternating,
      new_class: !!e.new_class,
    };
  });
}

/**
 * The shared write behind a manager's save and an approved office request:
 * validate, flag and record new classes, store.
 */
async function applyEntries(week, raw) {
  const dates = weekDays(week.week_start);
  const closed = await closedDatesFor(week.branch_id, dates, week);
  const entries = normalizeEntries(raw, dates, closed);
  const overlaps = findOverlaps(entries);
  if (overlaps.length) {
    const first = overlaps[0];
    throw new ShiftError(400, `${first.employee_name || 'עובדת'} משובצת בשעות חופפות ב-${first.date}`, { overlaps });
  }
  const employees = await Employee.find({ _id: { $in: [...new Set(entries.map(e => String(e.employee_id)))] } })
    .select('full_name primary_classroom_id extra_classroom_ids');
  const byId = new Map(employees.map(e => [String(e._id), e]));
  const additions = new Map();
  for (const e of entries) {
    const emp = byId.get(String(e.employee_id));
    if (!emp) throw new ShiftError(400, 'עובדת לא נמצאה');
    if (!e.employee_name) e.employee_name = emp.full_name;
    if (e.area !== 'class') continue;
    const known = [emp.primary_classroom_id, ...(emp.extra_classroom_ids || [])].filter(Boolean).map(String);
    const added = additions.get(String(emp._id)) || new Set();
    if (!known.includes(String(e.classroom_id)) || added.has(String(e.classroom_id))) {
      e.new_class = true;
      added.add(String(e.classroom_id));
      additions.set(String(emp._id), added);
    }
  }
  for (const [empId, rooms] of additions) {
    await Employee.updateOne({ _id: empId }, { $addToSet: { extra_classroom_ids: { $each: [...rooms] } } });
  }
  week.entries = entries;
  await week.save();
  return week;
}

async function saveEntries({ user, weekId, entries }) {
  const week = await loadWeekOr404(weekId);
  assertEdit(user, week.branch_id);
  return applyEntries(week, entries);
}

async function setClosedDay({ user, weekId, date, closed }) {
  const week = await loadWeekOr404(weekId);
  assertEdit(user, week.branch_id);
  if (!weekDays(week.week_start).includes(date)) throw new ShiftError(400, 'התאריך לא בשבוע הזה');
  const days = new Set(week.closed_days);
  if (closed) { days.add(date); week.entries = week.entries.filter(e => e.date !== date); } else days.delete(date);
  week.closed_days = [...days].sort();
  await week.save();
  return week;
}

async function userIdsOf(employeeIds) {
  if (!employeeIds.length) return [];
  const rows = await Employee.find({ _id: { $in: employeeIds }, user_id: { $ne: null } }).select('user_id').lean();
  return rows.map(r => r.user_id);
}

async function publishWeek({ user, weekId }) {
  const week = await loadWeekOr404(weekId);
  assertEdit(user, week.branch_id);
  const first = !week.published_at;
  const affected = [...affectedEmployeeIds(first ? [] : week.published, week.entries)];
  week.published = week.entries.map(e => e.toObject());
  week.published_at = new Date();
  week.published_by = user.id;
  await week.save();

  const recipients = await userIdsOf(affected);
  const [, m, d] = week.week_start.split('-');
  const label = `${d}/${m}`;
  await Promise.all(recipients.map(recipient_id => notificationService.notifyOnce({
    type: first ? 'shift_published' : 'shift_changed',
    ref_collection: 'ShiftWeek', ref_id: week._id, recipient_id,
    title: first ? `הסידור לשבוע ${label} פורסם` : `הסידור שלך לשבוע ${label} עודכן`,
    body: first ? 'אפשר לראות את המשמרות שלך ושל כל הסניף' : 'יש שינוי במשמרות שלך — כדאי להציץ',
    url: `/my-shifts?week=${week.week_start}`,
  }).catch(err => console.error('[shifts] notify failed:', err.message))));
  return { week, notified: recipients.length };
}

async function setPrimaryClassroom({ user, employeeId, classroomId }) {
  const emp = await Employee.findById(employeeId);
  if (!emp) throw new ShiftError(404, 'עובדת לא נמצאה');
  assertEdit(user, emp.branch_id);
  const room = await Classroom.findOne({ _id: classroomId, branch_id: emp.branch_id, is_active: true });
  if (!room) throw new ShiftError(400, 'הכיתה לא שייכת לסניף');
  emp.primary_classroom_id = room._id;
  emp.extra_classroom_ids = (emp.extra_classroom_ids || []).filter(id => String(id) !== String(room._id));
  await emp.save();
  return emp;
}

async function closeClassroom({ user, classroomId }) {
  const room = await Classroom.findById(classroomId);
  if (!room) throw new ShiftError(404, 'כיתה לא נמצאה');
  assertEdit(user, room.branch_id);
  const kids = await Child.countDocuments({ classroom_id: room._id, is_active: true });
  if (kids > 0) throw new ShiftError(409, `בכיתה ${kids} ילדים רשומים — קודם מעבירים אותם`);
  room.is_active = false;
  await room.save();
  return room;
}

async function reopenClassroom({ user, classroomId }) {
  const room = await Classroom.findById(classroomId);
  if (!room) throw new ShiftError(404, 'כיתה לא נמצאה');
  assertEdit(user, room.branch_id);
  room.is_active = true;
  await room.save();
  return room;
}

async function setRatios({ user, branchId, ratios }) {
  if (!(canEdit(user, branchId) || user.role === 'system_admin')) throw new ShiftError(403, 'אין הרשאה');
  const clean = {};
  for (const key of ['infants', 'young', 'older']) {
    const v = Number(ratios && ratios[key]);
    clean[`staff_ratios.${key}`] = Number.isFinite(v) && v > 0 ? v : null;
  }
  await Branch.updateOne({ _id: branchId }, { $set: clean });
}

async function createEditRequest({ user, weekId, entries }) {
  if (!OFFICE.includes(user.role)) throw new ShiftError(403, 'רק המשרד מגיש בקשת שינוי');
  const week = await loadWeekOr404(weekId);
  const dates = weekDays(week.week_start);
  const closed = await closedDatesFor(week.branch_id, dates, week);
  const clean = normalizeEntries(entries, dates, closed);
  const overlaps = findOverlaps(clean);
  if (overlaps.length) throw new ShiftError(400, `${overlaps[0].employee_name || 'עובדת'} משובצת בשעות חופפות ב-${overlaps[0].date}`, { overlaps });
  const doc = await ShiftEditRequest.create({
    shift_week_id: week._id, branch_id: week.branch_id, entries: clean,
    requested_by: user.id, requested_by_name: user.full_name || '',
  });
  const managers = await notificationService.branchManagerIds(week.branch_id);
  await Promise.all(managers.map(recipient_id => notificationService.createEvent({
    type: 'shift_edit_request', ref_collection: 'ShiftEditRequest', ref_id: doc._id, recipient_id,
    title: 'בקשת שינוי בסידור העבודה', body: `${doc.requested_by_name || 'המשרד'} מבקש/ת לשנות את הסידור`,
    url: `/shifts?week=${week.week_start}`,
  }).catch(err => console.error('[shifts] notify failed:', err.message))));
  return doc;
}

async function decideEditRequest({ user, requestId, approve, reason }) {
  const doc = await ShiftEditRequest.findById(requestId);
  if (!doc) throw new ShiftError(404, 'בקשה לא נמצאה');
  assertEdit(user, doc.branch_id);
  if (doc.status !== 'pending') throw new ShiftError(409, 'הבקשה כבר טופלה');
  if (!approve && !String(reason || '').trim()) throw new ShiftError(400, 'יש לכתוב סיבה לדחייה');
  if (approve) {
    const week = await loadWeekOr404(doc.shift_week_id);
    await applyEntries(week, doc.entries);
  }
  doc.status = approve ? 'approved' : 'rejected';
  doc.decided_by = user.id;
  doc.decided_by_name = user.full_name || '';
  doc.decided_at = new Date();
  doc.reject_reason = approve ? '' : String(reason).trim();
  await doc.save();
  await notificationService.resolveEvents({ ref_collection: 'ShiftEditRequest', ref_id: doc._id });
  await notificationService.notifyOnce({
    type: 'shift_edit_decision', ref_collection: 'ShiftEditRequest', ref_id: doc._id, recipient_id: doc.requested_by,
    title: approve ? 'בקשת השינוי בסידור אושרה' : 'בקשת השינוי בסידור נדחתה',
    body: approve ? 'השינוי הוחל על הסידור' : doc.reject_reason,
    url: '/shifts',
  }).catch(err => console.error('[shifts] notify failed:', err.message));
  return doc;
}

async function myShifts({ employee, weekStart }) {
  if (!isSunday(weekStart)) throw new ShiftError(400, 'שבוע מתחיל ביום ראשון');
  const branchId = employee.branch_id;
  const [week, branch, rooms] = await Promise.all([
    ShiftWeek.findOne({ branch_id: branchId, week_start: weekStart }).lean(),
    Branch.findById(branchId).select('name').lean(),
    Classroom.find({ branch_id: branchId }).select('name').lean(),
  ]);
  const published = !!(week && week.published_at);
  return {
    week_start: weekStart,
    dates: weekDays(weekStart),
    branch_name: branch ? branch.name : '',
    published,
    entries: published ? week.published : [],
    classrooms: rooms.map(r => ({ _id: String(r._id), name: r.name })),
    me: String(employee._id),
  };
}

module.exports = {
  ShiftError, canView, canEdit, getBoard, createWeek, saveEntries, setClosedDay, publishWeek,
  setPrimaryClassroom, closeClassroom, reopenClassroom, setRatios,
  createEditRequest, decideEditRequest, myShifts,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && node scripts/shifts-service.test.js`
Expected: every line `✅`, last line `כל הבדיקות עברו`, exit 0. If `branchManagerIds` returns admins instead of the manager, confirm `managed_branch_ids` is set on the test user (see `server/src/services/branch-recipients.service.js:82`).

- [ ] **Step 6: Register and commit**

Add `"test:shifts-service": "node scripts/shifts-service.test.js",` to `server/package.json`.

```bash
git add server/src/models/ShiftWeek.js server/src/models/ShiftEditRequest.js server/src/models/index.js server/src/models/Branch.js server/src/models/NotificationEvent.js server/src/services/shifts/shiftWeek.service.js server/scripts/shifts-service.test.js server/package.json
git commit -m "feat(shifts): ShiftWeek model and service — open, save, close day, publish, office edit requests"
```

---

### Task 3: HTTP — controller, routes, tabs

**Files:**
- Create: `server/src/controllers/shifts.controller.js`, `server/src/routes/shifts.routes.js`
- Modify: `server/src/routes/index.js` (mount after `router.use('/rate-changes', …)`), `server/src/constants/tabs.js` (two tab ids), `client/src/config/tabs.js` (same two ids — the sync test compares them)

**Interfaces:**
- Consumes: service from Task 2; `resolveSelfEmployee` from `server/src/controllers/payroll.controller.js`.
- Produces endpoints (all under `/api/shifts`, JSON):
  - `GET /board?branch=&week=` → `getBoard` result
  - `POST /weeks` `{branch, week}` → `{ week }`
  - `PUT /weeks/:id/entries` `{entries}` → `{ week }` (400 `{error, overlaps}`)
  - `POST /weeks/:id/closed-days` `{date, closed}` → `{ week }`
  - `POST /weeks/:id/publish` → `{ week, notified }`
  - `POST /weeks/:id/edit-requests` `{entries}` → `{ request }`
  - `POST /edit-requests/:id/decide` `{approve, reason}` → `{ request }`
  - `POST /primary-class` `{employee_id, classroom_id}` → `{ ok }`
  - `POST /classrooms/:id/close` / `POST /classrooms/:id/reopen` → `{ ok }`
  - `PUT /ratios/:branchId` `{infants, young, older}` → `{ ok }`
  - `GET /my?week=` → `myShifts` result, or `{ reason: 'no_employee' }`

- [ ] **Step 1: Controller** — `server/src/controllers/shifts.controller.js`

```js
const svc = require('../services/shifts/shiftWeek.service');
const { resolveSelfEmployee } = require('./payroll.controller');
const { weekStart: sundayOf } = require('../services/parentVisibility');
const { todayIsrael } = require('../services/fixedSchedule');

/** Service errors carry their own status; everything else is a 500 via next(). */
const handle = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof svc.ShiftError) return res.status(err.status).json({ error: err.message, ...err.extra });
    return next(err);
  }
};

const weekParam = (v) => (v ? String(v) : sundayOf(todayIsrael()));

module.exports = {
  board: handle(async (req, res) => {
    res.json(await svc.getBoard({ user: req.user, branchId: String(req.query.branch || ''), weekStart: weekParam(req.query.week) }));
  }),
  createWeek: handle(async (req, res) => {
    res.json({ week: await svc.createWeek({ user: req.user, branchId: String(req.body.branch || ''), weekStart: String(req.body.week || '') }) });
  }),
  saveEntries: handle(async (req, res) => {
    res.json({ week: await svc.saveEntries({ user: req.user, weekId: req.params.id, entries: req.body.entries }) });
  }),
  closedDay: handle(async (req, res) => {
    res.json({ week: await svc.setClosedDay({ user: req.user, weekId: req.params.id, date: String(req.body.date || ''), closed: req.body.closed === true }) });
  }),
  publish: handle(async (req, res) => {
    res.json(await svc.publishWeek({ user: req.user, weekId: req.params.id }));
  }),
  createEditRequest: handle(async (req, res) => {
    res.json({ request: await svc.createEditRequest({ user: req.user, weekId: req.params.id, entries: req.body.entries }) });
  }),
  decideEditRequest: handle(async (req, res) => {
    res.json({ request: await svc.decideEditRequest({ user: req.user, requestId: req.params.id, approve: req.body.approve === true, reason: req.body.reason }) });
  }),
  primaryClass: handle(async (req, res) => {
    await svc.setPrimaryClassroom({ user: req.user, employeeId: String(req.body.employee_id || ''), classroomId: String(req.body.classroom_id || '') });
    res.json({ ok: true });
  }),
  closeClassroom: handle(async (req, res) => { await svc.closeClassroom({ user: req.user, classroomId: req.params.id }); res.json({ ok: true }); }),
  reopenClassroom: handle(async (req, res) => { await svc.reopenClassroom({ user: req.user, classroomId: req.params.id }); res.json({ ok: true }); }),
  ratios: handle(async (req, res) => { await svc.setRatios({ user: req.user, branchId: req.params.branchId, ratios: req.body }); res.json({ ok: true }); }),
  my: handle(async (req, res) => {
    const employee = await resolveSelfEmployee(req);
    if (!employee) return res.json({ reason: 'no_employee' });
    res.json(await svc.myShifts({ employee, weekStart: weekParam(req.query.week) }));
  }),
};
```

- [ ] **Step 2: Routes** — `server/src/routes/shifts.routes.js`

```js
const router = require('express').Router();
const { requireTab } = require('../middleware/auth');
const c = require('../controllers/shifts.controller');

// The screen's roles; finer rules (her branches only, office edits by
// request) are enforced in the service, next to the writes.
const board = requireTab('shifts', 'system_admin', 'admin_viewer', 'branch_manager', 'accountant');
const mine = requireTab('my_shifts', 'teacher', 'assistant', 'class_leader', 'cook');

router.get('/board', board, c.board);
router.post('/weeks', board, c.createWeek);
router.put('/weeks/:id/entries', board, c.saveEntries);
router.post('/weeks/:id/closed-days', board, c.closedDay);
router.post('/weeks/:id/publish', board, c.publish);
router.post('/weeks/:id/edit-requests', board, c.createEditRequest);
router.post('/edit-requests/:id/decide', board, c.decideEditRequest);
router.post('/primary-class', board, c.primaryClass);
router.post('/classrooms/:id/close', board, c.closeClassroom);
router.post('/classrooms/:id/reopen', board, c.reopenClassroom);
router.put('/ratios/:branchId', board, c.ratios);
router.get('/my', mine, c.my);

module.exports = router;
```

`server/src/routes/index.js` — after `router.use('/rate-changes', require('./rateChangeRequests.routes'));` add:

```js
// סידור עבודה — the weekly rota a branch manager builds and publishes.
router.use('/shifts', require('./shifts.routes'));
```

- [ ] **Step 3: Tabs (both sides)**

`server/src/constants/tabs.js` — after `attendance: [...]` add `shifts: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'],`; after `my_attendance: EMPLOYEE_ROLES,` add `my_shifts: EMPLOYEE_ROLES,`.

`client/src/config/tabs.js` — in `כוח אדם` after the `attendance` item add:

```js
      // סידור עבודה: the week's rota per class, built from each employee's
      // commitment. The office sees every branch and proposes changes; only
      // the branch manager edits and publishes (enforced on the server).
      { id: 'shifts',             label: 'סידור עבודה', path: '/shifts',         defaultRoles: ['system_admin', 'admin_viewer', 'branch_manager', 'accountant'] },
```

In `האזור שלי` after `my_attendance` add:

```js
      { id: 'my_shifts',     label: 'המשמרות שלי',   path: '/my-shifts',     defaultRoles: EMPLOYEE_ROLES },
```

- [ ] **Step 4: Run the sync tests**

Run: `cd server && npm run test:tabs-sync && npm run test:nav-model && npm run test:screen-meta`
Expected: all pass. (`test:screen-help` will fail until Task 8 adds help entries — that is expected now; do not commit with it failing at the end of the plan.)

- [ ] **Step 5: Smoke the routes**

Run: `cd server && node -e "require('./src/routes/shifts.routes'); console.log('routes ok')"`
Expected: `routes ok`.

- [ ] **Step 6: Commit**

```bash
git add server/src/controllers/shifts.controller.js server/src/routes/shifts.routes.js server/src/routes/index.js server/src/constants/tabs.js client/src/config/tabs.js
git commit -m "feat(shifts): /api/shifts routes and the two screens' tabs"
```

---

### Task 4: Friday reminder job

**Files:**
- Create: `server/src/services/shiftReminderJob.js`
- Modify: `server/src/index.js` (register next to `runPunchDigest`, ~line 597)
- Test: `server/scripts/shift-reminder.test.js`; register `"test:shift-reminder"`

**Interfaces:**
- Consumes: `ShiftWeek`, `Branch`, `Setting` models; `notificationService.branchManagerIds`, `notifyOnce`; `weekStart` from `parentVisibility`.
- Produces: `tick(now = new Date()) → { skipped } | { week_start, reminded: number }`, `MARKER_KEY = 'shift_close_reminder'`.

- [ ] **Step 1: Write the failing test** — `server/scripts/shift-reminder.test.js`

```js
#!/usr/bin/env node
/**
 * Friday from 12:00: a branch whose next-week rota is not published gets one
 * push to its managers — once, not every hour.
 *
 *   node scripts/shift-reminder.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const eq = (a, b, l) => { const g = a === b; console.log(`  ${g ? '✅' : '❌'} ${l}${g ? '' : ` (${a} ≠ ${b})`}`); if (!g) failures++; };

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const { Branch, User, ShiftWeek, NotificationEvent } = require('../src/models');
  const { tick } = require('../src/services/shiftReminderJob');

  const a = await Branch.create({ name: 'כפר סבא - קפלן', is_active: true });
  const b = await Branch.create({ name: 'הרצליה הרצוג', is_active: true });
  await User.create({ full_name: 'מנהלת א', id_number: '900000011', email: 'a@x.l', password_hash: 'x', role: 'branch_manager', is_active: true, managed_branch_ids: [a._id] });
  await User.create({ full_name: 'מנהלת ב', id_number: '900000012', email: 'b@x.l', password_hash: 'x', role: 'branch_manager', is_active: true, managed_branch_ids: [b._id] });
  // Branch B already published next week (Friday 2026-10-09 → next Sunday 2026-10-11).
  await ShiftWeek.create({ branch_id: b._id, week_start: '2026-10-11', published_at: new Date() });

  const thursdayNoon = new Date('2026-10-08T10:00:00Z'); // 13:00 IL, Thursday
  const fridayMorning = new Date('2026-10-09T07:00:00Z'); // 10:00 IL
  const fridayAfternoon = new Date('2026-10-09T10:30:00Z'); // 13:30 IL

  eq((await tick(thursdayNoon)).skipped, 'not friday noon', 'חמישי — כלום');
  eq((await tick(fridayMorning)).skipped, 'not friday noon', 'שישי בבוקר — כלום');
  const r = await tick(fridayAfternoon);
  eq(r.reminded, 1, 'שישי 13:30 — רק סניף א');
  eq(await NotificationEvent.countDocuments({ type: 'shift_close_reminder' }), 1, 'התראה אחת');
  eq((await tick(new Date('2026-10-09T11:30:00Z'))).skipped, 'already ran', 'ריצה נוספת באותו שבוע — כלום');

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node scripts/shift-reminder.test.js`
Expected: crash `Cannot find module '../src/services/shiftReminderJob'`.

- [ ] **Step 3: Implement** — `server/src/services/shiftReminderJob.js`

```js
/**
 * "הסידור לשבוע הבא עוד לא נסגר" — Friday from 12:00, once a week.
 *
 * Employees plan their weekend around Sunday's rota, and 12:00 Friday is the
 * deadline the gan set for it. The job runs hourly like every other timed job
 * here (see index.js) and gates itself: wrong day or hour → nothing; already
 * ran for this week → nothing, via a Setting marker that survives restarts.
 */
const { Branch, ShiftWeek, Setting } = require('../models');
const notificationService = require('./notification.service');
const { weekStart } = require('./parentVisibility');

const MARKER_KEY = 'shift_close_reminder';
const HOUR_IL = 12;

function ilParts(now) {
  const day = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false }).format(now));
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' }).format(now);
  return { day, hour, weekday };
}

function nextSunday(day) {
  const d = new Date(`${weekStart(day)}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

async function tick(now = new Date()) {
  const { day, hour, weekday } = ilParts(now);
  if (weekday !== 'Fri' || hour < HOUR_IL) return { skipped: 'not friday noon' };
  const target = nextSunday(day);
  const marker = await Setting.findOne({ key: MARKER_KEY }).lean();
  if (marker && marker.value === target) return { skipped: 'already ran' };
  await Setting.updateOne({ key: MARKER_KEY }, { $set: { value: target } }, { upsert: true });

  const branches = await Branch.find({ is_active: { $ne: false } }).select('name').lean();
  const published = await ShiftWeek.find({ week_start: target, published_at: { $ne: null } }).select('branch_id').lean();
  const done = new Set(published.map(w => String(w.branch_id)));
  let reminded = 0;
  for (const b of branches) {
    if (done.has(String(b._id))) continue;
    const managers = await notificationService.branchManagerIds(b._id);
    for (const recipient_id of managers) {
      await notificationService.notifyOnce({
        type: 'shift_close_reminder', ref_collection: 'Branch', ref_id: b._id, recipient_id,
        title: 'הסידור לשבוע הבא עוד לא נסגר',
        body: `${b.name} — הסידור לשבוע שמתחיל ב-${target.split('-').reverse().slice(0, 2).join('/')} ממתין לסגירה`,
        url: `/shifts?week=${target}`,
      }).catch(err => console.error('[shift-reminder] notify failed:', err.message));
    }
    reminded += 1;
  }
  return { week_start: target, reminded };
}

module.exports = { tick, MARKER_KEY };
```

Note: the test's branch B has a manager too; `reminded` counts branches, and only A is reminded.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node scripts/shift-reminder.test.js`
Expected: all `✅`, exit 0.

- [ ] **Step 5: Register in `server/src/index.js`**

Next to the `runPunchDigest` lines (~597–603), add:

```js
    // סידור עבודה: Friday 12:00 reminder for an unpublished next-week rota.
    const shiftReminder = require('./services/shiftReminderJob');
    const runShiftReminder = () => withJobLock('shift-close-reminder', 20 * 60 * 1000, () => shiftReminder.tick())
      .catch(err => console.error('[shift-reminder] failed:', err.message));
    if (!platformMode) { setTimeout(runShiftReminder, 90 * 1000); setInterval(runShiftReminder, 60 * 60 * 1000); }
```

Match the exact variable names used by the surrounding `runPunchDigest` block (`withJobLock`, `platformMode`) — read lines 590–605 first.

- [ ] **Step 6: Register test and commit**

Add `"test:shift-reminder": "node scripts/shift-reminder.test.js",`.

```bash
git add server/src/services/shiftReminderJob.js server/scripts/shift-reminder.test.js server/src/index.js server/package.json
git commit -m "feat(shifts): Friday 12:00 reminder when next week's rota is unpublished"
```

---

### Task 5: Client — shared rows, screen shell, read-only grid

**Files:**
- Create: `client/src/components/shifts/shiftRows.js`, `client/src/components/shifts/ShiftGrid.jsx`, `client/src/components/shifts/ShiftsScreen.jsx`
- Modify: `client/src/App.jsx` (lazy import + route), `client/src/components/layout/navIcons.js` (icon)

**Interfaces:**
- Consumes: `GET /api/shifts/board`, `POST /api/shifts/weeks`.
- Produces:
  - `shiftRows.js`: `AREA_ROWS = [{key:'kitchen',label:'מטבח'},{key:'floater',label:'מחליפות'},{key:'unassigned',label:'ללא כיתה'}]`, `buildRows({entries, classrooms}) → [{key, label, classroom_id|null, area, cells: {[date]: Entry[]}}]` (class rows first in `classrooms` order, then kitchen, floater, then unassigned only if non-empty; entries in a cell sorted by start), `switchedSet(entries) → Set<string>` of `${employee_id}|${date}` keys where that employee has entries in more than one row that day, `fmtDate(ymd) → 'DD/MM'`, `HEB_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי']`, `rowKeyOf(entry) → string`.
  - `ShiftGrid` props: `{ dates, rows, closedDates:Set, warnings, switched:Set, editable, onCellClick(row, date), onEntryClick(entry), highlightEmployeeId }`.

- [ ] **Step 1: `client/src/components/shifts/shiftRows.js`**

```js
/**
 * Entries → the rows the board, the printout and the employee screen all draw.
 *
 * One function for all three, so the paper and the screen cannot disagree
 * about which row somebody is in — the same lesson the punch grid learned.
 */
export const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'];
export const AREA_ROWS = [
  { key: 'kitchen', label: 'מטבח' },
  { key: 'floater', label: 'מחליפות' },
  { key: 'unassigned', label: 'ללא כיתה' },
];

export const rowKeyOf = (e) => (e.area === 'class' ? `class:${e.classroom_id}` : e.area);

export function fmtDate(ymd) {
  const [, m, d] = String(ymd).split('-');
  return `${d}/${m}`;
}

export function buildRows({ entries, classrooms }) {
  const rows = [
    ...classrooms.map(c => ({ key: `class:${c._id}`, label: c.name, area: 'class', classroom_id: String(c._id), cells: {} })),
    ...AREA_ROWS.map(a => ({ key: a.key, label: a.label, area: a.key, classroom_id: null, cells: {} })),
  ];
  const byKey = new Map(rows.map(r => [r.key, r]));
  for (const e of entries || []) {
    let row = byKey.get(rowKeyOf({ ...e, classroom_id: e.classroom_id ? String(e.classroom_id) : null }));
    // A class closed after the entry was made: keep the person visible.
    if (!row) row = byKey.get('unassigned');
    (row.cells[e.date] = row.cells[e.date] || []).push(e);
  }
  for (const r of rows) for (const d of Object.keys(r.cells)) r.cells[d].sort((a, b) => String(a.start_hhmm).localeCompare(String(b.start_hhmm)));
  return rows.filter(r => r.key !== 'unassigned' || Object.keys(r.cells).length > 0);
}

/** `${employee_id}|${date}` for every person who changes rooms during a day. */
export function switchedSet(entries) {
  const rowsByKey = new Map();
  for (const e of entries || []) {
    const k = `${e.employee_id}|${e.date}`;
    if (!rowsByKey.has(k)) rowsByKey.set(k, new Set());
    rowsByKey.get(k).add(rowKeyOf({ ...e, classroom_id: e.classroom_id ? String(e.classroom_id) : null }));
  }
  return new Set([...rowsByKey].filter(([, s]) => s.size > 1).map(([k]) => k));
}
```

- [ ] **Step 2: `client/src/components/shifts/ShiftGrid.jsx`**

```jsx
import { Box, Paper, Table, TableHead, TableBody, TableRow, TableCell, Typography, Tooltip, Chip } from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { HEB_DAYS, fmtDate } from './shiftRows';

/**
 * The week as a table: a row per class (then kitchen, floaters, unplaced), a
 * column per day, people and hours in the cells. Wraps on a phone by
 * scrolling sideways inside its own box — the page itself never widens (see
 * PageHeader for what a wide page does to sticky cells on iOS).
 */
export default function ShiftGrid({ dates, rows, closedDates, warnings = [], switched, editable, onCellClick, onEntryClick, highlightEmployeeId }) {
  const warnOf = (row, date) => warnings.find(w => w.date === date && String(w.classroom_id) === String(row.classroom_id));
  return (
    <Box component={Paper} sx={{ overflowX: 'auto', borderRadius: 3 }}>
      <Table size="small" sx={{ minWidth: 760 }}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 130, fontWeight: 700 }}>כיתה</TableCell>
            {dates.map((d, i) => (
              <TableCell key={d} align="center" sx={{ fontWeight: 700, bgcolor: closedDates.has(d) ? 'action.disabledBackground' : undefined }}>
                {HEB_DAYS[i]} <Typography component="span" variant="caption" color="text.secondary">{fmtDate(d)}</Typography>
                {closedDates.has(d) && <Typography variant="caption" display="block" color="text.secondary">הגן סגור</Typography>}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(row => (
            <TableRow key={row.key}>
              <TableCell sx={{ fontWeight: 700, verticalAlign: 'top' }}>{row.label}</TableCell>
              {dates.map(d => {
                const closed = closedDates.has(d);
                const warn = row.area === 'class' && warnOf(row, d);
                return (
                  <TableCell
                    key={d}
                    onClick={editable && !closed ? () => onCellClick(row, d) : undefined}
                    sx={{
                      verticalAlign: 'top', minWidth: 110, p: 0.75,
                      cursor: editable && !closed ? 'pointer' : 'default',
                      bgcolor: closed ? 'action.disabledBackground' : (warn ? 'warning.soft' : undefined),
                      '&:hover': editable && !closed ? { bgcolor: 'action.hover' } : {},
                    }}
                  >
                    {(row.cells[d] || []).map(e => {
                      const isSwitch = switched.has(`${e.employee_id}|${e.date}`);
                      const mine = highlightEmployeeId && String(e.employee_id) === String(highlightEmployeeId);
                      return (
                        <Box
                          key={e._id || `${e.employee_id}-${e.start_hhmm}`}
                          onClick={editable ? (ev) => { ev.stopPropagation(); onEntryClick(e); } : undefined}
                          sx={{
                            mb: 0.5, px: 0.75, py: 0.25, borderRadius: 1,
                            bgcolor: mine ? 'primary.soft' : (isSwitch ? 'info.soft' : 'background.sunken'),
                            fontWeight: mine ? 700 : 500, fontSize: '0.8rem', lineHeight: 1.3,
                          }}
                        >
                          {e.employee_name}
                          <Box component="span" dir="ltr" sx={{ display: 'block', fontSize: '0.7rem', color: 'text.secondary' }}>
                            {e.start_hhmm && e.end_hhmm ? `${e.start_hhmm}–${e.end_hhmm}` : 'חסרות שעות'}
                          </Box>
                          {editable && e.new_class && <Chip size="small" label="כיתה חדשה לה" sx={{ height: 16, fontSize: '0.6rem', mt: 0.25 }} />}
                          {editable && e.alternating && <Chip size="small" label="יום מתחלף" sx={{ height: 16, fontSize: '0.6rem', mt: 0.25 }} />}
                        </Box>
                      );
                    })}
                    {warn && (
                      <Tooltip title={`${warn.enrolled} ילדים — צריך ${warn.needed} עובדות, משובצות ${warn.staff}`}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, color: 'warning.softOn', fontSize: '0.7rem' }}>
                          <WarningAmberIcon sx={{ fontSize: 14 }} /> חסרות {warn.needed - warn.staff}
                        </Box>
                      </Tooltip>
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}
```

- [ ] **Step 3: `client/src/components/shifts/ShiftsScreen.jsx` (shell: branch, week navigation, open week, read-only grid)**

```jsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Stack, Button, IconButton, Typography, Alert, CircularProgress } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useUrlState } from '../../hooks/useUrlState';
import PageHeader from '../ui/PageHeader';
import ShiftGrid from './ShiftGrid';
import { buildRows, switchedSet, fmtDate } from './shiftRows';

/** The Sunday of the week containing `date` (local), as YYYY-MM-DD. */
function sundayOf(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return sundayOf(new Date(y, m - 1, d + n));
}

export default function ShiftsScreen() {
  const { selectedBranch, isAllBranches } = useBranch();
  // Default: next week — the one being planned.
  const [week, setWeek] = useUrlState('week', addDays(sundayOf(), 7));
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!selectedBranch || isAllBranches) return;
    setLoading(true);
    try {
      const { data } = await api.get('/shifts/board', { params: { branch: selectedBranch, week } });
      setBoard(data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בטעינת הסידור');
    } finally {
      setLoading(false);
    }
  }, [selectedBranch, isAllBranches, week]);
  useEffect(() => { load(); }, [load]);

  const entries = board ? (board.week ? board.week.entries : board.preview) : [];
  const rows = useMemo(() => (board ? buildRows({ entries, classrooms: board.classrooms }) : []), [board, entries]);
  const switched = useMemo(() => switchedSet(entries), [entries]);
  const closed = useMemo(() => new Set(board?.closed_dates || []), [board]);

  const openWeek = async () => {
    try {
      await api.post('/shifts/weeks', { branch: selectedBranch, week });
      toast.success('הסידור נפתח לפי ההתחייבויות');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה בפתיחת הסידור'); }
  };

  if (isAllBranches) return <Alert severity="info">בחרו סניף אחד כדי לראות את הסידור שלו.</Alert>;

  return (
    <Box>
      <PageHeader
        title="סידור עבודה"
        meta={[
          board && { label: board.branch_name, strong: true },
          board && { label: `שבוע ${fmtDate(board.dates[0])}–${fmtDate(board.dates[5])}` },
          board?.week && { label: board.week.published_at ? (board.has_unpublished_changes ? 'יש שינויים שלא פורסמו' : 'פורסם') : 'טיוטה' },
        ]}
        primary={board && !board.week && board.can_edit ? { label: 'פתיחת סידור לשבוע', onClick: openWeek } : undefined}
      >
        <Stack direction="row" alignItems="center" spacing={1}>
          <IconButton onClick={() => setWeek(addDays(week, -7))} aria-label="שבוע קודם"><ChevronRightIcon /></IconButton>
          <Typography fontWeight={700}>{board ? `${fmtDate(board.dates[0])} – ${fmtDate(board.dates[5])}` : ''}</Typography>
          <IconButton onClick={() => setWeek(addDays(week, 7))} aria-label="שבוע הבא"><ChevronLeftIcon /></IconButton>
          <Button size="small" onClick={() => setWeek(addDays(sundayOf(), 7))}>השבוע הבא</Button>
        </Stack>
      </PageHeader>

      {loading && !board && <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress /></Stack>}
      {board && !board.week && (
        <Alert severity="info" sx={{ mb: 2 }}>
          הסידור לשבוע הזה עוד לא נפתח. זו תצוגה מקדימה לפי ההתחייבויות של העובדות.
        </Alert>
      )}
      {board && (
        <ShiftGrid
          dates={board.dates} rows={rows} closedDates={closed} warnings={board.warnings}
          switched={switched} editable={false} onCellClick={() => {}} onEntryClick={() => {}}
        />
      )}
    </Box>
  );
}
```

- [ ] **Step 4: Route + icon**

`client/src/App.jsx`: next to `const AttendanceMonitor = lazy(...)` add `const ShiftsScreen = lazy(() => import('./components/shifts/ShiftsScreen'));`. Next to `<Route path="attendance" element={<AttendanceMonitor />} />` add `<Route path="shifts" element={<ProtectedRoute tab="shifts"><ShiftsScreen /></ProtectedRoute>} />` — copy the exact `ProtectedRoute` wrapping style used by the neighbouring routes in that file (some routes rely on the shell-level guard only; follow `attendance`).

`client/src/components/layout/navIcons.js`: `import CalendarViewWeekIcon from '@mui/icons-material/CalendarViewWeek';` and in `ICON_BY_TAB` under `// כוח אדם` add `shifts: CalendarViewWeekIcon,`; under the personal-area entries add `my_shifts: CalendarViewWeekIcon,`.

- [ ] **Step 5: Build and look**

Run: `cd client && npx vite build`
Expected: `✓ built`. Then run the app locally (`npm run dev` in `client` with the server running against a dev DB) or the mocked harness, open `/shifts` as a branch manager, confirm: preview banner, rows per class + מטבח + מחליפות, closed days greyed, "פתיחת סידור לשבוע" opens the week.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/shifts client/src/App.jsx client/src/components/layout/navIcons.js
git commit -m "feat(shifts): the board screen — week navigation, preview, open week, read-only grid"
```

---

### Task 6: Client — editing (entries, closed days, primary class, classes, ratios, publish)

**Files:**
- Create: `client/src/components/shifts/EntryDialog.jsx`, `client/src/components/shifts/PrimaryClassDialog.jsx`, `client/src/components/shifts/ShiftSettingsDialog.jsx`
- Modify: `client/src/components/shifts/ShiftsScreen.jsx`

**Interfaces:**
- Consumes: Task 3 endpoints; `buildRows`, `rowKeyOf` from Task 5.
- Produces:
  - `EntryDialog` props `{ open, onClose, onSave(entry), onDelete(entry), entry|null, defaults:{date, area, classroom_id}, employees, rows }`.
  - `PrimaryClassDialog` props `{ open, onClose, pending, classrooms, onDone }`.
  - `ShiftSettingsDialog` props `{ open, onClose, board, onChanged }`.

- [ ] **Step 1: `EntryDialog.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Stack, Autocomplete } from '@mui/material';

/** Add or edit one person's block of hours in one row on one day. */
export default function EntryDialog({ open, onClose, onSave, onDelete, entry, defaults, employees, rows }) {
  const [form, setForm] = useState(null);
  useEffect(() => {
    if (!open) return;
    setForm(entry ? { ...entry } : {
      employee_id: '', employee_name: '', date: defaults.date, area: defaults.area,
      classroom_id: defaults.classroom_id, start_hhmm: '07:00', end_hhmm: '16:00', alternating: false, new_class: false,
    });
  }, [open, entry, defaults]);
  if (!form) return null;
  const rowValue = form.area === 'class' ? `class:${form.classroom_id}` : form.area;
  const employee = employees.find(e => e._id === String(form.employee_id)) || null;
  const valid = form.employee_id && form.start_hhmm && form.end_hhmm && form.start_hhmm < form.end_hhmm;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>{entry ? 'עריכת שיבוץ' : 'שיבוץ עובדת'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Autocomplete
            options={employees} value={employee} disabled={!!entry}
            getOptionLabel={o => o.full_name}
            onChange={(_, v) => setForm(f => ({ ...f, employee_id: v ? v._id : '', employee_name: v ? v.full_name : '' }))}
            renderInput={p => <TextField {...p} label="עובדת" />}
          />
          <TextField
            select label="כיתה / שורה" value={rowValue}
            onChange={e => {
              const v = e.target.value;
              setForm(f => (v.startsWith('class:') ? { ...f, area: 'class', classroom_id: v.slice(6) } : { ...f, area: v, classroom_id: null }));
            }}
          >
            {rows.map(r => <MenuItem key={r.key} value={r.key}>{r.label}</MenuItem>)}
          </TextField>
          <Stack direction="row" spacing={1}>
            <TextField label="משעה" type="time" value={form.start_hhmm} onChange={e => setForm(f => ({ ...f, start_hhmm: e.target.value }))} InputLabelProps={{ shrink: true }} fullWidth />
            <TextField label="עד שעה" type="time" value={form.end_hhmm} onChange={e => setForm(f => ({ ...f, end_hhmm: e.target.value }))} InputLabelProps={{ shrink: true }} fullWidth />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        {entry && <Button color="error" onClick={() => onDelete(entry)} sx={{ mr: 'auto' }}>{entry.alternating ? 'יום חופש השבוע' : 'הסרה'}</Button>}
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" disabled={!valid} onClick={() => onSave(form)}>שמירה</Button>
      </DialogActions>
    </Dialog>
  );
}
```

- [ ] **Step 2: `PrimaryClassDialog.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Stack, Typography, Alert } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * Most employee cards have no primary class. The rota needs one, so the first
 * time a manager opens it she is asked — with a guess read from the
 * commitment's free text — and the answer is saved on the card for good.
 */
export default function PrimaryClassDialog({ open, onClose, pending, classrooms, onDone }) {
  const [choice, setChoice] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setChoice(Object.fromEntries(pending.map(p => [p.employee_id, p.suggestion || ''])));
  }, [open, pending]);
  const nameOf = (id) => classrooms.find(c => c._id === id)?.name || id;

  const save = async () => {
    setSaving(true);
    try {
      for (const p of pending) {
        if (!choice[p.employee_id]) continue;
        await api.post('/shifts/primary-class', { employee_id: p.employee_id, classroom_id: choice[p.employee_id] });
      }
      toast.success('הכיתות הראשיות נשמרו');
      onDone();
    } catch (err) { toast.error(err.response?.data?.error || 'שמירה נכשלה'); } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>כיתה ראשית לעובדות</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2 }}>לעובדות האלה אין כיתה ראשית. הבחירה נשמרת בכרטיס העובדת.</Alert>
        <Stack spacing={2}>
          {pending.map(p => (
            <Stack key={p.employee_id} direction="row" spacing={2} alignItems="center">
              <Typography sx={{ flex: 1 }}>{p.full_name}{p.commitment_text ? ` (בהתחייבות: ${p.commitment_text})` : ''}</Typography>
              <TextField select size="small" sx={{ minWidth: 180 }} label="כיתה" value={choice[p.employee_id] || ''}
                onChange={e => setChoice(c => ({ ...c, [p.employee_id]: e.target.value }))}>
                <MenuItem value="">לא עכשיו</MenuItem>
                {(p.candidates.length ? p.candidates : classrooms.map(c => c._id)).map(id => <MenuItem key={id} value={id}>{nameOf(id)}</MenuItem>)}
              </TextField>
            </Stack>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>אחר כך</Button>
        <Button variant="contained" onClick={save} disabled={saving}>שמירה</Button>
      </DialogActions>
    </Dialog>
  );
}
```

- [ ] **Step 3: `ShiftSettingsDialog.jsx` (ratios, close/reopen class)**

```jsx
import { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Stack, Typography, Divider, MenuItem } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

export default function ShiftSettingsDialog({ open, onClose, board, onChanged }) {
  const [ratios, setRatios] = useState({ infants: '', young: '', older: '' });
  const [closeId, setCloseId] = useState('');
  const [reopenId, setReopenId] = useState('');
  useEffect(() => { if (open && board) setRatios(board.ratios); }, [open, board]);
  if (!board) return null;
  const branchId = board.branch_id;

  const call = async (fn, ok) => {
    try { await fn(); toast.success(ok); onChanged(); } catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>הגדרות סידור</DialogTitle>
      <DialogContent>
        <Typography fontWeight={700} sx={{ mt: 1, mb: 1 }}>יחס חניכה (ילדים לעובדת)</Typography>
        <Stack direction="row" spacing={1}>
          {[['infants', 'תינוקייה'], ['young', 'צעירים'], ['older', 'בוגרים']].map(([k, label]) => (
            <TextField key={k} type="number" label={label} value={ratios[k] ?? ''} size="small"
              onChange={e => setRatios(r => ({ ...r, [k]: e.target.value }))} />
          ))}
        </Stack>
        <Button sx={{ mt: 1 }} disabled={!branchId} onClick={() => call(() => api.put(`/shifts/ratios/${branchId}`, ratios), 'היחסים נשמרו')}>שמירת יחסים</Button>
        <Typography variant="caption" display="block" color="text.secondary">שדה ריק = ברירת המחדל של העיר.</Typography>

        <Divider sx={{ my: 2 }} />
        <Typography fontWeight={700} sx={{ mb: 1 }}>סגירת כיתה שלא קיימת כרגע</Typography>
        <Stack direction="row" spacing={1}>
          <TextField select size="small" fullWidth label="כיתה" value={closeId} onChange={e => setCloseId(e.target.value)}>
            {board.classrooms.map(c => <MenuItem key={c._id} value={c._id}>{c.name} ({c.enrolled} ילדים)</MenuItem>)}
          </TextField>
          <Button color="warning" disabled={!closeId} onClick={() => call(() => api.post(`/shifts/classrooms/${closeId}/close`), 'הכיתה נסגרה')}>סגירה</Button>
        </Stack>
        <Typography fontWeight={700} sx={{ mt: 2, mb: 1 }}>פתיחת כיתה מחדש</Typography>
        <Stack direction="row" spacing={1}>
          <TextField select size="small" fullWidth label="כיתה סגורה" value={reopenId} onChange={e => setReopenId(e.target.value)}>
            {board.inactive_classrooms.map(c => <MenuItem key={c._id} value={c._id}>{c.name} · {c.academic_year}</MenuItem>)}
          </TextField>
          <Button disabled={!reopenId} onClick={() => call(() => api.post(`/shifts/classrooms/${reopenId}/reopen`), 'הכיתה נפתחה')}>פתיחה</Button>
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>סגירה</Button></DialogActions>
    </Dialog>
  );
}
```

Ratios need a branch id even before a week exists, which is why `getBoard` returns `branch_id` (Task 2).

- [ ] **Step 4: Wire editing into `ShiftsScreen.jsx`**

Add state and handlers (inside the component, after `openWeek`):

```jsx
  const [draft, setDraft] = useState(null);          // working entries while editing
  const [dlg, setDlg] = useState({ open: false, entry: null, defaults: null });
  const [primaryOpen, setPrimaryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => { setDraft(board?.week ? board.week.entries : null); }, [board]);
  useEffect(() => { if (board?.can_edit && board.pending_primary.length) setPrimaryOpen(true); }, [board]);

  const editable = !!(board?.week && (board.can_edit || board.can_request));
  const shown = draft || entries;

  const persist = async (next) => {
    if (board.can_edit) {
      try {
        const { data } = await api.put(`/shifts/weeks/${board.week._id}/entries`, { entries: next });
        setDraft(data.week.entries);
        load();
      } catch (err) { toast.error(err.response?.data?.error || 'שמירה נכשלה'); }
    } else {
      setDraft(next); // office: edits stay local until sent as a request
    }
  };
  const saveEntry = (form) => {
    const next = form._id || form.tmp
      ? shown.map(e => ((e._id && e._id === form._id) || (e.tmp && e.tmp === form.tmp) ? form : e))
      : [...shown, { ...form, tmp: String(Date.now()) }];
    setDlg({ open: false, entry: null, defaults: null });
    persist(next);
  };
  const deleteEntry = (entry) => {
    setDlg({ open: false, entry: null, defaults: null });
    persist(shown.filter(e => e !== entry && !(e._id && e._id === entry._id)));
  };
  const toggleClosed = async (date, closedNow) => {
    if (!closedNow && !window.confirm('סגירת היום תמחק את כל השיבוצים בו. להמשיך?')) return;
    try { await api.post(`/shifts/weeks/${board.week._id}/closed-days`, { date, closed: !closedNow }); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
  };
  const publish = async () => {
    try {
      const { data } = await api.post(`/shifts/weeks/${board.week._id}/publish`);
      toast.success(data.notified ? `הסידור נסגר — ${data.notified} עובדות קיבלו התראה` : 'הסידור נסגר');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
  };
  const sendRequest = async () => {
    try { await api.post(`/shifts/weeks/${board.week._id}/edit-requests`, { entries: draft }); toast.success('הבקשה נשלחה למנהלת הסניף'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'שליחה נכשלה'); }
  };
```

Recompute `rows` and `switched` from `shown` instead of `entries` (change both `useMemo` calls to use `shown`, dependency `[board, shown]`).

Replace the `primary` prop of `PageHeader` with:

```jsx
        primary={!board ? undefined
          : !board.week ? (board.can_edit ? { label: 'פתיחת סידור לשבוע', onClick: openWeek } : undefined)
          : board.can_edit ? { label: board.week.published_at ? 'סגירת סידור (פרסום שינויים)' : 'סגירת סידור ופרסום', onClick: publish, disabled: !board.has_unpublished_changes }
          : board.can_request ? { label: 'שליחת בקשת שינוי למנהלת', onClick: sendRequest, disabled: !draft } : undefined}
        actions={board?.can_edit ? [{ label: 'הגדרות', onClick: () => setSettingsOpen(true) }] : []}
```

Pass to `ShiftGrid`: `editable={editable}`, `onCellClick={(row, date) => setDlg({ open: true, entry: null, defaults: { date, area: row.area, classroom_id: row.classroom_id } })}`, `onEntryClick={(entry) => setDlg({ open: true, entry, defaults: null })}`, and `rows`/`switched` computed from `shown`.

Add a closed-day toggle row above the grid when `board.can_edit && board.week`:

```jsx
        <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }} useFlexGap>
          {board.dates.map((d, i) => {
            const manual = board.week.closed_days.includes(d);
            const holiday = closed.has(d) && !manual;
            return (
              <Button key={d} size="small" variant={manual ? 'contained' : 'outlined'} color="inherit" disabled={holiday}
                onClick={() => toggleClosed(d, manual)}>
                {holiday ? `${fmtDate(d)} — חג` : manual ? `${fmtDate(d)} — סגור (פתיחה)` : `סגירת ${fmtDate(d)}`}
              </Button>
            );
          })}
        </Stack>
```

Render the dialogs at the end of the component:

```jsx
      <EntryDialog open={dlg.open} onClose={() => setDlg({ open: false, entry: null, defaults: null })}
        entry={dlg.entry} defaults={dlg.defaults || {}} employees={board?.employees || []} rows={rows}
        onSave={saveEntry} onDelete={deleteEntry} />
      {board && <PrimaryClassDialog open={primaryOpen} onClose={() => setPrimaryOpen(false)} pending={board.pending_primary}
        classrooms={board.classrooms} onDone={() => { setPrimaryOpen(false); load(); }} />}
      <ShiftSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} board={board} onChanged={load} />
```

Imports to add: `EntryDialog`, `PrimaryClassDialog`, `ShiftSettingsDialog`. Strip the client-only `tmp` key before sending: in `persist`, send `next.map(({ tmp, ...e }) => e)`.

- [ ] **Step 5: Build and check manually**

Run: `cd client && npx vite build` → `✓ built`.
Manual (branch manager): open week → add entry in a class → shows; add an overlapping entry for the same person → toast with the overlap message; place someone in a new class → "כיתה חדשה לה"; close a day → entries gone, column greyed; reopen; publish → status "פורסם"; edit again → "יש שינויים שלא פורסמו"; settings → change ratio → warnings recompute. As admin: edit → "שליחת בקשת שינוי למנהלת".

- [ ] **Step 6: Commit**

```bash
git add client/src/components/shifts
git commit -m "feat(shifts): editing — entries, closed days, primary class, classes, ratios, publish, office requests"
```

---

### Task 7: Client — edit requests panel, export (PDF + PNG)

**Files:**
- Create: `client/src/components/shifts/EditRequestsPanel.jsx`, `client/src/components/shifts/shiftExport.js`
- Modify: `client/src/components/shifts/ShiftsScreen.jsx`, `client/package.json` (add `"html2canvas": "^1.4.1"` to dependencies, then `npm install` in `client`)

**Interfaces:**
- Consumes: `buildRows`, `switchedSet`, `fmtDate`, `HEB_DAYS`; `POST /api/shifts/edit-requests/:id/decide`.
- Produces: `exportPdf({ branchName, dates, rows, switched, closedDates })`, `exportPng({ … same })` (one PNG per page of 8 rows), `pagesOf(rows, perPage = 8) → rows[][]`, `exportHtml({ … , pageRows }) → string`.

- [ ] **Step 1: `shiftExport.js`**

```js
import { HEB_DAYS, fmtDate } from './shiftRows';

/**
 * The rota on paper (PDF) and as an image (PNG) for the staff WhatsApp group.
 *
 * PDF goes through a print window with @page CSS, not html2pdf: html2pdf
 * produced empty PDFs on macOS Safari/Chrome for the punch grid (see
 * AttendanceMonitor.jsx exportPDF). Ratio warnings and "new class" flags are
 * the manager's, not the staff's, and are not drawn.
 */
const ROWS_PER_PAGE = 8;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function pagesOf(rows, perPage = ROWS_PER_PAGE) {
  const out = [];
  for (let i = 0; i < rows.length; i += perPage) out.push(rows.slice(i, i + perPage));
  return out.length ? out : [[]];
}

function tableHtml({ branchName, dates, pageRows, switched, closedDates, pageNo, pageCount }) {
  const head = dates.map((d, i) => `<th>${HEB_DAYS[i]}<br><span class="d">${fmtDate(d)}</span></th>`).join('');
  const body = pageRows.map(r => `<tr><th class="row">${esc(r.label)}</th>${dates.map(d => {
    if (closedDates.has(d)) return '<td class="closed">סגור</td>';
    return `<td>${(r.cells[d] || []).map(e => `<div class="e${switched.has(`${e.employee_id}|${e.date}`) ? ' sw' : ''}">${esc(e.employee_name)}<span dir="ltr">${esc(e.start_hhmm)}–${esc(e.end_hhmm)}</span></div>`).join('')}</td>`;
  }).join('')}</tr>`).join('');
  return `<section class="page"><h1>סידור עבודה — ${esc(branchName)}</h1>
    <div class="sub">שבוע ${fmtDate(dates[0])}–${fmtDate(dates[dates.length - 1])}${pageCount > 1 ? ` · עמוד ${pageNo}/${pageCount}` : ''}</div>
    <table><thead><tr><th class="row">כיתה</th>${head}</tr></thead><tbody>${body}</tbody></table>
    <div class="legend"><span class="sw-box"></span> מעבר כיתה באמצע היום</div></section>`;
}

const STYLE = `
  @page { size: A4 landscape; margin: 8mm; }
  * { box-sizing: border-box; }
  body { font-family: "Assistant", Arial, sans-serif; direction: rtl; margin: 0; background: #fff; color: #111; }
  .page { width: 277mm; padding: 2mm; page-break-after: always; background: #fff; }
  .page:last-child { page-break-after: auto; }
  h1 { font-size: 16pt; margin: 0 0 1mm; } .sub { font-size: 9pt; color: #555; margin-bottom: 3mm; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 8.5pt; }
  th, td { border: 1px solid #999; padding: 1.5mm; vertical-align: top; }
  thead th { background: #eee; } th.row { width: 28mm; background: #f6f6f6; text-align: right; }
  .d { font-weight: 400; color: #555; } td.closed { background: #ddd; color: #666; text-align: center; }
  .e { margin-bottom: 1mm; font-weight: 600; } .e span { display: block; font-weight: 400; font-size: 7.5pt; color: #444; }
  .e.sw { background: #dbeafe; border-radius: 1mm; padding: 0.5mm 1mm; }
  .legend { font-size: 7.5pt; color: #555; margin-top: 2mm; } .sw-box { display: inline-block; width: 8px; height: 8px; background: #dbeafe; border: 1px solid #93c5fd; }
`;

export function exportHtml({ branchName, dates, rows, switched, closedDates }) {
  const pages = pagesOf(rows);
  return pages.map((pageRows, i) => tableHtml({ branchName, dates, pageRows, switched, closedDates, pageNo: i + 1, pageCount: pages.length })).join('');
}

export function exportPdf(args) {
  const win = window.open('', '_blank', 'width=1200,height=850');
  if (!win) { alert('הדפדפן חסם את החלון — אפשרו חלונות קופצים לאתר'); return; }
  win.document.write(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>סידור עבודה</title><style>${STYLE}</style></head><body>${exportHtml(args)}<script>window.onload=()=>{window.print();}</script></body></html>`);
  win.document.close();
}

export async function exportPng(args) {
  const { default: html2canvas } = await import('html2canvas');
  // Off-screen on an OUTER wrapper with a forced white background — the
  // blank-page trap documented in utils/contractPdf.js.
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;left:-10000px;top:0;background:#fff;';
  wrap.innerHTML = `<style>${STYLE}</style>${exportHtml(args)}`;
  document.body.appendChild(wrap);
  try {
    const pages = [...wrap.querySelectorAll('.page')];
    for (let i = 0; i < pages.length; i += 1) {
      const canvas = await html2canvas(pages[i], { scale: 2, backgroundColor: '#ffffff' });
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `סידור-${args.branchName}-${args.dates[0]}${pages.length > 1 ? `-${i + 1}` : ''}.png`;
      a.click();
    }
  } finally {
    wrap.remove();
  }
}
```

- [ ] **Step 2: `EditRequestsPanel.jsx`**

```jsx
import { useState } from 'react';
import { Alert, Stack, Button, TextField, Typography } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

/** The office's pending proposals for this week, for the branch manager to approve or refuse with a reason. */
export default function EditRequestsPanel({ requests, onDecided }) {
  const [reason, setReason] = useState({});
  if (!requests?.length) return null;
  const decide = async (id, approve) => {
    try {
      await api.post(`/shifts/edit-requests/${id}/decide`, { approve, reason: reason[id] || '' });
      toast.success(approve ? 'השינוי אושר והוחל' : 'הבקשה נדחתה');
      onDecided();
    } catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
  };
  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      {requests.map(r => (
        <Alert key={r._id} severity="warning">
          <Typography fontWeight={700}>{r.requested_by_name || 'המשרד'} מבקש/ת לשנות את הסידור ({r.entries.length} שיבוצים)</Typography>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
            <Button size="small" variant="contained" onClick={() => decide(r._id, true)}>אישור והחלה</Button>
            <TextField size="small" placeholder="סיבת דחייה" value={reason[r._id] || ''} onChange={e => setReason(s => ({ ...s, [r._id]: e.target.value }))} />
            <Button size="small" color="error" onClick={() => decide(r._id, false)}>דחייה</Button>
          </Stack>
        </Alert>
      ))}
    </Stack>
  );
}
```

- [ ] **Step 3: Wire into `ShiftsScreen.jsx`**

Imports: `EditRequestsPanel`, `{ exportPdf, exportPng }`. Above the grid: `{board?.can_edit && <EditRequestsPanel requests={board.edit_requests} onDecided={load} />}`. Add to `PageHeader` `menu`:

```jsx
        menu={board ? [
          { label: 'ייצוא PDF להדפסה', onClick: () => exportPdf({ branchName: board.branch_name, dates: board.dates, rows, switched, closedDates: closed }) },
          { label: 'ייצוא תמונה (PNG)', onClick: () => exportPng({ branchName: board.branch_name, dates: board.dates, rows, switched, closedDates: closed }) },
        ] : []}
```

Export uses what is on screen (`rows` from `shown`). If the user is about to share, the published state is what matters — add one line in the menu label when `board.has_unpublished_changes`: label `'ייצוא PDF (כולל שינויים שלא פורסמו)'`.

- [ ] **Step 4: Install, build, check**

Run: `cd client && npm install html2canvas@^1.4.1 && npx vite build`
Expected: `✓ built`. Manual: PDF opens a print window, landscape, one table per 8 rows; PNG downloads; a person with two rooms in a day is light-blue in both; no warning text in either.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/shifts client/package.json client/package-lock.json
git commit -m "feat(shifts): office edit requests panel, PDF and PNG export"
```

---

### Task 8: Employee screen "המשמרות שלי" + help entries + full verification

**Files:**
- Create: `client/src/components/employee-portal/MyShifts.jsx`
- Modify: `client/src/App.jsx` (route `my-shifts`), `client/src/config/screenHelp.js` (entries `shifts`, `my_shifts`)

**Interfaces:**
- Consumes: `GET /api/shifts/my?week=`; `buildRows`, `switchedSet`, `fmtDate`, `ShiftGrid`.

- [ ] **Step 1: `MyShifts.jsx`**

```jsx
import { useEffect, useMemo, useState } from 'react';
import { Box, Stack, Typography, Alert, ToggleButtonGroup, ToggleButton, LinearProgress } from '@mui/material';
import api from '../../api/client';
import ShiftGrid from '../shifts/ShiftGrid';
import { buildRows, switchedSet, fmtDate } from '../shifts/shiftRows';

function sunday(offsetWeeks) {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() + offsetWeeks * 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The published rota of her branch — this week and next — with her own hours marked. */
export default function MyShifts() {
  const initial = new URLSearchParams(window.location.search).get('week') || sunday(0);
  const [week, setWeek] = useState(initial);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    api.get('/shifts/my', { params: { week } }).then(r => setData(r.data)).catch(() => setData({ error: true })).finally(() => setLoading(false));
  }, [week]);

  const classrooms = useMemo(() => {
    if (!data?.entries) return [];
    const used = new Set(data.entries.filter(e => e.area === 'class').map(e => String(e.classroom_id)));
    return (data.classrooms || []).filter(c => used.has(c._id));
  }, [data]);
  const rows = useMemo(() => (data?.entries ? buildRows({ entries: data.entries, classrooms }) : []), [data, classrooms]);
  const switched = useMemo(() => switchedSet(data?.entries || []), [data]);

  return (
    <Box sx={{ maxWidth: 1000, mx: 'auto' }}>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 2 }}>המשמרות שלי</Typography>
      <ToggleButtonGroup exclusive size="small" value={week} onChange={(_, v) => v && setWeek(v)} sx={{ mb: 2 }}>
        <ToggleButton value={sunday(0)}>השבוע</ToggleButton>
        <ToggleButton value={sunday(1)}>שבוע הבא</ToggleButton>
      </ToggleButtonGroup>
      {loading && <LinearProgress />}
      {data?.reason === 'no_employee' && <Alert severity="warning">לא נמצא כרטיס עובדת מקושר למשתמש שלך. פני למשרד.</Alert>}
      {data?.error && <Alert severity="error">לא הצלחנו לטעון את הסידור</Alert>}
      {data && data.published === false && <Alert severity="info">הסידור לשבוע {fmtDate(week)} עוד לא פורסם.</Alert>}
      {data?.published && (
        <Stack spacing={1}>
          <Typography color="text.secondary">{data.branch_name} · המשמרות שלך מודגשות</Typography>
          <ShiftGrid dates={data.dates} rows={rows} closedDates={new Set()} switched={switched} editable={false}
            onCellClick={() => {}} onEntryClick={() => {}} highlightEmployeeId={data.me} />
        </Stack>
      )}
    </Box>
  );
}
```

- [ ] **Step 2: Route**

`client/src/App.jsx`: `const MyShifts = lazy(() => import('./components/employee-portal/MyShifts'));` next to `MyAttendance`; `<Route path="my-shifts" element={<MyShifts />} />` next to `my-attendance` (same guard style as `my-attendance`).

- [ ] **Step 3: Help entries** — `client/src/config/screenHelp.js`, next to `attendance:` and `my_attendance:`

```js
  shifts: {
    summary: 'סידור העבודה השבועי של הסניף: מי עובדת באיזו כיתה, בכל יום, ובאילו שעות.',
    can: [
      'לפתוח סידור לשבוע — הוא נבנה לבד לפי ההתחייבויות של העובדות',
      'לשבץ, להזיז ולשנות שעות, גם מעבר כיתה באמצע היום',
      'לסגור יום חריג, לסגור כיתה שלא קיימת או לפתוח אותה מחדש',
      'לסגור את הסידור ולשלוח אותו לעובדות, ולהוציא PDF או תמונה',
    ],
    notes: [
      'אזהרת יחס חניכה היא רק אזהרה — היא לא חוסמת שמירה, ועובדות והורים לא רואים אותה.',
      'המשרד רואה את כל הסניפים, אבל שינוי שלו נכנס לסידור רק אחרי אישור של מנהלת הסניף.',
    ],
  },
```

```js
  my_shifts: {
    summary: 'הסידור של הסניף שלך לשבוע הזה ולשבוע הבא, עם המשמרות שלך מודגשות.',
    can: [
      'לראות באיזו כיתה ובאילו שעות את עובדת בכל יום',
      'לראות מי עובדת איתך',
    ],
    notes: [
      'הסידור מופיע כאן רק אחרי שמנהלת הסניף סגרה אותו. כשהוא משתנה אצלך, תקבלי התראה.',
    ],
  },
```

Match the exact key structure of the neighbouring entries (`summary`, `can`, `notes`, and `questions` if the neighbours have it — read `attendance` first).

- [ ] **Step 4: Full verification**

Run, each must pass:
```bash
cd server
node scripts/shifts-rules.test.js
node scripts/shifts-service.test.js
node scripts/shift-reminder.test.js
npm run test:tabs-sync
npm run test:nav-model
npm run test:screen-meta
npm run test:screen-help
cd ../client && npx vite build
```
Manual as a teacher: `/my-shifts` shows "עוד לא פורסם" before publishing; after the manager publishes, the grid with her entries bold; the push notification opens `/my-shifts?week=…`.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/employee-portal/MyShifts.jsx client/src/App.jsx client/src/config/screenHelp.js
git commit -m "feat(shifts): המשמרות שלי for employees, help entries"
```

---

## Self-review notes

- Spec §1 rows → Task 5 `buildRows`; §2 seeding → Task 1 `buildSeedEntries` + Task 2 `createWeek`; §3 overlaps → Task 1/2; §4 new class → Task 2 `applyEntries`; §5 primary prompt → Task 1 `suggestPrimary` + Task 2 `getBoard.pending_primary` + Task 6 dialog; §6 closed days → Task 2 `closedDatesFor`/`setClosedDay` + Task 6 buttons; §7 classes → Task 2 + Task 6 settings; §8 ratios → Task 1/2 + Task 6 settings; §9 publish/diff → Task 1 `affectedEmployeeIds` + Task 2 `publishWeek`; §10 reminder → Task 4; §11 export → Task 7; §12 employee screen → Task 8; §13 permissions → Task 2 `canView/canEdit` + Task 3 `requireTab`.
- `getBoard` returns `branch_id` (Task 2) because the settings dialog (Task 6) saves ratios before a week exists.
- Interfaces line for `getBoard` lists the payload; `can_request` and `branch_id` are part of it.
