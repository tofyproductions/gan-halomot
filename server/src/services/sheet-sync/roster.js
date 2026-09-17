/**
 * Pairing the live board's rows to children, and children to our database.
 *
 * Two tabs are read in the same pass and never cached between passes: a child
 * added to or removed from `ילדים` shifts every row below them in `סדר יום`,
 * and a stale order would move one family's day onto another's.
 */
const { normalizeFieldName } = require('../../../scripts/lib/nursery-history');

/**
 * Child *n* after the roster's header owns row *n* after the live tab's header.
 *
 * Both tabs are written by the same script in the same physical layout, so
 * each tab's own header row is the only stable origin to anchor the offset
 * on. The first NAMED child is not a safe anchor: a blank slot sitting
 * between the header and that first child — a place nobody has been put in
 * yet — shifts the first child down without moving the header at all.
 * Anchoring on `childRows[0].row` instead of on the roster's own header row
 * silently assumes that gap can never happen, and when it does, this does
 * not raise an error — it moves a day onto the wrong child. So both sides
 * are re-derived from their own header here, the same way `parseChildRows`
 * finds the roster's, rather than trusting the first row a caller happens
 * to have parsed.
 *
 * Refuses rather than guesses. A live tab with fewer rows than the roster has
 * children means the sheet is mid-edit or the assumption is wrong, and a
 * partial pairing there is worse than no pairing at all — it silently writes
 * the last few children's days onto the wrong records.
 */
function pairRows({ childRows, childGrid, todayRows }) {
  const errors = [];
  const grid = todayRows || [];
  const todayHeaderIndex = grid.findIndex(r => (r || []).some(c => normalizeFieldName(c) === 'התעורר בבית'));
  if (todayHeaderIndex < 0) return refusal(['סדר יום: header row not found'], [], -1);

  const rosterHeaderIndex = (childGrid || []).findIndex(r => (r || []).some(c => normalizeFieldName(c) === 'שם מלא'));
  if (rosterHeaderIndex < 0) return refusal(['ילדים: header row not found'], [], todayHeaderIndex);

  const header = (grid[todayHeaderIndex] || []).map(normalizeFieldName);

  /**
   * Two columns whose headers normalize to one name are refused outright.
   *
   * `values` below is keyed by the normalized name, so on a repeat the LAST
   * column silently wins the read — while anything locating that column again
   * by name would land on the FIRST. That is not a duplicate-data problem, it
   * is reading one cell and writing another, on a board a room is looking at.
   * The headers hold newlines and this function folds whitespace and
   * punctuation, so two visually distinct headers colliding is a live-edit
   * away. Refused here, where the name is first turned into a key, rather
   * than guarded separately in every caller that ever looks a column up.
   */
  const seen = new Set();
  const repeated = new Set();
  for (const name of header) {
    if (!name) continue;
    if (seen.has(name)) repeated.add(name); else seen.add(name);
  }
  if (repeated.size) {
    return refusal([`סדר יום: two columns carry the same name (${[...repeated].join(', ')})`], header, todayHeaderIndex);
  }

  const children = childRows || [];
  if (children.length === 0) return refusal(['ילדים: no children'], header, todayHeaderIndex);

  const rosterFirstRow = rosterHeaderIndex + 1;
  const lastNeeded = todayHeaderIndex + 1 + (children[children.length - 1].row - rosterFirstRow);
  if (lastNeeded >= grid.length) {
    errors.push(`סדר יום has ${grid.length} rows, needs ${lastNeeded + 1} for ${children.length} children`);
    return refusal(errors, header, todayHeaderIndex);
  }

  const pairs = children.map((child) => {
    const row = todayHeaderIndex + 1 + (child.row - rosterFirstRow);
    const cells = grid[row] || [];
    const values = {};
    header.forEach((name, c) => { if (name) values[name] = cells[c] === undefined ? '' : cells[c]; });
    return { row, access_id: child.access_id, name: child.name, values };
  });
  // The header travels with the pairs on purpose. A caller that wants to write
  // a value back has to find that column's index, and re-deriving the header
  // to do it is how the two halves drift apart — the read keyed by name, the
  // write located by a second, differently-written lookup.
  return { pairs, errors, header, headerIndex: todayHeaderIndex };
}

function refusal(errors, header, headerIndex) {
  return { pairs: [], errors, header, headerIndex };
}

module.exports = { pairRows };
