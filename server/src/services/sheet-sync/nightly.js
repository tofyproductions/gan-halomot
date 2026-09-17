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
      // Same guard as the daytime pass (`run.js`): `sheet_access_id` defaults
      // to '' on every Child never on the old board, so a blank id reaching
      // this query would match a crowd of unrelated children under one key,
      // and the index is not unique, so a ambiguous id must resolve to
      // "unknown" rather than to whichever document Mongo happened to return
      // last.
      const rows = await Child.find({ sheet_access_id: { $in: ids, $ne: '' } })
        .select('_id child_name sheet_access_id').lean();
      const timesSeen = new Map();
      for (const r of rows) timesSeen.set(r.sheet_access_id, (timesSeen.get(r.sheet_access_id) || 0) + 1);
      return new Map(rows.filter(r => timesSeen.get(r.sheet_access_id) === 1).map(r => [r.sheet_access_id, r]));
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
  // Two rows can share a date — the archive job fired twice on three real
  // days, and on one of them the LATER run held an empty board because it
  // fired after the nightly reset had already wiped the sheet (see
  // `chooseSnapshot` in nursery-history.js, built for the importer's own
  // version of this problem). This check does not attempt that judgment call;
  // it takes whichever row `find` returns first, which is the first one
  // written that night. See task-9-report.md for why that is flagged rather
  // than resolved here.
  const row = (history || []).slice(1).find(r => String(r[0] || '').startsWith(date));
  if (!row) return out; // the archive has not been written yet — not a failure

  // historyChildren takes the PARSED payload, not the cell's text — it
  // distinguishes the two blob shapes and throws on anything else.
  let entries;
  try { entries = historyChildren(JSON.parse(row[1])); } catch (e) { return { ...out, error: `archive JSON did not parse: ${e.message}` }; }
  const withId = (entries || []).filter(e => e.accessId);
  if (withId.length === 0) return out;

  const byAccess = await d.childrenByAccessId(withId.map(e => e.accessId));
  // An accessId the archive carries but no current Child answers to — a child
  // who left, or an ambiguous id the lookup refused to resolve — is not a
  // disagreement about a field; there is nobody on our side to compare
  // against, so it is left out rather than named with data that isn't theirs.
  const known = withId.filter(e => byAccess.has(e.accessId));
  const logs = await d.loadLogs(known.map(e => String(byAccess.get(e.accessId)._id)), date);

  for (const entry of known) {
    const child = byAccess.get(entry.accessId);
    const log = logs.get(String(child._id)) || {};
    // `dailyLogSet` drops blanks, which is right here too: a column the
    // archive holds nothing for is not a claim of "the room cleared it", it's
    // silence, and silence should agree with our side's silence rather than
    // report a phantom disagreement every night.
    const { set } = dailyLogSet(entry.data || {});
    out.checked += 1;
    let ok = true;
    // Only the columns the archive actually carries for this child are
    // compared — same rule `sheetSideOf` follows in run.js. A field our side
    // holds that the archive's row has no column for is not "the archive
    // disagrees", it's a question the archive was never asked, and treating
    // it as a mismatch would flag every field the old board simply didn't
    // track.
    for (const column of Object.keys(entry.data || {})) {
      const def = FIELD_MAP[normalizeFieldName(column)];
      if (!def) continue;
      const archiveValue = Object.prototype.hasOwnProperty.call(set, def.path)
        ? set[def.path] : (def.kind === 'list' ? [] : '');
      const ourValue = atPath(log, def.path);
      if (!sameValue(archiveValue, ourValue)) {
        ok = false;
        out.disagreed.push({
          access_id: entry.accessId, name: child.child_name, field: def.path,
          archive: archiveValue, ours: ourValue === undefined ? '' : ourValue,
        });
      }
    }
    if (ok) out.agreed += 1;
  }
  return out;
}

module.exports = { verifyDay };
