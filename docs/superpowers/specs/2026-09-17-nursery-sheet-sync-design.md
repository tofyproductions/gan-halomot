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
`totofy10@gmail.com`. Per-child day data and the daily menu, both directions.

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

Each sheet has two tabs.

**`ילדים`** — `שם מלא, תאריך לידה, AccessID, מספר פלאפון`. `AccessID` is a UUID
the old system already assigns and keeps stable per child.

**`היסטוריה`** — `Date, JSON_Data, Timestamp`. One row per day, holding every
child's whole day.

The JSON comes in two shapes, because the two branches' scripts diverged:
משה דיין writes `{"children":[...]}`, קפלן writes a bare `[...]`. Each child
carries `name, age, dob, phone, accessId, data`, and `data` is a flat map whose
keys are the gan's own Hebrew:

```
נוכחות · ארוחת בוקר · תמ"ל בוקר
שנת בוקר שעת השכבה · שנת בוקר שעת השכמה
ארוחת צהריים · תמ"ל צהריים
שנת צהריים שעת השכבה · שנת צהריים שעת השכמה
ארוחת 4 · תמ"ל 4 · יציאות · מה חסר · הערות
התעורר בבית · אכל בבית - שעה · אכל בבית - כמות · הערת הורים
```

These map one-to-one onto `DailyLog`. The mapping is already written and
already tested — `scripts/lib/nursery-history.js` does exactly this for the
history import, and the sync reuses it rather than restating it.

**Open question, resolved first in implementation:** whether today's in-progress
day is written to a `היסטוריה` row continuously (an upsert keyed by date) or
held elsewhere until the day closes. The 05:22 modification time and the
presence of a row for the current date both point at the former, but the sync
reads live data and must not guess. The first implementation task settles it by
observation before anything is built on top of it.

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

The sheet cannot break the tie either: `Timestamp` is one value for the whole
day's row. It says the day was touched, never which field.

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

**Later wins, and the loser is kept.**

The rejected value is written to a `sync_conflicts` entry on the log and
surfaced on the new board beside the field — "בלוח הישן נרשם: 50%". Nothing is
deleted silently; the person in the room sees both and settles it.

"Later" is decided by our own per-field touch time against the sheet row's
`Timestamp`. This is coarse on the sheet's side by construction — it is the
best the old system offers — which is exactly why the loser is kept rather than
discarded.

## Identity

Children are matched on `AccessID`, stored on `Child` as `sheet_access_id`.

Not on name. The name path is known-bad in this data: `נדיה גרוס` exists twice,
and the תמ"ת reconciliation work already documented six children the two
systems spell differently. The UUID is stable, already assigned, and already in
the sheet.

The first run produces a **match report** — every sheet child, the `Child` it
resolved to, and the evidence — and writes nothing until a human approves it.
Unmatched children are reported and skipped. A name is never guessed into an
identity.

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
  string should produce a printout, not an incident.
- **Per branch.** משה דיין first, watched for a full day, then קפלן.
- **A kill switch in Settings**, readable without a deploy. Off means the old
  board carries on exactly as it does today, with nothing to undo.
- **Direction switches.** Read-only mode (sheet → us) is separately
  switchable from write-back, so the safe half can run while the other half is
  still being watched.
- **A full log.** Every field written, which way, by which run, with the before
  value.

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

When the old board closes: turn off the switch, delete `server/src/services/
sheet-sync/`, `SheetSyncState`, and the two fields added to `Child` and
`DailyLog`. The new system is unchanged by their absence. The sheets stay as an
archive, and `import-nursery-history.js` remains the way to read them.
