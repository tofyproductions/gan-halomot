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
    // `missing` (what a family needs to bring tomorrow) is the only list on
    // the board, and it is typed by hand, in whatever order the staff member
    // notices things, into one comma-joined cell. There is no "set" on the
    // sheet's side to compare against — reordering the line IS the edit a
    // person just made to it. Comparing by position, not by membership, is
    // what lets that rewrite reach the other board; a set comparison here
    // would make a staff member's re-typed line look unchanged and drop it
    // silently, which is exactly the failure this file exists to prevent.
    const l = Array.isArray(a) ? a : [];
    const r = Array.isArray(b) ? b : [];
    return l.length === r.length && l.every((x, i) => x === r[i]);
  }
  if (blank(a) && blank(b)) return true;
  return a === b;
}

// No shape is refused. A caller passing nothing, or an explicit null, is not
// a caller with malformed data — it is the first pass, or a field nobody has
// touched on any side — and this file's whole premise is that "we don't know
// yet" must resolve to "nothing moves", never to a thrown error.
function merge(args) {
  const { sheet, ours, shadow } = args || {};
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
