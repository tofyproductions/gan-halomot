/**
 * Shared branch color palette.
 *
 * Each branch is identified by a stable color across the whole app — payroll,
 * attendance, employee lists. The Branch document can store an explicit
 * `color` name (one of the keys below) for permanent customisation; otherwise
 * a stable color is derived from the branch's index in the alphabetical list.
 */

/**
 * Built from theme/tokens.js#COLOR.branch rather than written out here.
 *
 * The colours themselves moved into the token file so they could be measured:
 * every strip/text pair and every wash is checked against AA by
 * server/scripts/design-tokens.test.js, and the twelve are asserted distinct —
 * telling four gans apart at a glance is this palette's entire job. What stays
 * in this file is the part that is logic rather than colour: which gan gets
 * which, and what an unnamed one falls back to.
 */
const shape = (b) => ({
  header: b.nameTint, sub: b.rowTint, cell: b.rowTint,
  accent: b.accent, border: b.nameTint, dot: b.strip,
});

import { COLOR } from '../theme/tokens';

export const BRANCH_PALETTE = {
  blue: shape(COLOR.branch.blue),
  green: shape(COLOR.branch.green),
  purple: shape(COLOR.branch.violet),
  orange: shape(COLOR.branch.orange),
  rose: shape(COLOR.branch.rose),
  teal: shape(COLOR.branch.cyan),
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
  { match: ['תל אביב', 'תל-אביב', 'ת"א'], ...COLOR.branch.red },
  { match: ['הרצליה'], ...COLOR.branch.amber },
  { match: ['משה דיין'], ...COLOR.branch.orange },
  { match: ['קפלן'], ...COLOR.branch.pink },
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
  COLOR.branch.blue, COLOR.branch.green, COLOR.branch.violet, COLOR.branch.cyan,
  COLOR.branch.amber, COLOR.branch.slate, COLOR.branch.rose, COLOR.branch.olive,
  COLOR.branch.bronze, COLOR.branch.red, COLOR.branch.orange, COLOR.branch.pink,
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
