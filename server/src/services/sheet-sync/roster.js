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
  if (todayHeaderIndex < 0) return { pairs: [], errors: ['סדר יום: header row not found'] };

  const rosterHeaderIndex = (childGrid || []).findIndex(r => (r || []).some(c => normalizeFieldName(c) === 'שם מלא'));
  if (rosterHeaderIndex < 0) return { pairs: [], errors: ['ילדים: header row not found'] };

  const header = (grid[todayHeaderIndex] || []).map(normalizeFieldName);
  const children = childRows || [];
  if (children.length === 0) return { pairs: [], errors: ['ילדים: no children'] };

  const rosterFirstRow = rosterHeaderIndex + 1;
  const lastNeeded = todayHeaderIndex + 1 + (children[children.length - 1].row - rosterFirstRow);
  if (lastNeeded >= grid.length) {
    errors.push(`סדר יום has ${grid.length} rows, needs ${lastNeeded + 1} for ${children.length} children`);
    return { pairs: [], errors };
  }

  const pairs = children.map((child) => {
    const row = todayHeaderIndex + 1 + (child.row - rosterFirstRow);
    const cells = grid[row] || [];
    const values = {};
    header.forEach((name, c) => { if (name) values[name] = cells[c] === undefined ? '' : cells[c]; });
    return { row, access_id: child.access_id, name: child.name, values };
  });
  return { pairs, errors };
}

module.exports = { pairRows };
