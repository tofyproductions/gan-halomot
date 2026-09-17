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
