# The old board and the new one, running side by side

Status: approved direction, 17.09.2026
Branch: `feat/nursery-sheet-sync` (not yet cut)

## The problem

The תינוקייה has two daily boards.

The old one is a Google Apps Script web app wrapped in a GitHub Pages page at
`dreamgan.github.io/digital-report/?branch=<branch>`, backed by one Google
Sheet per branch. It is live and in daily use — the משה דיין sheet was written
to at 05:22 on the morning this was specified. Parents read it and fill in the
morning-at-home box; staff fill in the day.

The new one is `NurseryBoard` (staff) and `NurseryDay` (parent portal), backed
by `DailyLog`, `ClassroomDay` and `DailyMenu`. It was built to replace the
sheet, `import-nursery-history.js` already moved eight months of the sheet's
history across, and it covers strictly more than the old board does.

Nobody has switched. Both boards are open, and whichever one a person happens
to use is the only one that knows what they wrote.

The gan is not ready to close the old board today. It wants to close it on a
day of its choosing and have the new board already hold the full record, with
no gap and no retyping.

## Goal

Keep both boards live and agreeing with each other, so that closing the old one
is a decision rather than a migration.

Explicitly **not** a permanent architecture. This sync exists to be deleted.
Every piece of it is built so that turning it off leaves the new system whole
and the old system untouched.

## Scope

**In:** the two תינוקייה sheets — משה דיין
(`19t4MY0z4Y4UNLanpqlFz-E4HqolmG7wrIsQNDLKTOMw`) and קפלן
(`1R5XL3-RC0UggFaLjjO2WcAd96ZTz9M4F7aLEEE6_8KQ`), both owned by
`totofy10@gmail.com`. Per-child day data, both directions. The daily menu is
held back until where the old board stores a day's selection is established —
see `תפריט` below.

**Out:**

- **צעירים (what the gan calls פעוטות).** The old board has no sheet for them
  and never did. `boardKind` already returns `full` for `צעירים`, so the new
  system serves them today with the same board the infants get. They start
  there directly. Building them a sheet in the old format would be work done
  to be thrown away, and would create the very second-source-of-truth this
  spec exists to close.
- **בוגרים.** `light` board, one line per room via `ClassroomDay`. Never on the
  old board.
- The Apps Script itself. Not read, not edited, not redeployed. See below.
- Photographs, announcements, payments, and everything else in the parent
  portal that the old board never had.

## Why the sheet and not the Apps Script

Two ways to reach the old system's data:

1. **Through the sheet**, with the Google Sheets API and a service account.
2. **Through the Apps Script**, by adding a trigger that posts changes to us.

The Apps Script is what the staff are using right now. A deploy that goes wrong
there does not degrade a sync — it takes the board away from the room mid-
morning. The sheet, by contrast, is a store both systems can hold open, and
Google arbitrates concurrent writes to it.

The probe confirmed the Apps Script offers nothing to read anyway: every URL
shape tried (`?action=getData`, `?format=json`, bare) returns the same HTML
shell, never data.

So: the sheet. The old system does not learn that we exist, and cannot break
because of us.

```
old board ⟷ Google Sheet ⟷ sync service ⟷ DailyLog / DailyMenu ⟷ new board
```

## What the sheet holds

An xlsx export of the משה דיין sheet, taken on 17.09.2026, settles the shape.
There are **five** tabs, not the two the Drive preview showed.

**`ילדים`** — `שם מלא, תאריך לידה, AccessID, מספר פלאפון`, from row 3. Sixteen
children. `AccessID` is a UUID the old system assigns and keeps stable.

**`סדר יום`** — **the live board.** Row 2 is the header; row 3 onward is one
row per child, seventeen columns:

```
התעורר בבית · אכל בבית - שעה · אכל בבית - כמות
ארוחת בוקר · תמ״ל בוקר · שנת בוקר שעת השכבה · שנת בוקר שעת השכמה
ארוחת צהריים · תמ״ל צהריים · שנת צהריים שעת השכבה · שנת צהריים שעת השכמה
ארוחת 4 · תמ״ל 4 · יציאות · מה חסר · הערות · הערת הורים
```

It carries **no name, no id and no date**. A row is a child only by virtue of
sitting at the same offset as that child in `ילדים` — see Identity.

**`היסטוריה`** — `Date, JSON_Data, Timestamp`. 245 rows, one per past day,
each a full snapshot of all sixteen children **with `accessId`**. Written once
a night: the last six timestamps are 23:36, 23:36, 23:37, 23:32, 23:28, 23:35.

**There is no row for the current date.** This is the open question from the
first draft, and the answer is the inconvenient one: `היסטוריה` is an archive,
not a live store. A live sync cannot read it.

The JSON has two shapes, because the branches' scripts diverged: משה דיין
writes `{"children":[...]}`, קפלן a bare `[...]`. `scripts/lib/nursery-history.js`
already parses both and maps the Hebrew keys onto `DailyLog`; the sync reuses
that mapping rather than restating it.

**`הגדרות`** — the option lists behind the board: portions as `0, 0.25, 0.5,
0.75, 1`; formula millilitres `20…60`; the what-is-missing list (תמ״ל, מגבונים,
משחת החתלה, בגדי החלפה, טטרה, סינרים…). These correspond to the lists the new
board keeps in `Setting`.

**`תפריט`** — the dish *bank*, by meal and category (בוקר and צהריים each with
חלבון/פחמימה/ירק/קבוע; ארוחת 4 with כריך/פרי). It is the menu of what may be
chosen, not the choice for a given day. Where the old board records **the day's
selection** is not yet established; it is not in these five tabs in any form
this export makes obvious. Resolved before menu sync is built — and until it
is, menu sync stays out and only the per-child day is synced.

### How values are encoded

The sheet stores times and portions as numbers, not text:

- times as day fractions — `0.2604` is `06:15`
- portions as fractions — `0.5` is the `50%` the board renders

`import-nursery-history.js` already documents this and already stores portions
as they are shown. The Sheets API must be asked for the right rendering, and
the conversion belongs in one place — `day-shape.js` — not at each call site.

## The hard part: both directions

The gan asked for changes to flow both ways, and both ways is where a mirror
stops being a copy.

At 10:00 the two systems agree. At 10:05 a teacher writes `ארוחת בוקר: 100%`
in the old board. At 10:07 another teacher writes `ארוחת בוקר: 50%` in the new
one. At 10:10 the sync runs and sees two values.

A two-way comparison cannot answer this. It sees that the values differ and has
no way to know which one is a change and which one is stale — both look like
both. Copying in either direction destroys a real edit silently, and a teacher
who sees a number she did not write stops trusting the board, which is worse
than either number being wrong.

The sheet cannot break the tie either. The live tab carries no time at all —
see Conflict policy.

### Shadow copy

Store, per child per day, a snapshot of exactly what the sheet held at the end
of the last sync. The comparison then has three sides rather than two, and each
field can be classified without ambiguity:

| sheet ≠ shadow | ours ≠ shadow | outcome |
|---|---|---|
| no | no | nothing |
| yes | no | the sheet changed it → copy in |
| no | yes | we changed it → copy out |
| yes | yes | conflict |

Only the fourth row needs a policy, and reaching it requires two people to edit
the same field of the same child inside one sync interval.

### Conflict policy

The direction approved on 17.09.2026 was "later wins, and the loser is kept".
The second half stands. The first half cannot be implemented as stated, and the
reason is worth writing down rather than quietly working around.

**There is no timestamp on the live data at all.** `סדר יום` carries seventeen
value columns and nothing else — no date, no modification time, per row or per
sheet. The `Timestamp` column that the first draft proposed to compare against
belongs to `היסטוריה`, which is written once at ~23:30 and says only that a
night's archive was taken. Nothing in the old system records when a field
changed, so "later" is not a question the data can answer.

So the tiebreak is positional rather than temporal:

**The sheet wins the field, and our value is kept and shown.**

The sheet wins because during the transition the room is still working in the
old board — it is where the person who most recently had the child in front of
them is typing. Choosing our side would mean a teacher watching her own entry
replaced by one she cannot see the origin of.

The rejected value is written to `sync_conflicts` on the log and rendered on
the new board beside the field — "אצלנו נרשם: 50%" — with the run that
rejected it. Nothing is deleted silently; the person in the room sees both
values and settles it. That was the point of the approved rule, and it is
preserved exactly.

Conflicts are also counted per run. A rising count means people are working
both boards at once on the same children, which is the signal to pick a cutover
date rather than to tune a merge rule.

## Identity

Two different problems, because the live tab and the archive disagree.

**In `סדר יום` (live), identity is row position.** The tab has no id column.
Child *n* of `ילדים` owns row *n* of `סדר יום`, and the export confirms the
pairing holds exactly: fifteen of sixteen rows matched the board's own
rendering field for field, and the sixteenth — ליה לוין — is blank on both.

This is load-bearing and fragile, so it is treated as such:

- **Both tabs are read in one request, every pass.** The order is never cached
  between runs; a child added or removed shifts every row below them.
- **Blank rows are data.** A child with nothing filled in is an empty row that
  holds the alignment. Any read that drops blank rows silently shifts every
  subsequent child onto the wrong record — which is exactly the mistake made
  while investigating this, and it is recorded here because the code will be
  tempted into it too. The test suite asserts a blank middle row keeps its
  place.
- **Writes set cells, never insert or delete rows**, in either tab. Changing
  the row count would corrupt the old board's own reading of itself.
- **A pass aborts** if `סדר יום` holds fewer data rows than `ילדים` has
  children, rather than pairing what it can.

**In `היסטוריה` (archive), identity is `accessId`** — carried per child in the
JSON, and stable.

`Child.sheet_access_id` stores that UUID, so the two paths converge on one
identity. Never the name: `נדיה גרוס` exists twice, and the תמ״ת work already
documented six children the two systems spell differently.

The first run produces a **match report** — every sheet child, the `Child` it
resolved to, and the evidence — and writes nothing until a human approves it.
Unmatched children are reported and skipped, never guessed.

### The nightly check

The archive's weakness — written once at ~23:30 — is also its strength: it is
an authoritative, id-carrying snapshot of the day the sync spent all day
mirroring positionally.

So every night after the row appears, the sync re-reads it and compares it to
what it recorded during the day. Agreement is the proof that the row pairing
held. Disagreement is an alert naming the children, and it is the alignment
alarm that a positional scheme otherwise has no way to raise.

## Components

**`server/src/services/sheet-sync/`**

- `sheets-client.js` — the Google Sheets API wrapper. Reads a tab, writes a
  range. Knows nothing about the gan.
- `day-shape.js` — sheet JSON ⟷ `DailyLog` fields, both shapes of the
  `היסטוריה` blob. Pure; delegates to the existing `nursery-history.js`
  mapping rather than duplicating it.
- `three-way.js` — the shadow comparison and the conflict policy. Pure: takes
  (sheet, ours, shadow), returns (writes-in, writes-out, conflicts). This is
  where the correctness lives, and it is testable without a network or a
  database.
- `run.js` — one sync pass for one branch. Fetch, compare, apply, record.

**`server/src/models/SheetSyncState.js`** — the shadow, one document per branch
per date, plus the run log.

**`Child.sheet_access_id`** — a new field, indexed, default `''`.

**`DailyLog.sync_conflicts`** — a list of `{ field, rejected, source, at }`,
default empty, rendered by the board.

Each unit answers what it does, how it is used, and what it depends on, and
`three-way.js` — the only piece where a mistake corrupts a family's record —
depends on nothing at all.

## Schedule

Every two minutes between 05:30 and 18:30 local, hourly otherwise. Well inside
Google's quota for two sheets.

A two-minute lag is invisible in practice: nobody works both boards in the same
breath, and the shadow makes a late sync correct rather than merely eventual.

## Safety

- **Dry run is the default.** A pass prints every write it would make and makes
  none. `--write` is a deliberate act. Same reasoning as
  `import-nursery-history.js`, and the same reason: a mistyped connection
  string should produce a printout, not an incident. Precisely: dry means
  neither board changes and no shadow is written — the two boards are left
  exactly as they were. It does not mean the process writes nothing at all.
  `sheetSyncJob` still records that a branch was attempted and failed
  (`SheetSyncState.last_error`) and which nights were audited (a `Setting`) in
  any mode, deliberately, because diagnostics are needed most during the very
  phase that exists in order to be judged. Neither touches `shadow` or a
  child's day.
- **Per branch.** משה דיין first, watched for a full day, then קפלן. `write`
  therefore lives on the branch's own entry in the setting: a branch with no
  `write` of its own runs read-only, and never inherits write-back from a
  branch that has already earned it. The top-level `write: false` remains a
  master off.
- **A kill switch in Settings**, readable without a deploy. Off means the old
  board carries on exactly as it does today, with nothing to undo.
- **Direction switches.** Read-only mode (sheet → us) is separately
  switchable from write-back, so the safe half can run while the other half is
  still being watched.
- **A full log.** Every field written, which way, by which run, with the before
  value. Including the uneventful outcomes: a pass that read the board and
  agreed with it says so with its counts, and a completed nightly audit says
  how many children it compared. Silence in the log means one thing only —
  the sync is switched off — because the rollout decision is made by reading
  a read-only day and then a night with zero disagreements, and an empty log
  is otherwise indistinguishable from a crashed interval or an audit that
  compared nobody.
- **`scripts/` is on the production runtime path**, for the first time in this
  repo: `index.js` → `services/sheetSyncJob.js` → `sheet-sync/run.js` →
  `scripts/lib/nursery-history.js`. That import is the one deliberate
  exception to the rule that `src/` never reaches into `scripts/`, and it has
  a deployment consequence — if `scripts/` is ever excluded from a deploy
  bundle or a Docker layer as "not runtime", the server stops booting.

## Testing

`three-way.js` carries the weight: every row of the table above, both blob
shapes, a child in the sheet and not in the database and the reverse, a day
with two rows, empty-vs-absent (the sheet's `""` and a field the sheet never
had are different facts and must not collapse).

`day-shape.js` round-trips a real captured day.

An end-to-end test against a short-lived database, following
`nursery-history-e2e.test.js`, with the Sheets client stubbed.

No test ever touches a real sheet.

## What the user has to do

Grant the server read/write on the two sheets — a Google service account, and
the sheets shared with its address. Nobody else can do this; it is his Google
account. Step-by-step instructions, and the account itself, are produced by
the first implementation task, before any code depends on them.

## Noted, not in scope

The Drive folder holds a sheet named `חשבונות מייל - מחשבי לוח עדכון דיגיטלי`
containing four gmail addresses and their passwords in plain text. Unrelated to
this work and not touched by it, but it is a live credential exposure and is
recorded here so it is not lost.

## Deletion

When the old board closes: turn off the switch, then remove the whole of it.
The list matters more than it looks — `sheetSyncJob.js` sits OUTSIDE the
`sheet-sync/` directory and `index.js` requires it synchronously, inside the
`app.listen` callback, with no try/catch. Deleting the directory and leaving
the job behind therefore throws at that line during boot and every job
registered after it — the push-notification resend loop among them — is
silently never scheduled, inside an unhandled rejection nobody is watching
for. The real set, in an order that never leaves a dangling require:

1. `server/src/index.js` — the `sheetSync` block (the require, the `setTimeout`
   and the `setInterval`).
2. `server/src/services/sheetSyncJob.js`.
3. `server/src/services/sheet-sync/` — the whole directory.
4. `server/src/models/SheetSyncState.js` and its line in `models/index.js`.
5. `Child.sheet_access_id` and `DailyLog.sync_conflicts`.
6. `parseChildRows` and its export in `scripts/lib/nursery-history.js` — added
   for this feature and used by nothing else; the rest of that file is the
   importer's and stays.
7. `server/scripts/sheet-sync-*.js` — the matching script and the test suites —
   and their entries in `package.json`.
8. The two controller hunks that clear a conflict when the side that owns the
   field edits it: `nursery.controller.js` (`updateLog`) and
   `parentPortal.controller.js`.
9. The `sync_conflicts` rendering in
   `client/src/components/nursery/ChildDayCard.jsx` — both the per-field note
   and the read-only block under מההורים, מהבית.

The new system is unchanged by their absence. The sheets stay as an archive,
and `import-nursery-history.js` remains the way to read them.
