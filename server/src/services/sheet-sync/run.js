/**
 * One sync pass, one branch, one day.
 *
 * Fetch both tabs together, pair them, merge each child three ways, apply, and
 * only then record the shadow. The order matters: the shadow is a claim that
 * the sheet and this database agreed at a moment, and advancing it before the
 * writes it describes have landed would turn a failed pass into permanently
 * lost edits — the next pass would see "nobody changed anything" and both
 * sides' edits would disappear at once. Nothing here catches a write failure
 * for that reason: a pass that cannot finish must end loudly, with the shadow
 * still describing the last moment the two sides really did agree.
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

/**
 * The FIELD_MAP entry whose `path` is this one, for writing back out.
 *
 * Inverting a map is only safe when it is injective, and nothing about
 * FIELD_MAP's shape enforces that: two columns given the same `path` — a
 * copy-pasted line, a column renamed on the board and added beside the old
 * one — would leave this table one entry short, and the missing path is the
 * live trigger for writing a child's value into whatever column an index
 * lookup happens to land on. It is a static fact about a constant, so it is
 * checked once here, at load, where it either always holds or never does,
 * rather than being discovered at 07:00 against a live board.
 */
const COLUMN_FOR_PATH = Object.entries(FIELD_MAP)
  .reduce((acc, [column, def]) => {
    if (acc[def.path]) {
      throw new Error(`FIELD_MAP is not invertible: "${column}" and "${acc[def.path]}" both map to ${def.path}`);
    }
    acc[def.path] = column;
    return acc;
  }, {});

/**
 * A value as the OLD board stores it, for writing into its cell.
 *
 * The board is an Apps Script that reads its own tab with getValues() and
 * formats numbers: a time is a fraction of a day (0.46875 → 11:15) and a
 * portion is a ratio (0.5 → 50%). Handed the strings this system keeps —
 * "11:15", "50%" — it rendered "---", so a morning entered on the new board
 * reached the sheet and never reached the parent. Our canonical strings stay
 * canonical everywhere else: the shadow keeps them, and the reader
 * (`cellToTime` / `cellToPortion`) turns the number back into the same string,
 * so the next pass sees agreement rather than a change.
 *
 * Text is written as text, except a bare number ("40" of formula), which the
 * board always held as a number and renders as one. A note is never turned
 * into a number, and never into anything the sheet could evaluate: writes are
 * RAW, so "=SUM(...)" in a parent's note stays a sentence.
 */
function cellForBoard(kind, value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value === null || value === undefined || value === '') return '';
  const s = String(value).trim();
  if (kind === 'time') {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
    if (!m) return s;
    return (Number(m[1]) * 60 + Number(m[2])) / 1440;
  }
  if (kind === 'portion') {
    const pct = /^(\d{1,3})%$/.exec(s);
    if (pct) return Number(pct[1]) / 100;
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
  }
  if (kind === 'text' && /^\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** Does the live cell hold our value as text where the board wants a number? */
function needsNumericRepair(kind, rawCell, ourValue) {
  if (typeof rawCell !== 'string' || rawCell === '') return false;
  if (!(kind === 'time' || kind === 'portion' || kind === 'text')) return false;
  const converted = cellForBoard(kind, ourValue);
  return typeof converted === 'number' && rawCell.trim() === String(ourValue).trim();
}

function defaultDeps() {
  const { readGrids, writeCells } = require('./sheets-client');
  const { Child, DailyLog, SheetSyncState } = require('../../models');
  return {
    readGrids,
    writeCells,
    childrenByAccessId: async (accessIds) => {
      // `$ne: ''` as well as the caller's own filter: `sheet_access_id`
      // defaults to an empty string on every Child who was never in the old
      // sheet, so a single blank id reaching this query would return a crowd
      // of unrelated children under one key.
      const rows = await Child.find({ sheet_access_id: { $in: accessIds, $ne: '' } })
        .select('_id child_name sheet_access_id classroom_id').lean();
      // `sheet_access_id` is indexed, not unique, so two Child documents can
      // hold one id. Keying them into a Map would quietly keep whichever came
      // back last and file a whole day onto a child chosen by sort order. The
      // id is dropped instead, and the pass reports the row as one it could
      // not resolve.
      const timesSeen = new Map();
      for (const r of rows) timesSeen.set(r.sheet_access_id, (timesSeen.get(r.sheet_access_id) || 0) + 1);
      return new Map(rows.filter(r => timesSeen.get(r.sheet_access_id) === 1).map(r => [r.sheet_access_id, r]));
    },
    loadLogs: async (childIds, date) => {
      const rows = await DailyLog.find({ child_id: { $in: childIds }, date }).lean();
      // `.lean()` hands back the stored document, not the schema's idea of it:
      // a row written before `missing` or `sync_conflicts` existed comes back
      // without those keys rather than with their defaults. Filling them here
      // means the rest of this file never has to ask which era a row is from.
      return new Map(rows.map(r => [String(r.child_id), {
        ...r,
        missing: Array.isArray(r.missing) ? r.missing : [],
        sync_conflicts: Array.isArray(r.sync_conflicts) ? r.sync_conflicts : [],
      }]));
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

/**
 * What the sheet says about this child, as DailyLog paths.
 *
 * `dailyLogSet` drops blanks, which is right for a one-way import — the old
 * sheet's silence is not a correction — and wrong for a mirror, where a field
 * the room CLEARED is an edit that has to travel. So every column the grid
 * actually has appears here, blank included, and a column the grid does not
 * have does not: that is not an empty answer, it is a question the sheet was
 * never asked, and inventing it would push our value into a column nobody has.
 *
 * A cell that holds something `readCell` cannot turn into a value is the one
 * case that is neither. It is reported and left out, because calling it blank
 * would read a stray number in the wake-time column as "the room cleared the
 * wake time" and wipe a real one.
 */
function sheetSideOf(pair) {
  const { set, rejected } = dailyLogSet(pair.values);
  const unreadable = new Set(rejected.map(r => r.path));
  const flat = {};
  const dropped = [];

  for (const column of Object.keys(pair.values)) {
    const name = normalizeFieldName(column);
    const def = FIELD_MAP[name];
    if (!def) continue;
    if (unreadable.has(def.path)) {
      dropped.push({ kind: 'field', access_id: pair.access_id, name: pair.name, field: name, why: 'the cell holds something this pass cannot read; left as it is' });
      continue;
    }
    flat[def.path] = Object.prototype.hasOwnProperty.call(set, def.path)
      ? set[def.path]
      : (def.kind === 'list' ? [] : '');
  }
  return { flat, dropped };
}

/** Our record, answering exactly the fields the sheet asked about. */
function ourSideOf(log, sheetFlat) {
  const flat = {};
  for (const path of Object.keys(sheetFlat)) {
    const v = atPath(log, path);
    // A missing path and a stored null are the same fact — nobody has said —
    // and it has to arrive in the shape the sheet's side of the comparison
    // uses, or an empty list would read as a change against an empty string.
    flat[path] = v === undefined || v === null
      ? (Array.isArray(sheetFlat[path]) ? [] : '')
      : v;
  }
  return flat;
}

async function runPass({ branchId, sheetId, date, mode = 'dry', deps = null }) {
  // `mode` decides whether anything at all leaves this function, and it comes
  // from a Setting a person edits by hand. Anything that is not one of the two
  // words behaves exactly like 'dry' if it is merely compared against 'write'
  // — safe for the data, and the worst possible outcome for the operator, who
  // reads a result carrying non-zero `in` and `out` and believes write-back
  // has been on for days while the two boards quietly diverge. Refused before
  // a single cell is read.
  if (mode !== 'dry' && mode !== 'write') {
    throw new Error(`sheet-sync: unknown mode "${mode}" — expected "dry" or "write"`);
  }
  const d = deps || defaultDeps();
  const result = { date, children: 0, in: 0, out: 0, conflicts: 0, skipped: [], errors: [] };

  const grids = await d.readGrids(sheetId);
  const childGrid = grids.children || [];
  const todayGrid = grids.today || [];
  const childRows = parseChildRows(childGrid);

  // Both tabs, both anchored on their own header row — see roster.js for why
  // the first named child is not a safe origin. The header comes back with the
  // pairs so that the column a value was READ from and the column it is
  // WRITTEN to are the same lookup over the same array; re-deriving it here is
  // how those two drift apart.
  const { pairs, errors, header, headerIndex } = pairRows({ childRows, childGrid, todayRows: todayGrid });
  // A refusal here is not a partial result to work around. Pairing is by
  // position and nothing else, so "most of it lined up" means the rest lined
  // up onto the wrong families. Nothing has been read or written yet, and
  // that is where this stops.
  if (errors.length) { result.errors = errors; return result; }
  result.children = pairs.length;

  // A roster row whose AccessID cell is empty is not an identity. Asking the
  // database about '' would match every child who was never in the old sheet.
  //
  // Neither is an AccessID that two rows carry. Both rows would resolve to one
  // Child: the second row's merge overwrites the first against the same stale
  // log, and in the other direction that child's outgoing value is written
  // into BOTH rows, clobbering whatever the room typed in the other one. A
  // copy-pasted roster row is an ordinary live edit, and this is the same
  // refusal `scripts/sheet-sync-match.js` already makes when it establishes
  // the links — a pass must not be more permissive than the script that
  // decided which child is which.
  //
  // Skipped, not refused for the whole pass, and the distinction is
  // deliberate: pairRows refuses a structural problem because position is the
  // only mechanism it has, so a bad structure makes EVERY row suspect. A
  // repeated id says nothing about the rows that do not carry it — they are
  // still paired correctly and their day is still theirs. Same reasoning as
  // the blank id above, and the same choice the match script makes.
  const timesSeen = new Map();
  for (const p of pairs) {
    if (p.access_id) timesSeen.set(p.access_id, (timesSeen.get(p.access_id) || 0) + 1);
  }

  const identified = [];
  for (const p of pairs) {
    if (!p.access_id) {
      result.skipped.push({ kind: 'row', access_id: '', name: p.name, row: p.row, why: 'the roster row carries no AccessID' });
    } else if (timesSeen.get(p.access_id) > 1) {
      result.skipped.push({ kind: 'row', access_id: p.access_id, name: p.name, row: p.row, why: 'more than one roster row carries this AccessID' });
    } else {
      identified.push(p);
    }
  }

  const asked = identified.map(p => p.access_id);
  const byAccess = await d.childrenByAccessId(asked);
  const known = identified.filter(p => byAccess.has(p.access_id));
  // An id we asked about and got nothing back for. `Child.sheet_access_id` is
  // indexed but not unique, so this covers two cases the Map cannot tell
  // apart — no child carries the id, or several do and the lookup refused to
  // pick one. Both mean the same thing here: there is no child this row can
  // safely be, so the row is reported and left alone.
  for (const p of identified) {
    if (!byAccess.has(p.access_id)) {
      result.skipped.push({ kind: 'row', access_id: p.access_id, name: p.name, why: 'no single Child carries this sheet_access_id' });
    }
  }
  // And an answer about something nobody asked about means the lookup is not
  // keyed the way this pass believes it is. Never used, always reported.
  for (const id of byAccess.keys()) {
    if (!asked.includes(id)) {
      result.skipped.push({ kind: 'row', access_id: id, name: '', why: 'the lookup answered about an id this pass never asked for' });
    }
  }

  const logs = await d.loadLogs(known.map(p => String(byAccess.get(p.access_id)._id)), date);
  const shadow = await d.loadShadow(branchId, date);

  const nextShadow = {};
  const cellWrites = [];

  for (const pair of known) {
    const child = byAccess.get(pair.access_id);
    const { flat: sheetFlat, dropped } = sheetSideOf(pair);
    result.skipped.push(...dropped);

    const log = logs.get(String(child._id)) || {};
    const ourFlat = ourSideOf(log, sheetFlat);

    const { toOurs, toSheet, conflicts } = merge({
      sheet: sheetFlat,
      ours: ourFlat,
      shadow: shadow[pair.access_id] || {},
    });

    if (Object.keys(toOurs).length || conflicts.length) {
      result.in += Object.keys(toOurs).length;
      result.conflicts += conflicts.length;
      if (mode === 'write') {
        // eslint-disable-next-line no-await-in-loop
        await d.saveLog(
          String(child._id),
          toOurs,
          conflicts.map(c => ({ field: c.field, ours: c.ours, at: new Date() })),
          { date, childName: child.child_name, branchId, classroomId: child.classroom_id || null },
        );
      }
    }

    // Every row and column below is read off the grid this pass just read,
    // never computed beside it: `writeCells` has no bounds check of its own,
    // and the Sheets API grows a sheet to fit an out-of-range write rather
    // than refusing it. A target derived from anything but that grid can
    // therefore append phantom rows to the board the room is looking at. The
    // column is an index into the very header the values were keyed by, and
    // the row must sit below that header and inside the grid.
    //
    // `queued` is the half of `toSheet` that a write was actually made for,
    // and it — never `toSheet` — is what the shadow is allowed to claim
    // below. The two used to be able to diverge, and the divergence is the
    // worst class of bug this file has: the shadow's entire meaning is "this
    // is what the sheet holds", so claiming a value that was never sent makes
    // the next pass read the sheet's unchanged cell as the sheet having
    // moved, our record as having stayed still, and revert a staff member's
    // edit on the new board with no conflict raised and nothing logged.
    // Cells this pass (or an earlier one) wrote as text into a column the old
    // board reads as a number: the value agrees on both sides, so the merge
    // has nothing to say about it, and it would stay "---" on the parent's
    // board forever. Re-sent once, as a number; from then on it reads as
    // agreed. Only where the sheet's cell is exactly our string — a cell a
    // person typed differently is theirs, and the merge decides about it.
    const outgoing = { ...toSheet };
    for (const [column, def] of Object.entries(FIELD_MAP)) {
      if (Object.prototype.hasOwnProperty.call(outgoing, def.path)) continue;
      const col = header.indexOf(normalizeFieldName(column));
      if (col < 0 || pair.row <= headerIndex || pair.row >= todayGrid.length) continue;
      const raw = (todayGrid[pair.row] || [])[col];
      const ours = ourFlat[def.path];
      if (needsNumericRepair(def.kind, raw, ours)) outgoing[def.path] = ours;
    }

    const queued = {};
    for (const [path, value] of Object.entries(outgoing)) {
      const report = (why) => result.skipped.push({
        kind: 'cell', access_id: pair.access_id, name: pair.name, field: path, why,
      });

      // `normalizeFieldName(undefined)` is '', and `header.indexOf('')` finds
      // the first blank header column — real boards carry trailing blanks —
      // so an unmapped path does NOT fall through to the `col < 0` guard
      // below. It lands on an arbitrary empty column of the board the room is
      // looking at. Rejected on the name, before any index lookup.
      const column = COLUMN_FOR_PATH[path] ? normalizeFieldName(COLUMN_FOR_PATH[path]) : '';
      if (!column) { report('no sheet column is mapped to this field; nothing was written'); continue; }

      // One cell, one value: `missing` is several things and the board has
      // always shown them comma-joined in a single cell. Which makes an item
      // that itself contains the separator unwritable — the sheet's own
      // reader (`splitMissing`) would hand back more items than we sent, the
      // next pass would read that as the sheet having been edited, and our
      // list would be rewritten to the longer one on the parent-facing board.
      // Not reachable from the board's multi-select, reachable from the API
      // and from a hand-edited options list, so it is refused here rather
      // than trusted not to happen.
      const offending = Array.isArray(value) ? value.filter(v => /[,|]/.test(String(v))) : [];
      if (offending.length) {
        report(`an item carries the list separator and cannot survive the round trip: ${offending.join(' / ')}`);
        continue;
      }

      // Neither of the two bounds guards should ever be reachable: the column
      // was in the header a moment ago, when the value was read out of it,
      // and `pairRows` already refused a grid too short for the roster. An
      // unreachable branch is exactly where a silent `continue` costs the
      // most — it is the branch nobody will ever look for — so both say so.
      const col = header.indexOf(column);
      if (col < 0) { report(`the live tab has no "${column}" column any more; nothing was written`); continue; }
      if (pair.row <= headerIndex || pair.row >= todayGrid.length) {
        report(`row ${pair.row} is outside the grid this pass read; nothing was written`);
        continue;
      }

      cellWrites.push({
        tab: SHEET.today,
        row: pair.row,
        col,
        value: cellForBoard(FIELD_MAP[normalizeFieldName(COLUMN_FOR_PATH[path])]?.kind, value),
      });
      queued[path] = value;
      result.out += 1;
    }

    // What the sheet will hold once this pass finishes: what it held, with the
    // outgoing values that were actually queued over the top. A field nobody
    // could read is deliberately absent — next pass it is unclassifiable
    // rather than falsely agreed, and unclassifiable resolves to a conflict a
    // person sees, not a silent wipe. A field we declined to write is absent
    // from `queued` for the same reason: the sheet still holds what it held,
    // and that is what this must go on saying.
    nextShadow[pair.access_id] = { ...sheetFlat, ...queued };
  }

  // A dry run answers "what would this do" and leaves no trace of the answer:
  // no child's day is altered on either board, and above all no shadow is
  // written, which would make the real run that follows believe it had
  // already agreed. It is not a claim that the process as a whole writes
  // nothing while in dry mode — `sheetSyncJob` still records that a branch
  // was attempted and how the night's audit went, deliberately, because
  // diagnostics are most needed during the read-only phase. Those touch
  // neither board nor shadow. See that file's header.
  if (mode === 'write') {
    if (cellWrites.length) await d.writeCells(sheetId, cellWrites);
    // Only now: the shadow claims the two sides agreed, and it may only make
    // that claim about writes that actually landed.
    await d.saveShadow(nextShadow, {
      branchId, sheetId, date, conflicts: result.conflicts, in: result.in, out: result.out,
    });
  }

  return result;
}

module.exports = { runPass, atPath, COLUMN_FOR_PATH, sheetSideOf, ourSideOf };
