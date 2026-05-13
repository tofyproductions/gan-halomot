/**
 * Shared branch color palette.
 *
 * Each branch is identified by a stable color across the whole app — payroll,
 * attendance, employee lists. The Branch document can store an explicit
 * `color` name (one of the keys below) for permanent customisation; otherwise
 * a stable color is derived from the branch's index in the alphabetical list.
 */

export const BRANCH_PALETTE = {
  blue:   { header: '#dbeafe', sub: '#eff6ff', cell: '#f8fafc', accent: '#1e40af', border: '#93c5fd', dot: '#3b82f6' },
  green:  { header: '#d1fae5', sub: '#ecfdf5', cell: '#f7fef9', accent: '#065f46', border: '#86efac', dot: '#10b981' },
  purple: { header: '#ede9fe', sub: '#f5f3ff', cell: '#fbfaff', accent: '#5b21b6', border: '#c4b5fd', dot: '#8b5cf6' },
  orange: { header: '#ffedd5', sub: '#fff7ed', cell: '#fffbf6', accent: '#9a3412', border: '#fdba74', dot: '#f97316' },
  rose:   { header: '#ffe4e6', sub: '#fff1f2', cell: '#fffafa', accent: '#9f1239', border: '#fda4af', dot: '#f43f5e' },
  teal:   { header: '#ccfbf1', sub: '#f0fdfa', cell: '#f6fefc', accent: '#115e59', border: '#5eead4', dot: '#14b8a6' },
};

export const BRANCH_COLOR_NAMES = Object.keys(BRANCH_PALETTE);

const PALETTE_ORDER = BRANCH_COLOR_NAMES;

/**
 * Get the color palette for a branch.
 *  - If the branch document has an explicit `color` field, use it.
 *  - Otherwise fall back to the position-based color (stable for the same
 *    `idx` even if branches are added/removed in unrelated positions).
 */
export function branchColor(branch, idx = 0) {
  const name = (branch && branch.color) ? branch.color : PALETTE_ORDER[idx % PALETTE_ORDER.length];
  return BRANCH_PALETTE[name] || BRANCH_PALETTE[PALETTE_ORDER[0]];
}

export function branchColorName(branch, idx = 0) {
  return (branch && branch.color) ? branch.color : PALETTE_ORDER[idx % PALETTE_ORDER.length];
}
