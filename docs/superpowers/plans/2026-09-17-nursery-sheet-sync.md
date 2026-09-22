# Nursery Sheet Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the old Apps Script board's Google Sheet and the new `DailyLog` board agreeing with each other in both directions, so the gan can close the old board on a day of its choosing instead of in a migration.

**Architecture:** A sync service reads and writes the sheet directly through the Google Sheets API with a service account; the Apps Script is never touched. Each pass compares three sides — the sheet, our database, and a stored shadow of what the sheet held last pass — so every field is classifiable as "they changed it", "we changed it", or a genuine conflict. Parsing reuses `scripts/lib/nursery-history.js`, which already maps the sheet's Hebrew columns onto `DailyLog` and is already tested.

**Tech Stack:** Node, Express, Mongoose, `google-auth-library` (already a dependency), `xlsx` (already a dependency, used only by the existing history importer and the offline fixtures). No new runtime dependency is added.

**Spec:** `docs/superpowers/specs/2026-09-17-nursery-sheet-sync-design.md`

## Global Constraints

- **The Apps Script is never read, edited, or redeployed.** All access is to the Google Sheet.
- **Row count in the sheet is never changed.** Writes set cell values only. No `insertRows`, no `deleteRows`, no append, in any tab. Changing the row count corrupts the old board's own positional reading of itself.
- **Blank rows are data.** In `סדר יום` a child with nothing filled in is an empty row that holds the alignment. Any code that drops blank rows without carrying the absolute row index shifts every child below onto the wrong record.
- **Dry run is the default.** Every entry point makes no writes unless explicitly asked. `--write` for scripts, `mode: 'write'` for the service.
- **Identity is `AccessID` or row position, never the name.** `נדיה גרוס` exists twice in this data.
- **Conflict rule:** the sheet wins the field; our value is preserved in `DailyLog.sync_conflicts` and rendered on the board. Nothing is deleted silently.
- **Menu sync is out of scope** for this plan. `תפריט` is the dish bank, not a day's selection.
- **צעירים and בוגרים are out of scope.** תינוקייה only, two branches.
- Sheet ids: משה דיין `19t4MY0z4Y4UNLanpqlFz-E4HqolmG7wrIsQNDLKTOMw`, קפלן `1R5XL3-RC0UggFaLjjO2WcAd96ZTz9M4F7aLEEE6_8KQ`.
- Tab names come from `SHEET` in `scripts/lib/nursery-history.js`: `ילדים`, `היסטוריה`, `סדר יום`, `הגדרות`, `תפריט`.
- Dates are `YYYY-MM-DD` strings in `Asia/Jerusalem`, matching `DailyLog.date`. Never a `Date`.
- Tests are plain node scripts under `server/scripts/*.test.js`, registered in `server/package.json` as `test:<name>`, following the existing suites. No test framework, no network, no real sheet.

---

## File Structure

**Created:**

- `server/src/services/sheet-sync/three-way.js` — the merge core. Pure: takes (sheet, ours, shadow), returns (in, out, conflicts). Where correctness lives; depends on nothing.
- `server/src/services/sheet-sync/sheets-client.js` — Google Sheets API wrapper: auth, read a tab as a grid, write cell ranges. Knows nothing about the gan. Created in Task 1, extended in Task 4.
- `server/src/services/sheet-sync/roster.js` — pairs `ילדים` rows to `סדר יום` rows by absolute row index, and to `Child` documents by `sheet_access_id`.
- `server/src/services/sheet-sync/run.js` — one sync pass for one branch. Fetch, compare, apply, record.
- `server/src/services/sheet-sync/nightly.js` — the archive check.
- `server/src/services/sheetSyncJob.js` — the tick, following the shape of `cibusSyncJob`.
- `server/src/models/SheetSyncState.js` — the shadow plus the run log.
- `server/scripts/sheet-sync-match.js` — the one-off match report.
- `server/scripts/sheet-sync-probe.js` — read-only connectivity and shape probe.
- Test files: `sheet-sync-three-way.test.js`, `sheet-sync-roster.test.js`, `sheet-sync-run.test.js`, `sheet-sync-nightly.test.js`.
- `server/scripts/fixtures/sheet-sync/` — captured grids, committed, so no test needs a network.

**Modified:**

- `server/scripts/lib/nursery-history.js` — add `parseChildRows` (row-aware roster) beside the existing `parseChildren`. Nothing existing changes behaviour.
- `server/src/models/Child.js` — add `sheet_access_id`.
- `server/src/models/DailyLog.js` — add `sync_conflicts`.
- `server/src/index.js` — register the job.
- `server/package.json` — test scripts.
- `client/src/components/nursery/NurseryBoard.jsx` — render conflicts.

---

## Task 1: A read-only probe, and the credentials to run it

**Files:**
- Create: `server/src/services/sheet-sync/sheets-client.js` (auth and reading; Task 4 adds the rest)
- Create: `server/scripts/sheet-sync-probe.js`
- Create: `docs/superpowers/plans/2026-09-17-sheet-sync-credentials.md`

**Interfaces:**
- Consumes: nothing.
- Produces: from `sheets-client.js` — `credentialsFromEnv()`, `clientFor(credentials)`, `tabNames(auth, sheetId)`, `readTab(auth, sheetId, title)`, `SCOPES`. From the probe script — `probe({ sheetId })`.

**Note on direction:** `src/` never imports `scripts/` anywhere in this repo. The auth and read helpers therefore live in `src/services/sheet-sync/sheets-client.js` and the probe **script** imports them, not the other way round.

This task exists first because everything downstream assumes the server can reach the sheet, and that assumption is the user's Google account, not code. It ends with a printout of the live board.

- [ ] **Step 1: Write the credentials document**

Create `docs/superpowers/plans/2026-09-17-sheet-sync-credentials.md` with exactly these steps for the user:

```markdown
# Giving the server access to the two sheets

1. Open https://console.cloud.google.com/ and pick (or create) a project.
2. APIs & Services → Library → enable **Google Sheets API**.
3. APIs & Services → Credentials → Create credentials → **Service account**.
   Name it `gan-sheet-sync`. No roles needed.
4. Open the new service account → Keys → Add key → Create new key → **JSON**.
   A file downloads. It contains a private key: treat it like a password.
5. Copy the service account's email address. It looks like
   `gan-sheet-sync@<project>.iam.gserviceaccount.com`.
6. Open each of the two sheets in Google Sheets → Share → paste that address →
   give it **Editor** → uncheck "Notify people" → Share.
   - לוח עדכונים דיגיטלי - סניף משה דיין - תינוקייה - אפליקצייה
   - לוח עדכונים דיגיטלי - סניף קפלן - תינוקייה - אפליקצייה
7. On Render, add the whole JSON file's contents as one environment variable
   named `GOOGLE_SHEETS_CREDENTIALS`.

The key never enters the repository. `.env` and Render hold it; nothing else.
```

- [ ] **Step 2a: Write the client's auth and read half**

Create `server/src/services/sheet-sync/sheets-client.js`:

```js
/**
 * The Google Sheets API, and nothing about the gan.
 *
 * Lives in src/ rather than beside the probe script because src/ never
 * imports scripts/ anywhere in this repository, and the sync service needs
 * these same three functions. Task 4 adds the writing half here.
 */
const { JWT } = require('google-auth-library');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function credentialsFromEnv() {
  const raw = process.env.GOOGLE_SHEETS_CREDENTIALS;
  if (!raw) throw new Error('GOOGLE_SHEETS_CREDENTIALS is not set');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('GOOGLE_SHEETS_CREDENTIALS is not valid JSON'); }
  if (!parsed.client_email || !parsed.private_key) throw new Error('GOOGLE_SHEETS_CREDENTIALS has no client_email/private_key');
  return parsed;
}

function clientFor(credentials) {
  return new JWT({ email: credentials.client_email, key: credentials.private_key, scopes: SCOPES });
}

/** Every tab name in the spreadsheet. */
async function tabNames(auth, sheetId) {
  const res = await auth.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
  });
  return (res.data.sheets || []).map(s => s.properties.title);
}

/**
 * One tab as a grid of raw cell values.
 *
 * UNFORMATTED_VALUE is deliberate: it gives times as day fractions and
 * portions as fractions, which is exactly what `cellToTime` and
 * `cellToPortion` in nursery-history.js already expect. Asking for
 * FORMATTED_VALUE would hand back locale-rendered strings and move the
 * parsing problem somewhere with no tests.
 */
async function readTab(auth, sheetId, title) {
  const range = encodeURIComponent(String(title));
  const res = await auth.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`
      + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER',
  });
  return res.data.values || [];
}

module.exports = { SCOPES, credentialsFromEnv, clientFor, tabNames, readTab };
```

- [ ] **Step 2b: Write the probe script**

Create `server/scripts/sheet-sync-probe.js`:

```js
/**
 * Read-only: can we reach the sheet, and does it look like the spec says.
 *
 * Writes nothing, ever — there is no --write and no code path that could
 * acquire one. It exists to be run before anything is built on top of it,
 * and again whenever the sheet surprises us.
 *
 *   node scripts/sheet-sync-probe.js --sheet <id>
 */
const {
  credentialsFromEnv, clientFor, tabNames, readTab,
} = require('../src/services/sheet-sync/sheets-client');

async function probe({ sheetId, credentials }) {
  const auth = clientFor(credentials);
  const tabs = await tabNames(auth, sheetId);
  const children = await readTab(auth, sheetId, 'ילדים');
  const today = await readTab(auth, sheetId, 'סדר יום');
  const history = await readTab(auth, sheetId, 'היסטוריה');
  const dates = history.slice(1).map(r => String(r[0] || ''));
  const todayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return {
    tabs,
    rows: { children: children.length, today: today.length, history: history.length },
    todayHasCurrentDate: dates.includes(todayKey),
    sample: { childrenHead: children.slice(0, 3), todayHead: today.slice(0, 3) },
  };
}

module.exports = { probe };

if (require.main === module) {
  const i = process.argv.indexOf('--sheet');
  const sheetId = i > -1 ? process.argv[i + 1] : null;
  if (!sheetId) { console.error('usage: node scripts/sheet-sync-probe.js --sheet <id>'); process.exit(1); }
  probe({ sheetId, credentials: credentialsFromEnv() })
    .then(r => { console.log(JSON.stringify(r, null, 2)); })
    .catch(e => { console.error('probe failed:', e.message); process.exit(1); });
}
```

- [ ] **Step 3: Run the probe against משה דיין**

Run:

```bash
cd server && node scripts/sheet-sync-probe.js --sheet 19t4MY0z4Y4UNLanpqlFz-E4HqolmG7wrIsQNDLKTOMw
```

Expected: `tabs` contains all five of `ילדים`, `היסטוריה`, `סדר יום`, `הגדרות`, `תפריט`; `rows.children` is 18 (title row, header row, 16 children); `todayHasCurrentDate` is `false` before ~23:30.

**If `todayHasCurrentDate` is `true` during the day, stop and report it.** The whole design rests on `היסטוריה` being a nightly archive; if it is live, the positional path in Tasks 2 and 3 is unnecessary complexity and the plan should be revised rather than followed.

- [ ] **Step 4: Capture fixtures**

Run the probe against both sheets and save the raw grids, so every later test runs offline:

```bash
cd server && mkdir -p scripts/fixtures/sheet-sync
node -e '
const { probe, credentialsFromEnv, clientFor, readTab } = require("./scripts/sheet-sync-probe");
const fs = require("fs");
const id = "19t4MY0z4Y4UNLanpqlFz-E4HqolmG7wrIsQNDLKTOMw";
const auth = clientFor(credentialsFromEnv());
(async () => {
  const out = {};
  for (const t of ["ילדים", "סדר יום", "היסטוריה"]) out[t] = await readTab(auth, id, t);
  fs.writeFileSync("scripts/fixtures/sheet-sync/moshe-dayan.json", JSON.stringify(out, null, 1));
})();
'
```

Then redact: replace every parent phone number in the `ילדים` fixture with `0500000000`, and replace the free-text `הערת הורים` values with `הערה` — the fixtures are committed, and a parent's note about their child's night is not test data.

- [ ] **Step 5: Commit**

```bash
git add server/scripts/sheet-sync-probe.js server/scripts/fixtures/sheet-sync/ docs/superpowers/plans/2026-09-17-sheet-sync-credentials.md
git commit -m "feat(sync): a read-only probe, and the fixtures every later test reads

The sheet is the one part of this that cannot be asserted from the repository,
so it gets looked at before anything is built on it: five tabs, sixteen
children, and no history row for the current date until the nightly archive
runs.

The grids are captured and committed, redacted of phone numbers and parents'
notes, so no test from here on needs a network or a credential.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Row-aware roster parsing

**Files:**
- Modify: `server/scripts/lib/nursery-history.js` (add `parseChildRows`, export it)
- Create: `server/scripts/sheet-sync-roster.test.js`
- Create: `server/src/services/sheet-sync/roster.js`

**Interfaces:**
- Consumes: `SHEET`, `normalizeFieldName`, `cellToText`, `excelSerialToDateKey`, `normalizePhone` from `scripts/lib/nursery-history.js`.
- Produces:
  - `parseChildRows(rows)` → `[{ row, name, birth_date, access_id, phone }]` where `row` is the **absolute zero-based index** in the grid.
  - `pairRows({ childRows, todayRows })` → `{ pairs: [{ row, access_id, name, values }], errors: [] }`.

This is the task that prevents the one bug that would matter: a parent's note landing on another family's child.

`parseChildren` already exists and already drops blank rows without recording where it was — it is correct for the history importer, which pairs by `accessId`, and wrong for the live tab, which pairs by position. It stays as it is. A new function sits beside it.

- [ ] **Step 1: Write the failing test**

Create `server/scripts/sheet-sync-roster.test.js`:

```js
/**
 * Pairing the live tab to the roster.
 *
 * `סדר יום` carries no name, no id and no date: a row is a child only because
 * it sits at the same offset as that child in `ילדים`. A blank row is a child
 * with nothing filled in yet, and it holds the alignment for everyone below
 * it. Dropping blank rows is the bug this file exists to prevent.
 *
 *   node scripts/sheet-sync-roster.test.js
 */
const assert = require('assert');
const { parseChildRows } = require('./lib/nursery-history');
const { pairRows } = require('../src/services/sheet-sync/roster');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

const childGrid = [
  ['ילדים - משה דיין', '', '', ''],
  ['שם מלא', 'תאריך לידה', 'AccessID', 'מספר פלאפון'],
  ['נויה חגי', 45897, 'id-1', '0500000000'],
  ['עידו גבריאל דורני', 45917, 'id-2', '0500000000'],
  ['ליה לוין', 45887, 'id-3', '0500000000'],
  ['יובל ראובני', 45895, 'id-4', '0500000000'],
];

// ליה לוין's row is blank — she is at the gan and nobody has filled her in.
const todayGrid = [
  ['סדר יום - גן החלומות'],
  ['התעורר בבית', 'אכל בבית - שעה', 'אכל בבית - כמות', 'ארוחת בוקר'],
  [0.25, 0.2604166666666667, '180 מ״ל', ''],
  [0.2291666666666667, 0.2395833333333333, '210', ''],
  ['', '', '', ''],
  [0.28125, 0.25, '180', ''],
];

console.log('\nparseChildRows — the absolute row index travels with the child');
check('four children', () => assert.strictEqual(parseChildRows(childGrid).length, 4));
check('first child is on grid row 2', () => assert.strictEqual(parseChildRows(childGrid)[0].row, 2));
check('fourth child is on grid row 5', () => assert.strictEqual(parseChildRows(childGrid)[3].row, 5));
check('access ids survive', () => assert.strictEqual(parseChildRows(childGrid)[3].access_id, 'id-4'));

console.log('\npairRows — a blank middle row keeps everyone below it in place');
const paired = pairRows({ childRows: parseChildRows(childGrid), todayRows: todayGrid });
check('no errors', () => assert.deepStrictEqual(paired.errors, []));
check('four pairs', () => assert.strictEqual(paired.pairs.length, 4));
check('ליה לוין pairs to the blank row', () => {
  const lia = paired.pairs.find(p => p.access_id === 'id-3');
  assert.strictEqual(lia.values['התעורר בבית'], '');
});
check('יובל ראובני keeps her own 06:45, not the row above', () => {
  const yuval = paired.pairs.find(p => p.access_id === 'id-4');
  assert.strictEqual(yuval.values['התעורר בבית'], 0.28125);
});

console.log('\npairRows — it refuses rather than guesses');
check('fewer day rows than children is an error, not a partial pairing', () => {
  const short = pairRows({ childRows: parseChildRows(childGrid), todayRows: todayGrid.slice(0, 4) });
  assert.strictEqual(short.pairs.length, 0);
  assert.ok(/rows/.test(short.errors[0]));
});

console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && node scripts/sheet-sync-roster.test.js`
Expected: FAIL — `Cannot find module '../src/services/sheet-sync/roster'`

- [ ] **Step 3: Add `parseChildRows` to the library**

In `server/scripts/lib/nursery-history.js`, directly after `parseChildren`, add:

```js
/**
 * The roster tab, WITH the grid row each child sits on.
 *
 * `parseChildren` above answers "who was in this sheet", which is all the
 * history importer needs — it pairs on `accessId` carried in the JSON. The
 * live `סדר יום` tab carries no id at all, so pairing there is by position,
 * and position is exactly what `parseChildren` throws away when it skips a
 * blank row.
 *
 * Same parsing, one more field, and the two do not share an implementation
 * on purpose: the importer's behaviour is covered by four suites and must not
 * move because the sync needed something else.
 *
 * `row` is the zero-based index into the grid as read, so it can be turned
 * back into an A1 range without counting anything again.
 */
function parseChildRows(rows) {
  const headerIndex = (rows || []).findIndex(r => (r || []).some(c => normalizeFieldName(c) === 'שם מלא'));
  if (headerIndex < 0) return [];
  const header = (rows[headerIndex] || []).map(normalizeFieldName);
  const col = (name) => header.indexOf(name);
  const out = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (isEmptyRow(row)) continue;
    const name = cellToText(row[col('שם מלא')]);
    if (!name) continue;
    out.push({
      row: i,
      name,
      birth_date: excelSerialToDateKey(row[col('תאריך לידה')]),
      access_id: cellToText(row[col('AccessID')]),
      phone: normalizePhone(row[col('מספר פלאפון')]),
    });
  }
  return out;
}
```

Add `parseChildRows` to the `module.exports` object.

- [ ] **Step 4: Write `roster.js`**

Create `server/src/services/sheet-sync/roster.js`:

```js
/**
 * Pairing the live board's rows to children, and children to our database.
 *
 * Two tabs are read in the same pass and never cached between passes: a child
 * added to or removed from `ילדים` shifts every row below them in `סדר יום`,
 * and a stale order would move one family's day onto another's.
 */
const { normalizeFieldName } = require('../../../scripts/lib/nursery-history');

/**
 * Child *n* of the roster owns row *n* of the live tab.
 *
 * The roster's own blank rows are already skipped by `parseChildRows`, which
 * is why each child carries its absolute `row`: the offset between the two
 * tabs is taken from the header positions, not assumed to be two.
 *
 * Refuses rather than guesses. A live tab with fewer rows than the roster has
 * children means the sheet is mid-edit or the assumption is wrong, and a
 * partial pairing there is worse than no pairing at all — it silently writes
 * the last few children's days onto the wrong records.
 */
function pairRows({ childRows, todayRows }) {
  const errors = [];
  const grid = todayRows || [];
  const headerIndex = grid.findIndex(r => (r || []).some(c => normalizeFieldName(c) === 'התעורר בבית'));
  if (headerIndex < 0) return { pairs: [], errors: ['סדר יום: header row not found'] };

  const header = (grid[headerIndex] || []).map(normalizeFieldName);
  const children = childRows || [];
  if (children.length === 0) return { pairs: [], errors: ['ילדים: no children'] };

  const firstChildRow = children[0].row;
  const lastNeeded = headerIndex + 1 + (children[children.length - 1].row - firstChildRow);
  if (lastNeeded >= grid.length) {
    errors.push(`סדר יום has ${grid.length} rows, needs ${lastNeeded + 1} for ${children.length} children`);
    return { pairs: [], errors };
  }

  const pairs = children.map((child) => {
    const row = headerIndex + 1 + (child.row - firstChildRow);
    const cells = grid[row] || [];
    const values = {};
    header.forEach((name, c) => { if (name) values[name] = cells[c] === undefined ? '' : cells[c]; });
    return { row, access_id: child.access_id, name: child.name, values };
  });
  return { pairs, errors };
}

module.exports = { pairRows };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && node scripts/sheet-sync-roster.test.js`
Expected: PASS, all assertions.

- [ ] **Step 6: Register the test**

In `server/package.json`, add to `scripts`:

```json
"test:sync-roster": "node scripts/sheet-sync-roster.test.js"
```

- [ ] **Step 7: Commit**

```bash
git add server/scripts/lib/nursery-history.js server/scripts/sheet-sync-roster.test.js server/src/services/sheet-sync/roster.js server/package.json
git commit -m "feat(sync): pair the live board's rows to children by position, carefully

The live tab has no name, no id and no date — a row is a child only because it
sits at the same offset as that child in the roster. A blank row is a child
nobody has filled in yet, and it holds the alignment for everyone below it.

parseChildren drops blank rows and does not record where it was, which is
right for the history importer (it pairs on accessId) and wrong here.
parseChildRows sits beside it and carries the grid row, rather than changing
behaviour four suites depend on.

pairRows refuses a short tab instead of pairing what it can: a partial
positional pairing writes the last few children's days onto the wrong records,
which is worse than no sync at all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The three-way merge

**Files:**
- Create: `server/src/services/sheet-sync/three-way.js`
- Create: `server/scripts/sheet-sync-three-way.test.js`

**Interfaces:**
- Consumes: nothing. Pure, no imports.
- Produces: `merge({ sheet, ours, shadow })` → `{ toOurs: {}, toSheet: {}, conflicts: [{ field, sheet, ours }] }`. All three inputs are flat maps of `DailyLog` dotted paths (`home.wake_time`, `meals.breakfast.amount`) to already-converted values.

This is where a mistake corrupts a family's record, so it depends on nothing and is tested first.

- [ ] **Step 1: Write the failing test**

Create `server/scripts/sheet-sync-three-way.test.js`:

```js
/**
 * The merge core.
 *
 * Three sides, not two: without a shadow of what the sheet held last pass, a
 * differing value is unclassifiable — "they changed it" and "we changed it"
 * look identical, and copying either way destroys a real edit silently.
 *
 *   node scripts/sheet-sync-three-way.test.js
 */
const assert = require('assert');
const { merge } = require('../src/services/sheet-sync/three-way');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

console.log('\nthe four cases');

check('nobody changed it → nothing moves', () => {
  const r = merge({ sheet: { 'diapers': '1' }, ours: { 'diapers': '1' }, shadow: { 'diapers': '1' } });
  assert.deepStrictEqual(r.toOurs, {});
  assert.deepStrictEqual(r.toSheet, {});
  assert.deepStrictEqual(r.conflicts, []);
});

check('the sheet changed it → copy in', () => {
  const r = merge({ sheet: { 'diapers': '2' }, ours: { 'diapers': '1' }, shadow: { 'diapers': '1' } });
  assert.deepStrictEqual(r.toOurs, { 'diapers': '2' });
  assert.deepStrictEqual(r.toSheet, {});
});

check('we changed it → copy out', () => {
  const r = merge({ sheet: { 'diapers': '1' }, ours: { 'diapers': '3' }, shadow: { 'diapers': '1' } });
  assert.deepStrictEqual(r.toSheet, { 'diapers': '3' });
  assert.deepStrictEqual(r.toOurs, {});
});

check('both changed it → the sheet wins, ours is kept', () => {
  const r = merge({
    sheet: { 'meals.breakfast.amount': '100%' },
    ours: { 'meals.breakfast.amount': '50%' },
    shadow: { 'meals.breakfast.amount': '' },
  });
  assert.deepStrictEqual(r.toOurs, { 'meals.breakfast.amount': '100%' });
  assert.deepStrictEqual(r.toSheet, {});
  assert.deepStrictEqual(r.conflicts, [
    { field: 'meals.breakfast.amount', sheet: '100%', ours: '50%' },
  ]);
});

console.log('\nthe first pass, when there is no shadow at all');

check('an empty shadow does not turn every field into a conflict', () => {
  const r = merge({
    sheet: { 'home.wake_time': '06:15', 'diapers': '' },
    ours: { 'home.wake_time': '', 'diapers': '' },
    shadow: {},
  });
  assert.deepStrictEqual(r.toOurs, { 'home.wake_time': '06:15' });
  assert.deepStrictEqual(r.conflicts, []);
});

console.log('\nemptiness');

check('a field the sheet cleared is a change, not an absence', () => {
  const r = merge({ sheet: { 'staff_note': '' }, ours: { 'staff_note': 'ישן טוב' }, shadow: { 'staff_note': 'ישן טוב' } });
  assert.deepStrictEqual(r.toOurs, { 'staff_note': '' });
});

check('a field absent from the sheet grid is left alone', () => {
  const r = merge({ sheet: {}, ours: { 'staff_note': 'ישן טוב' }, shadow: { 'staff_note': 'ישן טוב' } });
  assert.deepStrictEqual(r.toOurs, {});
  assert.deepStrictEqual(r.toSheet, {});
});

check('undefined and empty string are the same absence on our side', () => {
  const r = merge({ sheet: { 'diapers': '2' }, ours: {}, shadow: { 'diapers': '' } });
  assert.deepStrictEqual(r.toOurs, { 'diapers': '2' });
  assert.deepStrictEqual(r.conflicts, []);
});

console.log('\nlists');

check('missing[] compares by content, not by reference', () => {
  const r = merge({
    sheet: { 'missing': ['טיטולים', 'מגבונים'] },
    ours: { 'missing': ['טיטולים', 'מגבונים'] },
    shadow: { 'missing': ['טיטולים', 'מגבונים'] },
  });
  assert.deepStrictEqual(r.toOurs, {});
  assert.deepStrictEqual(r.toSheet, {});
});

check('a list we appended to is copied out', () => {
  const r = merge({
    sheet: { 'missing': ['טיטולים'] },
    ours: { 'missing': ['טיטולים', 'סינר'] },
    shadow: { 'missing': ['טיטולים'] },
  });
  assert.deepStrictEqual(r.toSheet, { 'missing': ['טיטולים', 'סינר'] });
});

console.log('\nmany fields at once');

check('each field is decided on its own', () => {
  const r = merge({
    sheet: { 'a': 'sheet', 'b': 'same', 'c': 'x', 'd': 'sheet' },
    ours: { 'a': 'old', 'b': 'same', 'c': 'ours', 'd': 'ours' },
    shadow: { 'a': 'old', 'b': 'same', 'c': 'x', 'd': 'old' },
  });
  assert.deepStrictEqual(r.toOurs, { 'a': 'sheet', 'd': 'sheet' });
  assert.deepStrictEqual(r.toSheet, { 'c': 'ours' });
  assert.deepStrictEqual(r.conflicts, [{ field: 'd', sheet: 'sheet', ours: 'ours' }]);
});

console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && node scripts/sheet-sync-three-way.test.js`
Expected: FAIL — `Cannot find module '../src/services/sheet-sync/three-way'`

- [ ] **Step 3: Write the implementation**

Create `server/src/services/sheet-sync/three-way.js`:

```js
/**
 * Which side changed a field, and what to do about it.
 *
 * Pure, and deliberately depends on nothing: this is the only place where a
 * mistake silently rewrites a child's day, so it must be readable in one
 * screen and testable without a database, a network or a clock.
 *
 * The shadow is what the sheet held at the end of the previous pass. With it,
 * every field is classifiable; without it, "they changed it" and "we changed
 * it" are the same observation.
 *
 * On a true conflict the SHEET wins the field. Not because it is more correct
 * — nothing in the old system records when a field changed, so "later" is not
 * a question this data can answer — but because during the transition the room
 * is still typing there. Our value is never discarded: it comes back in
 * `conflicts` and is shown beside the field on the board.
 */

/** Absent, empty string and null are one fact: nobody has said. */
function blank(v) {
  return v === undefined || v === null || v === '';
}

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const l = Array.isArray(a) ? a : [];
    const r = Array.isArray(b) ? b : [];
    return l.length === r.length && l.every((x, i) => x === r[i]);
  }
  if (blank(a) && blank(b)) return true;
  return a === b;
}

function merge({ sheet, ours, shadow }) {
  const s = sheet || {};
  const o = ours || {};
  const sh = shadow || {};

  const toOurs = {};
  const toSheet = {};
  const conflicts = [];

  // Only fields the sheet actually carries are decided here. A field the grid
  // has no column for is not "empty in the sheet", it is a question the sheet
  // was never asked, and writing our side into it would invent a column.
  for (const field of Object.keys(s)) {
    const sheetValue = s[field];
    const ourValue = o[field];
    const shadowValue = sh[field];

    const sheetMoved = !sameValue(sheetValue, shadowValue);
    const weMoved = !sameValue(ourValue, shadowValue);

    if (!sheetMoved && !weMoved) continue;
    if (sheetMoved && !weMoved) { toOurs[field] = sheetValue; continue; }
    if (!sheetMoved && weMoved) { toSheet[field] = ourValue; continue; }

    // Both moved. If they happened to land on the same value there is nothing
    // to resolve — two people agreeing is not a conflict.
    if (sameValue(sheetValue, ourValue)) continue;

    toOurs[field] = sheetValue;
    conflicts.push({ field, sheet: sheetValue, ours: blank(ourValue) ? '' : ourValue });
  }

  return { toOurs, toSheet, conflicts };
}

module.exports = { merge, sameValue, blank };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node scripts/sheet-sync-three-way.test.js`
Expected: PASS, every assertion.

- [ ] **Step 5: Register the test**

In `server/package.json` `scripts`:

```json
"test:sync-merge": "node scripts/sheet-sync-three-way.test.js"
```

- [ ] **Step 6: Commit**

```bash
git add server/src/services/sheet-sync/three-way.js server/scripts/sheet-sync-three-way.test.js server/package.json
git commit -m "feat(sync): the three-way merge, and why the sheet wins a tie

Two sides cannot classify a disagreement: 'they changed it' and 'we changed
it' are the same observation, and copying either way destroys a real edit
silently. A shadow of what the sheet held last pass makes every field
decidable.

The tie goes to the sheet. Not because it is more likely right — nothing in
the old system records when a field changed, so 'later' is unanswerable — but
because the room is still typing there during the transition. Our value is
returned in conflicts and rendered beside the field rather than dropped.

Pure and importless on purpose: this is the one file where a mistake rewrites
a child's day.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: The Sheets client's writing half

**Files:**
- Modify: `server/src/services/sheet-sync/sheets-client.js` (created in Task 1)

**Interfaces:**
- Consumes: `clientFor`, `credentialsFromEnv`, `readTab` — already in this same file from Task 1.
- Produces:
  - `readGrids(sheetId)` → `{ children: [][], today: [][], history: [][] }`
  - `writeCells(sheetId, updates)` where `updates` is `[{ tab, row, col, value }]` with zero-based `row`/`col`. Returns `{ written }`.
  - `a1(tab, row, col)` → `'סדר יום'!D5` style range string.

- [ ] **Step 1: Extend the client**

Append to `server/src/services/sheet-sync/sheets-client.js`, keeping Task 1's exports and adding these to the `module.exports` object:

```js
// --- Writing, and the two tabs the sync actually reads -------------------
//
// Writes are `values.batchUpdate` on explicit single-cell ranges, never an
// append and never a row operation. The old board reads its own live tab
// positionally, so a row inserted or deleted here would move every child
// below it on THEIR screen too.
const { SHEET } = require('../../../scripts/lib/nursery-history');

/** Zero-based row/col to an A1 range, quoting the tab name for the Hebrew. */
function a1(tab, row, col) {
  let n = col + 1;
  let letters = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    letters = String.fromCharCode(65 + r) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return `'${tab.replace(/'/g, "''")}'!${letters}${row + 1}`;
}

function auth() {
  return clientFor(credentialsFromEnv());
}

async function readGrids(sheetId) {
  const a = auth();
  const [children, today, history] = await Promise.all([
    readTab(a, sheetId, SHEET.children),
    readTab(a, sheetId, SHEET.today),
    readTab(a, sheetId, SHEET.history),
  ]);
  return { children, today, history };
}

/**
 * Set cells. `updates` is [{ tab, row, col, value }], zero-based.
 *
 * RAW, not USER_ENTERED: a value we computed must land as itself. Letting
 * Sheets re-interpret it would turn "06:15" back into a serial under one
 * locale and a string under another, and the board would render whichever it
 * got.
 */
async function writeCells(sheetId, updates) {
  if (!updates || updates.length === 0) return { written: 0 };
  const a = auth();
  const data = updates.map(u => ({ range: a1(u.tab, u.row, u.col), values: [[u.value]] }));
  await a.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
    method: 'POST',
    data: { valueInputOption: 'RAW', data },
  });
  return { written: updates.length };
}

module.exports = { SCOPES, credentialsFromEnv, clientFor, tabNames, readTab, readGrids, writeCells, a1 };
```

- [ ] **Step 2: Test the A1 conversion, which is the only logic here**

Append to `server/scripts/sheet-sync-roster.test.js`, before the final summary lines:

```js
const { a1 } = require('../src/services/sheet-sync/sheets-client');
console.log('\na1 — ranges, including the Hebrew tab name');
check('first cell', () => assert.strictEqual(a1('סדר יום', 0, 0), "'סדר יום'!A1"));
check('column D, row 5', () => assert.strictEqual(a1('סדר יום', 4, 3), "'סדר יום'!D5"));
check('past Z', () => assert.strictEqual(a1('ילדים', 0, 26), "'ילדים'!AA1"));
check('the seventeenth column is Q', () => assert.strictEqual(a1('סדר יום', 1, 16), "'סדר יום'!Q2"));
```

- [ ] **Step 3: Run it**

Run: `cd server && node scripts/sheet-sync-roster.test.js`
Expected: PASS, including the four new assertions.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/sheet-sync/sheets-client.js server/scripts/sheet-sync-roster.test.js
git commit -m "feat(sync): the Sheets client — cells only, never rows

Writes are batchUpdate on explicit single-cell ranges. No append, no insert,
no delete: the old board reads its own live tab positionally, so a row
operation here would move every child below it on the staff's screen too.

RAW rather than USER_ENTERED, so a time we computed lands as itself instead of
being re-interpreted into a serial under one locale and a string under
another.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: The shadow, and the two new fields

**Files:**
- Create: `server/src/models/SheetSyncState.js`
- Modify: `server/src/models/Child.js`
- Modify: `server/src/models/DailyLog.js`
- Modify: `server/src/models/index.js` (register `SheetSyncState`)

**Interfaces:**
- Produces: `SheetSyncState` with `{ branch_id, date, sheet_id, shadow, last_run_at, last_error, conflicts_count }`, unique on `(branch_id, date)`; `Child.sheet_access_id`; `DailyLog.sync_conflicts`.

- [ ] **Step 1: Write the model**

Create `server/src/models/SheetSyncState.js`:

```js
const mongoose = require('mongoose');

/**
 * What the old board's sheet held at the end of the last sync pass.
 *
 * Without this, a field that differs between the two systems is
 * unclassifiable — "they changed it" and "we changed it" look identical, and
 * copying either way destroys a real edit. See services/sheet-sync/three-way.js.
 *
 * One document per branch per day, same key as the board's own query. It is
 * disposable: deleting it costs one pass, which re-reads the sheet and treats
 * everything in it as the truth, exactly like a first run.
 *
 * `shadow` is a map of accessId → { <DailyLog dotted path>: value }.
 */
const sheetSyncStateSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  // YYYY-MM-DD, local. Same reasoning as DailyLog: a day is a calendar day.
  date: { type: String, required: true, index: true },
  sheet_id: { type: String, default: '' },

  shadow: { type: mongoose.Schema.Types.Mixed, default: {} },

  last_run_at: { type: Date, default: null },
  last_error: { type: String, default: '' },
  conflicts_count: { type: Number, default: 0 },
  wrote_in: { type: Number, default: 0 },
  wrote_out: { type: Number, default: 0 },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

sheetSyncStateSchema.index({ branch_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('SheetSyncState', sheetSyncStateSchema);
```

- [ ] **Step 2: Add `sheet_access_id` to `Child`**

In `server/src/models/Child.js`, inside the schema definition, add:

```js
  /**
   * The UUID the old Apps Script board assigned this child, from the sheet's
   * `ילדים` tab.
   *
   * The only identity the two systems share. Names are not usable here —
   * `נדיה גרוס` exists twice, and the תמ"ת reconciliation already documented
   * six children the two systems spell differently.
   *
   * Empty on every child the old board never knew, which is most of them:
   * only the two תינוקייה branches were ever on it. Set by
   * scripts/sheet-sync-match.js after a human reads the match report, and by
   * nothing else. Deleted with the sync when the old board closes.
   */
  sheet_access_id: { type: String, default: '', index: true },
```

- [ ] **Step 3: Add `sync_conflicts` to `DailyLog`**

In `server/src/models/DailyLog.js`, after `staff_note`, add:

```js
  /**
   * Fields where the sheet and this record both moved since the last sync.
   *
   * The sheet's value won and is in the field above; this is what ours held,
   * kept so the board can show it and the person in the room can settle it.
   * Never a silent overwrite — see services/sheet-sync/three-way.js.
   *
   * Cleared for a field the moment somebody edits that field on the board:
   * looking at both values and choosing one IS the resolution, and leaving
   * the note up afterwards would make it furniture.
   */
  sync_conflicts: {
    type: [{
      field: { type: String, default: '' },
      ours: { type: mongoose.Schema.Types.Mixed, default: '' },
      at: { type: Date, default: Date.now },
    }],
    default: [],
  },
```

- [ ] **Step 4: Register the model**

In `server/src/models/index.js`, add `SheetSyncState: require('./SheetSyncState'),` to the exported object, in the same style as its neighbours.

- [ ] **Step 5: Verify the models load**

Run:

```bash
cd server && node -e "const m=require('./src/models'); console.log('SheetSyncState:', !!m.SheetSyncState); console.log('Child.sheet_access_id:', !!m.Child.schema.path('sheet_access_id')); console.log('DailyLog.sync_conflicts:', !!m.DailyLog.schema.path('sync_conflicts'));"
```

Expected: three `true` lines.

- [ ] **Step 6: Commit**

```bash
git add server/src/models/SheetSyncState.js server/src/models/Child.js server/src/models/DailyLog.js server/src/models/index.js
git commit -m "feat(sync): the shadow, the shared identity, and the kept loser

SheetSyncState holds what the sheet contained at the end of the last pass,
which is what makes a differing field classifiable rather than ambiguous. It
is disposable by design: losing it costs one pass that treats the sheet as
truth, exactly like a first run.

Child.sheet_access_id is the only identity the two systems share. Names are
not usable — נדיה גרוס exists twice, and six children are spelled differently
across the two systems.

DailyLog.sync_conflicts keeps the value a conflict rejected, so the board can
show it and somebody in the room can settle it, instead of a number changing
under a teacher with no explanation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: The match report

**Files:**
- Create: `server/scripts/sheet-sync-match.js`

**Interfaces:**
- Consumes: `readGrids` (Task 4), `parseChildRows` (Task 2).
- Produces: `matchReport({ sheetId, branchName })` → `{ matched: [{ access_id, sheet_name, child_id, child_name, by }], unmatched: [], ambiguous: [] }`; `--write` sets `Child.sheet_access_id`.

- [ ] **Step 1: Write the script**

Create `server/scripts/sheet-sync-match.js`:

```js
/**
 * Which child in the sheet is which child in the database.
 *
 * Run once per branch, read by a person, and only then allowed to write. The
 * sync never resolves an identity at runtime: by the time a pass runs, every
 * child it touches already carries `sheet_access_id`, or it is skipped.
 *
 * Dry by default. Same reasoning as import-nursery-history.js: a mistyped
 * MONGODB_URI should produce a printout, not an incident.
 *
 *   node scripts/sheet-sync-match.js --sheet <id> --branch "<שם סניף>"
 *   node scripts/sheet-sync-match.js --sheet <id> --branch "<שם סניף>" --write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Child, Branch, Classroom } = require('../src/models');
const { readGrids } = require('../src/services/sheet-sync/sheets-client');
const { parseChildRows } = require('./lib/nursery-history');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

/** Names compared only to REPORT a likely pair, never to establish one. */
function normalizeName(s) {
  return String(s || '').replace(/["'׳״]/g, '').replace(/\s+/g, ' ').trim();
}

async function matchReport({ sheetId, branchName }) {
  const branch = await Branch.findOne({ name: branchName }).lean();
  if (!branch) throw new Error(`no branch named ${branchName}`);

  const rooms = await Classroom.find({ branch_id: branch._id, category: 'תינוקייה', is_active: true }).lean();
  const roomIds = rooms.map(r => r._id);
  const children = await Child.find({ classroom_id: { $in: roomIds } })
    .select('_id full_name sheet_access_id birth_date').lean();

  const { children: grid } = await readGrids(sheetId);
  const sheetChildren = parseChildRows(grid);

  const byName = new Map();
  for (const c of children) {
    const k = normalizeName(c.full_name);
    byName.set(k, (byName.get(k) || []).concat(c));
  }

  const matched = [];
  const unmatched = [];
  const ambiguous = [];

  for (const s of sheetChildren) {
    if (!s.access_id) { unmatched.push({ ...s, why: 'no AccessID in the sheet' }); continue; }
    const already = children.find(c => c.sheet_access_id === s.access_id);
    if (already) {
      matched.push({ access_id: s.access_id, sheet_name: s.name, child_id: String(already._id), child_name: already.full_name, by: 'already linked' });
      continue;
    }
    const candidates = byName.get(normalizeName(s.name)) || [];
    if (candidates.length === 1) {
      matched.push({ access_id: s.access_id, sheet_name: s.name, child_id: String(candidates[0]._id), child_name: candidates[0].full_name, by: 'name + branch' });
    } else if (candidates.length > 1) {
      ambiguous.push({ ...s, candidates: candidates.map(c => ({ id: String(c._id), name: c.full_name, birth_date: c.birth_date })) });
    } else {
      unmatched.push({ ...s, why: 'no child of that name in this branch' });
    }
  }
  return { branch: branch.name, matched, unmatched, ambiguous };
}

async function main() {
  const sheetId = arg('--sheet');
  const branchName = arg('--branch');
  const write = process.argv.includes('--write');
  if (!sheetId || !branchName) {
    console.error('usage: node scripts/sheet-sync-match.js --sheet <id> --branch "<name>" [--write]');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const report = await matchReport({ sheetId, branchName });

  console.log(`\nסניף: ${report.branch}`);
  console.log(`\nמותאמים (${report.matched.length}):`);
  report.matched.forEach(m => console.log(`  ${m.sheet_name}  →  ${m.child_name}  [${m.by}]`));
  console.log(`\nלא נמצאו (${report.unmatched.length}):`);
  report.unmatched.forEach(u => console.log(`  ${u.name}  —  ${u.why}`));
  console.log(`\nדו-משמעיים (${report.ambiguous.length}):`);
  report.ambiguous.forEach(a => console.log(`  ${a.name}  →  ${a.candidates.map(c => c.name + ' (' + c.birth_date + ')').join(' | ')}`));

  if (!write) {
    console.log('\nהרצה יבשה. שום דבר לא נכתב. להוסיף --write אחרי קריאת הרשימה.\n');
  } else {
    let n = 0;
    for (const m of report.matched) {
      if (m.by === 'already linked') continue;
      await Child.updateOne({ _id: m.child_id }, { $set: { sheet_access_id: m.access_id } });
      n += 1;
    }
    console.log(`\nנכתבו ${n} שיוכים.\n`);
  }
  await mongoose.disconnect();
}

module.exports = { matchReport, normalizeName };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 2: Run it dry against משה דיין**

Run:

```bash
cd server && node scripts/sheet-sync-match.js --sheet 19t4MY0z4Y4UNLanpqlFz-E4HqolmG7wrIsQNDLKTOMw --branch "כפר סבא - משה דיין"
```

(If the branch name is rejected, list the real names with
`node -e "require('dotenv').config();const m=require('mongoose');m.connect(process.env.MONGODB_URI).then(async()=>{console.log((await require('./src/models').Branch.find().lean()).map(b=>b.name));process.exit(0)})"`
and use the exact string.)

Expected: sixteen sheet children, most matched by name, any ambiguity listed rather than resolved. **Do not pass `--write` until the printed list has been read by the user.**

- [ ] **Step 3: Commit**

```bash
git add server/scripts/sheet-sync-match.js
git commit -m "feat(sync): a match report a person reads before anything is linked

The sync never resolves an identity at runtime — a child either already
carries sheet_access_id or is skipped. This is where that link is made, once
per branch, and it prints before it writes.

Names are used only to PROPOSE a pair, never to establish one, and two
children of the same name land in 'ambiguous' rather than being picked
between. נדיה גרוס is already duplicated in this data.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: One sync pass

**Files:**
- Create: `server/src/services/sheet-sync/run.js`
- Create: `server/scripts/sheet-sync-run.test.js`

**Interfaces:**
- Consumes: `pairRows` (Task 2), `merge` (Task 3), `readGrids`/`writeCells` (Task 4), `SheetSyncState`/`Child`/`DailyLog` (Task 5), `dailyLogSet`/`FIELD_MAP`/`SHEET` from `scripts/lib/nursery-history.js`.
- Produces: `runPass({ branchId, sheetId, date, mode, deps })` → `{ date, children, in: n, out: n, conflicts: n, skipped: [], errors: [] }`. `deps` exists so the test injects grids and collects writes instead of touching a network or a database.

- [ ] **Step 1: Write the failing test**

Create `server/scripts/sheet-sync-run.test.js`:

```js
/**
 * One pass, end to end, with the sheet and the database injected.
 *
 * The point of the injection is that this suite asserts the ORDER of
 * operations — shadow written only after the writes it describes succeeded —
 * which is not observable from the outside.
 *
 *   node scripts/sheet-sync-run.test.js
 */
const assert = require('assert');
const { runPass } = require('../src/services/sheet-sync/run');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

const childGrid = [
  ['ילדים - משה דיין', '', '', ''],
  ['שם מלא', 'תאריך לידה', 'AccessID', 'מספר פלאפון'],
  ['נויה חגי', 45897, 'id-1', '0500000000'],
  ['ליה לוין', 45887, 'id-2', '0500000000'],
];
const header = ['התעורר בבית', 'אכל בבית - שעה', 'ארוחת בוקר', 'הערות'];
function todayGrid(rows) { return [['סדר יום'], header, ...rows]; }

function deps({ today, logs, shadow }) {
  const writes = [];
  const saved = [];
  let shadowSaved = null;
  return {
    writes, saved, get shadowSaved() { return shadowSaved; },
    readGrids: async () => ({ children: childGrid, today, history: [] }),
    writeCells: async (_id, updates) => { writes.push(...updates); return { written: updates.length }; },
    childrenByAccessId: async () => new Map([['id-1', { _id: 'c1', full_name: 'נויה חגי' }], ['id-2', { _id: 'c2', full_name: 'ליה לוין' }]]),
    loadLogs: async () => logs,
    saveLog: async (childId, set, conflicts) => { saved.push({ childId, set, conflicts }); },
    loadShadow: async () => shadow,
    saveShadow: async (s) => { shadowSaved = s; },
  };
}

console.log('\na first pass with no shadow takes the sheet as it stands');
{
  const d = deps({
    today: todayGrid([[0.2604166666666667, 0.25, '', ''], ['', '', '', '']]),
    logs: new Map(),
    shadow: {},
  });
  const r = require('../src/services/sheet-sync/run');
  const out = r.runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d });
  check('it resolves', () => assert.ok(out instanceof Promise));
  out.then(res => {
    check('two children seen', () => assert.strictEqual(res.children, 2));
    check("נויה's wake time copied in", () => {
      const s = d.saved.find(x => x.childId === 'c1');
      assert.strictEqual(s.set['home.wake_time'], '06:15');
    });
    check('no writes back out', () => assert.strictEqual(d.writes.length, 0));
    check('the shadow was recorded', () => assert.ok(d.shadowSaved && d.shadowSaved['id-1']));
    finish();
  });
}

let pending = 1;
function finish() {
  pending -= 1;
  if (pending > 0) return;
  runSecond();
}

function runSecond() {
  console.log('\ndry mode writes nothing at all');
  const d = deps({
    today: todayGrid([[0.2604166666666667, '', '', ''], ['', '', '', '']]),
    logs: new Map(),
    shadow: {},
  });
  require('../src/services/sheet-sync/run')
    .runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'dry', deps: d })
    .then(res => {
      check('it still reports what it would do', () => assert.ok(res.in > 0));
      check('nothing saved to the database', () => assert.strictEqual(d.saved.length, 0));
      check('nothing written to the sheet', () => assert.strictEqual(d.writes.length, 0));
      check('the shadow is NOT advanced', () => assert.strictEqual(d.shadowSaved, null));
      runThird();
    });
}

function runThird() {
  console.log('\nwe changed a field the sheet did not: it goes out to the sheet');
  const d = deps({
    today: todayGrid([['', '', '', ''], ['', '', '', '']]),
    logs: new Map([['c1', { staff_note: 'ישן טוב', home: {}, meals: {}, sleep: {}, missing: [] }]]),
    shadow: { 'id-1': { 'staff_note': '' } },
  });
  require('../src/services/sheet-sync/run')
    .runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d })
    .then(res => {
      check('one cell written out', () => assert.strictEqual(d.writes.length, 1));
      check('to the הערות column, נויה\'s row', () => {
        assert.strictEqual(d.writes[0].col, 3);
        assert.strictEqual(d.writes[0].row, 2);
        assert.strictEqual(d.writes[0].value, 'ישן טוב');
      });
      runFourth();
    });
}

function runFourth() {
  console.log('\nboth moved: the sheet wins and ours is kept on the log');
  const d = deps({
    today: todayGrid([['', '', 1, ''], ['', '', '', '']]),
    logs: new Map([['c1', { meals: { breakfast: { amount: '50%' } }, home: {}, sleep: {}, missing: [] }]]),
    shadow: { 'id-1': { 'meals.breakfast.amount': '' } },
  });
  require('../src/services/sheet-sync/run')
    .runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d })
    .then(res => {
      check('one conflict', () => assert.strictEqual(res.conflicts, 1));
      check("the sheet's 100% is what we store", () => {
        const s = d.saved.find(x => x.childId === 'c1');
        assert.strictEqual(s.set['meals.breakfast.amount'], '100%');
      });
      check('our 50% is kept', () => {
        const s = d.saved.find(x => x.childId === 'c1');
        assert.strictEqual(s.conflicts[0].ours, '50%');
      });
      runFifth();
    });
}

function runFifth() {
  console.log('\na child with no sheet_access_id is skipped, never guessed');
  const d = deps({ today: todayGrid([['', '', '', ''], ['', '', '', '']]), logs: new Map(), shadow: {} });
  d.childrenByAccessId = async () => new Map([['id-1', { _id: 'c1', full_name: 'נויה חגי' }]]);
  require('../src/services/sheet-sync/run')
    .runPass({ branchId: 'b1', sheetId: 's1', date: '2026-09-17', mode: 'write', deps: d })
    .then(res => {
      check('ליה לוין is reported as skipped', () => assert.ok(res.skipped.some(s => /id-2/.test(JSON.stringify(s)))));
      console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
      process.exit(failures === 0 ? 0 : 1);
    });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && node scripts/sheet-sync-run.test.js`
Expected: FAIL — `Cannot find module '../src/services/sheet-sync/run'`

- [ ] **Step 3: Write the pass**

Create `server/src/services/sheet-sync/run.js`:

```js
/**
 * One sync pass, one branch, one day.
 *
 * Fetch both tabs together, pair them, merge each child three ways, apply, and
 * only then record the shadow. The order matters: the shadow is a claim that
 * the sheet and this database agreed at a moment, and advancing it before the
 * writes it describes have landed would turn a failed pass into permanently
 * lost edits — the next pass would see "nobody changed anything".
 *
 * Every external edge arrives through `deps` so the suite can assert that
 * ordering, which is not observable from outside.
 */
const { pairRows } = require('./roster');
const { merge } = require('./three-way');
const { parseChildRows, dailyLogSet, FIELD_MAP, SHEET, normalizeFieldName } = require('../../../scripts/lib/nursery-history');

/** `home.wake_time` → the value on a DailyLog document. */
function atPath(doc, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
}

/** The FIELD_MAP entry whose `path` is this one, for writing back out. */
const COLUMN_FOR_PATH = Object.entries(FIELD_MAP)
  .reduce((acc, [column, def]) => { acc[def.path] = column; return acc; }, {});

function defaultDeps() {
  const { readGrids, writeCells } = require('./sheets-client');
  const { Child, DailyLog, SheetSyncState } = require('../../models');
  return {
    readGrids,
    writeCells,
    childrenByAccessId: async (accessIds) => {
      const rows = await Child.find({ sheet_access_id: { $in: accessIds } })
        .select('_id full_name sheet_access_id classroom_id').lean();
      return new Map(rows.map(r => [r.sheet_access_id, r]));
    },
    loadLogs: async (childIds, date) => {
      const rows = await DailyLog.find({ child_id: { $in: childIds }, date }).lean();
      return new Map(rows.map(r => [String(r.child_id), r]));
    },
    saveLog: async (childId, set, conflicts, ctx) => {
      await DailyLog.updateOne(
        { child_id: childId, date: ctx.date },
        {
          $set: { ...set, child_name: ctx.childName, branch_id: ctx.branchId, classroom_id: ctx.classroomId },
          ...(conflicts.length ? { $push: { sync_conflicts: { $each: conflicts } } } : {}),
        },
        { upsert: true },
      );
    },
    loadShadow: async (branchId, date) => {
      const s = await SheetSyncState.findOne({ branch_id: branchId, date }).lean();
      return (s && s.shadow) || {};
    },
    saveShadow: async (shadow, ctx) => {
      await SheetSyncState.updateOne(
        { branch_id: ctx.branchId, date: ctx.date },
        {
          $set: {
            shadow, sheet_id: ctx.sheetId, last_run_at: new Date(), last_error: '',
            conflicts_count: ctx.conflicts, wrote_in: ctx.in, wrote_out: ctx.out,
          },
        },
        { upsert: true },
      );
    },
  };
}

async function runPass({ branchId, sheetId, date, mode = 'dry', deps = null }) {
  const d = deps || defaultDeps();
  const result = { date, children: 0, in: 0, out: 0, conflicts: 0, skipped: [], errors: [] };

  const grids = await d.readGrids(sheetId);
  const childRows = parseChildRows(grids.children);
  const { pairs, errors } = pairRows({ childRows, todayRows: grids.today });
  if (errors.length) { result.errors = errors; return result; }
  result.children = pairs.length;

  const byAccess = await d.childrenByAccessId(pairs.map(p => p.access_id));
  const known = pairs.filter(p => byAccess.has(p.access_id));
  for (const p of pairs) {
    if (!byAccess.has(p.access_id)) result.skipped.push({ access_id: p.access_id, name: p.name, why: 'no Child carries this sheet_access_id' });
  }

  const logs = await d.loadLogs(known.map(p => String(byAccess.get(p.access_id)._id)), date);
  const shadow = await d.loadShadow(branchId, date);

  const header = (grids.today.find(r => (r || []).some(c => normalizeFieldName(c) === 'התעורר בבית')) || [])
    .map(normalizeFieldName);

  const nextShadow = {};
  const cellWrites = [];

  for (const pair of known) {
    const child = byAccess.get(pair.access_id);
    const { set: sheetSet } = dailyLogSet(pair.values);
    // dailyLogSet drops blanks; the sheet's cleared field is a change, so
    // every column the grid HAS is represented, blank included.
    const sheetFlat = {};
    for (const column of Object.keys(pair.values)) {
      const def = FIELD_MAP[normalizeFieldName(column)];
      if (!def) continue;
      sheetFlat[def.path] = Object.prototype.hasOwnProperty.call(sheetSet, def.path)
        ? sheetSet[def.path]
        : (def.kind === 'list' ? [] : '');
    }

    const log = logs.get(String(child._id)) || {};
    const ourFlat = {};
    for (const path of Object.keys(sheetFlat)) {
      const v = atPath(log, path);
      ourFlat[path] = v === undefined || v === null ? (Array.isArray(sheetFlat[path]) ? [] : '') : v;
    }

    const { toOurs, toSheet, conflicts } = merge({ sheet: sheetFlat, ours: ourFlat, shadow: shadow[pair.access_id] || {} });

    if (Object.keys(toOurs).length || conflicts.length) {
      result.in += Object.keys(toOurs).length;
      result.conflicts += conflicts.length;
      if (mode === 'write') {
        await d.saveLog(String(child._id), toOurs, conflicts.map(c => ({ field: c.field, ours: c.ours, at: new Date() })), {
          date, childName: child.full_name, branchId, classroomId: child.classroom_id || null,
        });
      }
    }

    for (const [path, value] of Object.entries(toSheet)) {
      const column = COLUMN_FOR_PATH[path];
      const col = header.indexOf(normalizeFieldName(column));
      if (col < 0) continue;
      cellWrites.push({ tab: SHEET.today, row: pair.row, col, value: Array.isArray(value) ? value.join(', ') : value });
      result.out += 1;
    }

    nextShadow[pair.access_id] = { ...sheetFlat, ...toSheet };
  }

  if (mode === 'write') {
    if (cellWrites.length) await d.writeCells(sheetId, cellWrites);
    // Only now: the shadow claims the two sides agreed, and it may only make
    // that claim about writes that actually landed.
    await d.saveShadow(nextShadow, { branchId, sheetId, date, conflicts: result.conflicts, in: result.in, out: result.out });
  }

  return result;
}

module.exports = { runPass, atPath, COLUMN_FOR_PATH };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node scripts/sheet-sync-run.test.js`
Expected: PASS, every assertion across the five scenarios.

- [ ] **Step 5: Register the test**

In `server/package.json` `scripts`:

```json
"test:sync-run": "node scripts/sheet-sync-run.test.js"
```

- [ ] **Step 6: Commit**

```bash
git add server/src/services/sheet-sync/run.js server/scripts/sheet-sync-run.test.js server/package.json
git commit -m "feat(sync): one pass — fetch, pair, merge, apply, and only then the shadow

The ordering is the load-bearing part. The shadow is a claim that the two
sides agreed at a moment; advancing it before the writes it describes have
landed turns a failed pass into permanently lost edits, because the next pass
reads 'nobody changed anything'.

A cleared cell is a change, not an absence, so every column the grid actually
has is represented in the comparison — dailyLogSet drops blanks, which is
right for an import and wrong for a mirror.

A child whose Child row carries no sheet_access_id is reported and skipped.
The pass never resolves an identity.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Conflicts on the board

**Files:**
- Modify: `client/src/components/nursery/NurseryBoard.jsx`
- Modify: `server/src/controllers/nursery.controller.js` (include `sync_conflicts` in the board payload; clear a field's conflict when that field is edited)

**Interfaces:**
- Consumes: `DailyLog.sync_conflicts` (Task 5).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Include conflicts in the board payload**

In `server/src/controllers/nursery.controller.js`, in `board`, add `sync_conflicts` to the fields selected and returned per log, alongside the existing day fields.

- [ ] **Step 2: Clear a field's conflict when a human edits that field**

In `updateLog` in the same controller, after building the `$set` of changed paths, add:

```js
  // Looking at both values and choosing one IS the resolution. Leaving the
  // note up after the teacher has acted would make it furniture, and the next
  // person would learn to ignore it.
  const touched = Object.keys(set);
  const update = { $set: set };
  if (touched.length) update.$pull = { sync_conflicts: { field: { $in: touched } } };
```

and use `update` in place of the bare `{ $set: set }`.

- [ ] **Step 3: Render the rejected value**

In `client/src/components/nursery/NurseryBoard.jsx`, where each field cell is rendered, add beneath the input, following the file's existing `sx` conventions:

```jsx
{(log.sync_conflicts || [])
  .filter(c => c.field === fieldPath)
  .map((c, i) => (
    <Typography key={i} variant="caption" sx={{ display: 'block', color: 'warning.main', mt: 0.25 }}>
      אצלנו נרשם: {Array.isArray(c.ours) ? c.ours.join(', ') : c.ours || '—'}
    </Typography>
  ))}
```

- [ ] **Step 4: Verify in the browser**

Start the dev server and open the board with a `DailyLog` that has a seeded conflict:

```bash
cd server && node -e "require('dotenv').config();const m=require('mongoose');m.connect(process.env.MONGODB_URI).then(async()=>{const {DailyLog}=require('./src/models');const l=await DailyLog.findOne().sort({date:-1});await DailyLog.updateOne({_id:l._id},{\$push:{sync_conflicts:{field:'meals.breakfast.amount',ours:'50%',at:new Date()}}});console.log('seeded on',l.child_name,l.date);process.exit(0)})"
```

Expected: the breakfast cell for that child shows `אצלנו נרשם: 50%` under it. Editing that cell makes the note disappear on the next load.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/nursery/NurseryBoard.jsx server/src/controllers/nursery.controller.js
git commit -m "feat(sync): show the value a conflict rejected, and clear it when answered

A number changing under a teacher with no explanation is how a board stops
being trusted. When both sides moved the same field, the sheet's value is what
the board shows and ours sits under it as 'אצלנו נרשם', so the person in the
room can see both and settle it.

Editing the field clears its note: choosing between the two values is the
resolution, and a note that outlives the decision becomes furniture.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: The nightly check

**Files:**
- Create: `server/src/services/sheet-sync/nightly.js`
- Create: `server/scripts/sheet-sync-nightly.test.js`

**Interfaces:**
- Consumes: `readGrids` (Task 4), `historyChildren` from `scripts/lib/nursery-history.js`, `SheetSyncState`/`DailyLog` (Task 5).
- Produces: `verifyDay({ branchId, sheetId, date, deps })` → `{ checked, agreed, disagreed: [{ access_id, name, field, archive, ours }] }`.

The live path pairs positionally and has no way to notice if the pairing slipped. The archive carries `accessId`, so it is the alarm.

- [ ] **Step 1: Write the failing test**

Create `server/scripts/sheet-sync-nightly.test.js`:

```js
/**
 * The archive check.
 *
 * All day the sync pairs rows to children by position, and a positional
 * scheme has no way to notice that it slipped. The nightly archive carries
 * accessId per child, so comparing it to what the day recorded is the only
 * alarm this design has.
 *
 *   node scripts/sheet-sync-nightly.test.js
 */
const assert = require('assert');
const { verifyDay } = require('../src/services/sheet-sync/nightly');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

const archiveRow = (date, children) => [date, JSON.stringify({ children }), `${date} | 23:35`];
const kid = (accessId, name, data) => ({ name, accessId, data });

function deps({ history, logs }) {
  return {
    readGrids: async () => ({ children: [], today: [], history: [['Date', 'JSON_Data', 'Timestamp'], ...history] }),
    childrenByAccessId: async () => new Map([
      ['id-1', { _id: 'c1', full_name: 'נויה חגי' }],
      ['id-2', { _id: 'c2', full_name: 'ליה לוין' }],
    ]),
    loadLogs: async () => logs,
  };
}

console.log('\nagreement is the proof the pairing held');
deps && verifyDay({
  branchId: 'b1', sheetId: 's1', date: '2026-09-17',
  deps: deps({
    history: [archiveRow('2026-09-17', [kid('id-1', 'נויה חגי', { 'התעורר בבית': '06:15' })])],
    logs: new Map([['c1', { home: { wake_time: '06:15' }, meals: {}, sleep: {}, missing: [] }]]),
  }),
}).then(r => {
  check('one child checked', () => assert.strictEqual(r.checked, 1));
  check('nothing disagreed', () => assert.deepStrictEqual(r.disagreed, []));
  second();
});

function second() {
  console.log('\na slipped pairing shows up as a named disagreement');
  verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({
      history: [archiveRow('2026-09-17', [
        kid('id-1', 'נויה חגי', { 'התעורר בבית': '06:15' }),
        kid('id-2', 'ליה לוין', { 'התעורר בבית': '' }),
      ])],
      // נויה's morning ended up on ליה — exactly what a one-row slip looks like
      logs: new Map([
        ['c1', { home: { wake_time: '' }, meals: {}, sleep: {}, missing: [] }],
        ['c2', { home: { wake_time: '06:15' }, meals: {}, sleep: {}, missing: [] }],
      ]),
    }),
  }).then(r => {
    check('two disagreements', () => assert.strictEqual(r.disagreed.length, 2));
    check('both children are named', () => {
      const names = r.disagreed.map(d => d.name).sort();
      assert.deepStrictEqual(names, ['ליה לוין', 'נויה חגי']);
    });
    third();
  });
}

function third() {
  console.log('\nno archive row yet is not a failure');
  verifyDay({
    branchId: 'b1', sheetId: 's1', date: '2026-09-17',
    deps: deps({ history: [], logs: new Map() }),
  }).then(r => {
    check('checked nothing, reported nothing', () => {
      assert.strictEqual(r.checked, 0);
      assert.deepStrictEqual(r.disagreed, []);
    });
    console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
    process.exit(failures === 0 ? 0 : 1);
  });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && node scripts/sheet-sync-nightly.test.js`
Expected: FAIL — `Cannot find module '../src/services/sheet-sync/nightly'`

- [ ] **Step 3: Write it**

Create `server/src/services/sheet-sync/nightly.js`:

```js
/**
 * Did today's positional pairing actually hold?
 *
 * `סדר יום` carries no identity, so all day the sync pairs rows to children by
 * offset. That is correct and it is also unfalsifiable from the inside — a
 * slip of one row produces a perfectly well-formed day on the wrong child.
 *
 * The nightly archive carries `accessId`. Comparing it to what the day
 * recorded is the only way this design can catch a slip, so it runs every
 * night and names the children rather than counting them.
 */
const { historyChildren, dailyLogSet, FIELD_MAP, normalizeFieldName } = require('../../../scripts/lib/nursery-history');
const { sameValue } = require('./three-way');
const { atPath } = require('./run');

function defaultDeps() {
  const { readGrids } = require('./sheets-client');
  const { Child, DailyLog } = require('../../models');
  return {
    readGrids,
    childrenByAccessId: async (ids) => {
      const rows = await Child.find({ sheet_access_id: { $in: ids } }).select('_id full_name sheet_access_id').lean();
      return new Map(rows.map(r => [r.sheet_access_id, r]));
    },
    loadLogs: async (childIds, date) => {
      const rows = await DailyLog.find({ child_id: { $in: childIds }, date }).lean();
      return new Map(rows.map(r => [String(r.child_id), r]));
    },
  };
}

async function verifyDay({ branchId, sheetId, date, deps = null }) {
  const d = deps || defaultDeps();
  const out = { checked: 0, agreed: 0, disagreed: [] };

  const { history } = await d.readGrids(sheetId);
  const row = (history || []).slice(1).find(r => String(r[0] || '').startsWith(date));
  if (!row) return out; // the archive has not been written yet — not a failure

  // historyChildren takes the PARSED payload, not the cell's text — it
  // distinguishes the two blob shapes and throws on anything else.
  let entries;
  try { entries = historyChildren(JSON.parse(row[1])); } catch { return { ...out, error: 'archive JSON did not parse' }; }
  const withId = (entries || []).filter(e => e.accessId);
  if (withId.length === 0) return out;

  const byAccess = await d.childrenByAccessId(withId.map(e => e.accessId));
  const known = withId.filter(e => byAccess.has(e.accessId));
  const logs = await d.loadLogs(known.map(e => String(byAccess.get(e.accessId)._id)), date);

  for (const entry of known) {
    const child = byAccess.get(entry.accessId);
    const log = logs.get(String(child._id)) || {};
    const { set } = dailyLogSet(entry.data || {});
    out.checked += 1;
    let ok = true;
    for (const column of Object.keys(entry.data || {})) {
      const def = FIELD_MAP[normalizeFieldName(column)];
      if (!def) continue;
      const archiveValue = Object.prototype.hasOwnProperty.call(set, def.path)
        ? set[def.path] : (def.kind === 'list' ? [] : '');
      const ourValue = atPath(log, def.path);
      if (!sameValue(archiveValue, ourValue)) {
        ok = false;
        out.disagreed.push({
          access_id: entry.accessId, name: child.full_name,
          field: def.path, archive: archiveValue, ours: ourValue === undefined ? '' : ourValue,
        });
      }
    }
    if (ok) out.agreed += 1;
  }
  return out;
}

module.exports = { verifyDay };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node scripts/sheet-sync-nightly.test.js`
Expected: PASS, all three scenarios.

- [ ] **Step 5: Register the test**

In `server/package.json` `scripts`:

```json
"test:sync-nightly": "node scripts/sheet-sync-nightly.test.js"
```

- [ ] **Step 6: Commit**

```bash
git add server/src/services/sheet-sync/nightly.js server/scripts/sheet-sync-nightly.test.js server/package.json
git commit -m "feat(sync): the nightly check, because a positional slip is invisible

All day the sync pairs rows to children by offset, which is correct and also
unfalsifiable from the inside: a one-row slip produces a perfectly well-formed
day on the wrong child.

The nightly archive carries accessId. Comparing it to what the day recorded is
the only alarm this design has, so it names the children rather than counting
them — a disagreement is a family's record, not a metric.

An archive row that has not been written yet is not a failure.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: The job, the switch, and the first real day

**Files:**
- Create: `server/src/services/sheetSyncJob.js`
- Modify: `server/src/index.js`

**Interfaces:**
- Consumes: `runPass` (Task 7), `verifyDay` (Task 9).
- Produces: `tick()`, following `cibusSyncJob.tick()`.

- [ ] **Step 1: Write the job**

Create `server/src/services/sheetSyncJob.js`:

```js
/**
 * The sync's clock.
 *
 * Off unless `nursery_sheet_sync` is configured, and readable without a
 * deploy: this runs against a board the staff are using right now, and the way
 * to stop it has to be faster than a push.
 *
 * The setting is
 *   { enabled: bool, write: bool, branches: [{ branch_id, sheet_id }] }
 * with `write` separate from `enabled` on purpose — the safe half (sheet → us)
 * can run for a day while the other half is still being watched.
 */
const { Setting } = require('../models');
const { runPass } = require('./sheet-sync/run');
const { verifyDay } = require('./sheet-sync/nightly');

const KEY = 'nursery_sheet_sync';
const OPEN_FROM = 5;   // 05:00
const OPEN_TO = 19;    // 19:00
const NIGHTLY_HOUR = 23;

function israelNow(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false,
  }).format(now));
  return { date, hour };
}

async function tick(now = new Date()) {
  const setting = await Setting.findOne({ key: KEY }).lean();
  const cfg = (setting && setting.value) || {};
  if (!cfg.enabled) return { skipped: 'disabled' };
  const branches = Array.isArray(cfg.branches) ? cfg.branches : [];
  if (branches.length === 0) return { skipped: 'no branches' };

  const { date, hour } = israelNow(now);
  const mode = cfg.write ? 'write' : 'dry';
  const out = [];

  for (const b of branches) {
    if (!b.branch_id || !b.sheet_id) continue;
    try {
      if (hour >= OPEN_FROM && hour < OPEN_TO) {
        out.push({ branch: String(b.branch_id), ...(await runPass({ branchId: b.branch_id, sheetId: b.sheet_id, date, mode })) });
      }
      if (hour >= NIGHTLY_HOUR) {
        const v = await verifyDay({ branchId: b.branch_id, sheetId: b.sheet_id, date });
        if (v.disagreed.length) {
          console.error(`[sheet-sync] ${date} ${b.sheet_id}: ${v.disagreed.length} disagreements with the nightly archive`);
          v.disagreed.slice(0, 20).forEach(x => console.error(`  ${x.name} · ${x.field} · ארכיון="${x.archive}" אצלנו="${x.ours}"`));
        }
        out.push({ branch: String(b.branch_id), verify: v });
      }
    } catch (e) {
      console.error(`[sheet-sync] ${b.sheet_id} failed:`, e.message);
      out.push({ branch: String(b.branch_id), error: e.message });
    }
  }
  return { ran: out };
}

module.exports = { tick, KEY, israelNow };
```

- [ ] **Step 2: Register it**

In `server/src/index.js`, beside the other jobs (after the `reconcileReminder` block), add:

```js
    // The old תינוקייה board and the new one, kept in step until the old one
    // closes. Cheap when idle — one Setting read and an immediate return while
    // it is disabled, which is how it ships.
    const sheetSync = require('./services/sheetSyncJob');
    const runSheetSync = () => sheetSync.tick().catch(e => console.error('[sheet-sync] tick failed:', e.message));
    if (!platformMode) {
      setTimeout(runSheetSync, 2 * 60 * 1000);
      setInterval(runSheetSync, 2 * 60 * 1000);
    }
```

- [ ] **Step 3: Verify it is off and harmless**

Run:

```bash
cd server && node -e "require('dotenv').config();const m=require('mongoose');m.connect(process.env.MONGODB_URI).then(async()=>{const j=require('./src/services/sheetSyncJob');console.log(await j.tick());process.exit(0)})"
```

Expected: `{ skipped: 'disabled' }`. Nothing was read from Google, nothing was written.

- [ ] **Step 4: Run the whole suite**

Run:

```bash
cd server && npm run test:sync-merge && npm run test:sync-roster && npm run test:sync-run && npm run test:sync-nightly
```

Expected: four `OK` blocks, no failures.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/sheetSyncJob.js server/src/index.js
git commit -m "feat(sync): the clock, shipped switched off

Two switches, not one: 'enabled' and 'write' are separate so the safe half —
sheet into us — can run for a day while writing back is still being watched.

Both live in a Setting rather than an env var, because this runs against a
board the staff are using right now and stopping it has to be faster than a
push.

Ships disabled: the tick reads one Setting and returns.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: The first real day — a checklist for the user, not a code step**

In order, stopping at the first surprise:

1. `sheet-sync-match.js` dry for משה דיין. **The user reads the printed list.** Then `--write`.
2. Set `nursery_sheet_sync` to `{ enabled: true, write: false, branches: [{ branch_id, sheet_id }] }` for משה דיין only.
3. Watch one full day. The logs say what it would have written; `SheetSyncState` accumulates shadows; nothing has changed on either board.
4. Read the nightly comparison. **Zero disagreements is the gate.** Any disagreement stops the rollout and is investigated before anything is enabled further.
5. Flip `write: true` for משה דיין. Watch a second day, including the conflict count.
6. Repeat 1–5 for קפלן.

---

## Self-Review

**Spec coverage.**

| Spec section | Task |
|---|---|
| Sheet not Apps Script | 1, 4 |
| Five tabs, live in `סדר יום` | 1 |
| Value encoding (serials, fractions) | 1 (UNFORMATTED_VALUE), reused converters in 7 |
| Shadow copy, four cases | 3, 5 |
| Conflict policy: sheet wins, loser kept and shown | 3, 5, 8 |
| Identity by row position, blank rows load-bearing | 2 |
| Identity by `AccessID`, match report | 5, 6 |
| Nightly archive check | 9 |
| Two-minute schedule, gan hours | 10 |
| Dry run default | 1, 6, 7, 10 |
| Per branch rollout | 10 step 6 |
| Kill switch without a deploy | 10 |
| Full log | 5 (`SheetSyncState`), 10 |
| Credentials the user must provide | 1 |
| Menu out of scope | honoured — no task touches `DailyMenu` |
| צעירים out of scope | honoured — no task touches `boardKind` |
| Deletion when the old board closes | every file is under `sheet-sync/` plus two model fields |

**Type consistency.** `merge({sheet, ours, shadow}) → {toOurs, toSheet, conflicts}` is used with those exact names in Task 7. `pairRows({childRows, todayRows}) → {pairs, errors}`, and `pairs[].row/access_id/name/values` are the names Task 7 reads. `parseChildRows(rows) → [{row,...}]` — `row` is the field Task 7's `pair.row` traces back to. `verifyDay → {checked, agreed, disagreed}` matches Task 10's `v.disagreed`. `atPath` is defined in `run.js` and imported by `nightly.js`; `sameValue` is defined in `three-way.js` and imported by `nightly.js` — both are exported where defined.

**Placeholders.** None. Every code step carries the code; every run step carries the command and the expected output; the one step that cannot be code (Task 10 step 6) is explicitly a human checklist with a named gate.
