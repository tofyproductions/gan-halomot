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
      // `$ne: ''` as well as the caller's own filter: `sheet_access_id`
      // defaults to an empty string on every Child who was never in the old
      // sheet, so a single blank id reaching this query would return a crowd
      // of unrelated children under one key.
      const rows = await Child.find({ sheet_access_id: { $in: accessIds, $ne: '' } })
        .select('_id child_name sheet_access_id classroom_id').lean();
      return new Map(rows.map(r => [r.sheet_access_id, r]));
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
      dropped.push({ access_id: pair.access_id, name: pair.name, field: name, why: 'the cell holds something this pass cannot read; left as it is' });
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
  const d = deps || defaultDeps();
  const result = { date, children: 0, in: 0, out: 0, conflicts: 0, skipped: [], errors: [] };

  const grids = await d.readGrids(sheetId);
  const childGrid = grids.children || [];
  const todayGrid = grids.today || [];
  const childRows = parseChildRows(childGrid);

  // Both tabs, both anchored on their own header row — see roster.js for why
  // the first named child is not a safe origin.
  const { pairs, errors } = pairRows({ childRows, childGrid, todayRows: todayGrid });
  // A refusal here is not a partial result to work around. Pairing is by
  // position and nothing else, so "most of it lined up" means the rest lined
  // up onto the wrong families. Nothing has been read or written yet, and
  // that is where this stops.
  if (errors.length) { result.errors = errors; return result; }
  result.children = pairs.length;

  // Every row and column written below is read off this grid, never computed
  // beside it: `writeCells` has no bounds check of its own, and the Sheets API
  // grows a sheet to fit an out-of-range write rather than refusing it. A
  // target derived from anything but the grid we just read can therefore
  // append phantom rows to the board the room is looking at.
  const headerIndex = todayGrid.findIndex(r => (r || []).some(c => normalizeFieldName(c) === 'התעורר בבית'));
  const header = (todayGrid[headerIndex] || []).map(normalizeFieldName);

  // A roster row whose AccessID cell is empty is not an identity. Asking the
  // database about '' would match every child who was never in the old sheet.
  const identified = [];
  for (const p of pairs) {
    if (p.access_id) identified.push(p);
    else result.skipped.push({ access_id: '', name: p.name, row: p.row, why: 'the roster row carries no AccessID' });
  }

  const byAccess = await d.childrenByAccessId(identified.map(p => p.access_id));
  const known = identified.filter(p => byAccess.has(p.access_id));
  for (const p of identified) {
    if (!byAccess.has(p.access_id)) {
      result.skipped.push({ access_id: p.access_id, name: p.name, why: 'no Child carries this sheet_access_id' });
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

    for (const [path, value] of Object.entries(toSheet)) {
      const col = header.indexOf(normalizeFieldName(COLUMN_FOR_PATH[path]));
      if (col < 0) continue;
      if (pair.row < 0 || pair.row >= todayGrid.length) continue;
      cellWrites.push({
        tab: SHEET.today,
        row: pair.row,
        col,
        // One cell, one value: `missing` is several things and the board has
        // always shown them comma-joined in a single cell.
        value: Array.isArray(value) ? value.join(', ') : value,
      });
      result.out += 1;
    }

    // What the sheet will hold once this pass finishes: what it held, with our
    // outgoing values over the top. A field nobody could read is deliberately
    // absent — next pass it is unclassifiable rather than falsely agreed, and
    // unclassifiable resolves to a conflict a person sees, not a silent wipe.
    nextShadow[pair.access_id] = { ...sheetFlat, ...toSheet };
  }

  // A dry run answers "what would this do" and must leave no trace anywhere:
  // not in the database, not in the sheet, and above all not in the shadow,
  // which would make the real run that follows believe it had already agreed.
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
