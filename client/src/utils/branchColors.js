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

/* ─── Per-gan marker colours (single source of truth) ───────────────────
 * Fixed vivid "marker" colour per kindergarten, matched by substring of the
 * branch name so it survives prefix changes ("כפר סבא - משה דיין" → orange).
 * Used by the payroll table, the branch switcher, attendance, and any other
 * place that renders a per-gan table so colours stay consistent system-wide.
 *   strip      = vivid header / chip background
 *   stripText  = text colour on the strip
 *   nameTint   = light wash for the sticky name column
 *   rowTint    = very light wash for the whole row body
 *   accent     = thick separator / spine / border colour
 */
export const GAN_MARKERS = [
  { match: ['תל אביב', 'תל-אביב', 'ת"א'], strip: '#ef4444', stripText: '#ffffff', nameTint: '#fecaca', rowTint: '#fef2f2', accent: '#dc2626' }, // red
  { match: ['הרצליה'],                      strip: '#facc15', stripText: '#3f2d00', nameTint: '#fef08a', rowTint: '#fefce8', accent: '#eab308' }, // yellow
  { match: ['משה דיין'],                    strip: '#f97316', stripText: '#ffffff', nameTint: '#fed7aa', rowTint: '#fff7ed', accent: '#ea580c' }, // orange
  { match: ['קפלן'],                         strip: '#ec4899', stripText: '#ffffff', nameTint: '#fbcfe8', rowTint: '#fdf2f8', accent: '#db2777' }, // pink
];

/**
 * Colours for a branch nobody wrote down.
 *
 * The list above is גן החלומות's four branches by name, which is right for
 * them and wrong for everybody else: any other customer's branches match
 * nothing, and a missing marker meant no colour at all. In the header that
 * came out as pale text on a pale background — the branch switcher showed the
 * selected branch in white on white and could not be read.
 *
 * So an unnamed branch gets a colour instead of nothing. Picked from the name
 * rather than from its position in a list, so it does not change when a branch
 * is added, renamed around it, or the list is sorted differently — a gan whose
 * colours move on Tuesday has no colours at all.
 */
const FALLBACK_MARKERS = [
  { strip: '#3b82f6', stripText: '#ffffff', nameTint: '#bfdbfe', rowTint: '#eff6ff', accent: '#2563eb' }, // blue
  { strip: '#10b981', stripText: '#ffffff', nameTint: '#a7f3d0', rowTint: '#ecfdf5', accent: '#059669' }, // green
  { strip: '#8b5cf6', stripText: '#ffffff', nameTint: '#ddd6fe', rowTint: '#f5f3ff', accent: '#7c3aed' }, // purple
  { strip: '#06b6d4', stripText: '#ffffff', nameTint: '#a5f3fc', rowTint: '#ecfeff', accent: '#0891b2' }, // cyan
  { strip: '#f59e0b', stripText: '#3f2d00', nameTint: '#fde68a', rowTint: '#fffbeb', accent: '#d97706' }, // amber
  { strip: '#64748b', stripText: '#ffffff', nameTint: '#cbd5e1', rowTint: '#f8fafc', accent: '#475569' }, // slate
  { strip: '#e11d48', stripText: '#ffffff', nameTint: '#fecdd3', rowTint: '#fff1f2', accent: '#be123c' }, // rose
  { strip: '#65a30d', stripText: '#ffffff', nameTint: '#d9f99d', rowTint: '#f7fee7', accent: '#4d7c0f' }, // lime
  { strip: '#0ea5e9', stripText: '#ffffff', nameTint: '#bae6fd', rowTint: '#f0f9ff', accent: '#0284c7' }, // sky
  { strip: '#d946ef', stripText: '#ffffff', nameTint: '#f5d0fe', rowTint: '#fdf4ff', accent: '#c026d3' }, // fuchsia
  { strip: '#14b8a6', stripText: '#ffffff', nameTint: '#99f6e4', rowTint: '#f0fdfa', accent: '#0d9488' }, // teal
  { strip: '#a16207', stripText: '#ffffff', nameTint: '#fde68a', rowTint: '#fefce8', accent: '#854d0e' }, // bronze
];

export function ganMarkerByName(branchName) {
  const n = branchName || '';
  const named = GAN_MARKERS.find(g => g.match.some(m => n.includes(m)));
  if (named) return named;
  if (!n) return null;

  // FNV-1a rather than the usual ×31. Branch names in one gan share a prefix
  // far more often than not — "סניף מזרח", "סניף מרכז", "סניף צפון" — and ×31
  // put two of those four on the same colour. This spreads them.
  let h = 0x811c9dc5;
  for (let i = 0; i < n.length; i += 1) {
    h ^= n.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return FALLBACK_MARKERS[h % FALLBACK_MARKERS.length];
}
