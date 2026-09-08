/**
 * הדרגה קובעת את שכר הלימוד.
 *
 * THE FEE WAS THE ONE NUMBER NOBODY COULD DEFEND. At a subsidised branch the
 * monthly fee is the state's matrix — a subsidy tier (דרגה) crossed with the
 * child's age group — and until the contracts export was accepted the tier was
 * in neither file. So the placement screen asked for ONE tier and applied it to
 * a whole cohort, which is wrong for every family whose income differs from the
 * one that was typed, and a registration billed 1,410 carried no record of
 * where 1,410 came from.
 *
 * The contracts export carries the tier PER CHILD. This file is the arithmetic
 * that turns it into a fee, and it lives on its own for the same reason
 * paymentCheck.js does: it is a business rule about the state's price matrix,
 * it is asked from three different promotion paths plus two read-only screens,
 * and one copy is the only way those five agree. No database, no mongoose —
 * the caller loads the BranchPricing document and hands it over.
 *
 * WHAT IT REFUSES TO GUESS. A private (מעון פרטי) branch has no matrix at all,
 * a tier that matches no row is a tier this branch does not price, and an age
 * group with no column is a child the matrix does not cover. Each of those
 * returns null and the caller falls back to the fee a human chose — inventing a
 * number here would put a figure nobody agreed to onto a family's account, and
 * that is worse than asking.
 */

/**
 * ClickTac's age layers, in the order the state's matrix columns run.
 *
 * The matrix columns are the state's own wording (עד 15 חודש / 15–24 חודש /
 * מעל 24 חודש) and the export's layers are the vendor's (תינוק / פעוט / בוגר).
 * They are the same three brackets on the same two boundaries and they will
 * never be spelled the same, so the mapping is POSITIONAL — which is exactly
 * what /external-enrollments/pricing already hands the client as
 * `age_group_columns`, and exactly what the placement screen's tier picker has
 * always done (`t.prices[0]`, `[1]`, `[2]`).
 */
const AGE_GROUP_ORDER = ['תינוק', 'פעוט', 'בוגר'];

/**
 * The tier NUMBER a label names — its FIRST run of digits, or ''.
 *
 * ALL THE DIGITS WOULD BE THE WRONG ANSWER, and it was: the real state table
 * (PricingManager's TMT_5786, saved verbatim by the editor) labels its rows
 * "דרגה 3 (0–2,330)" — income bracket and all — and concatenating every digit
 * in that turns דרגה 3 into "302330", which matches nothing. Ten of the twelve
 * shipped rows were unreachable and the whole feature was silently a no-op.
 *
 * The first number in the label is the דרגה; everything after it is the
 * bracket the state prints beside it. "דרגה 3" -> "3", "3" -> "3",
 * "דרגה 3 (0–2,330)" -> "3", "דרגה" -> "".
 */
const tierNumberOf = (v) => String(v ?? '').match(/\d+/)?.[0] || '';

/**
 * Which row of the matrix this contract's דרגה is, or -1.
 *
 * THE LABEL FORMAT IS THE BRANCH'S, NOT OURS. A pricing document is typed in by
 * hand — or seeded from the state's own table — and its rows have been seen as
 * "דרגה 1", as "1", and as "דרגה 3 (0–2,330)". Comparing the whole string would
 * match none of them, so the match is on the tier NUMBER, which is the only
 * part of a label the state actually names.
 *
 * THERE IS NO POSITIONAL FALLBACK, deliberately. The state's own table starts
 * at דרגה 3 and skips דרגה 13, so "tier N is the Nth row" is false for every
 * real matrix — it priced דרגה 4 off the דרגה 3 row. A tier no label names is a
 * tier this branch does not price, and the caller asks a person instead.
 */
function tierIndex(tier, tiers = []) {
  const want = Number(tierNumberOf(tier));
  // 0 is "no tier" (see tierFeeFor) and a label with no number yields 0 too,
  // so a numeric compare never marries the two.
  if (!want) return -1;
  return tiers.findIndex(t => Number(tierNumberOf(t?.label)) === want);
}

/**
 * Which column of the matrix this child's age group is, or -1.
 *
 * The branch's own wording wins when it happens to match — a branch that typed
 * its columns as תינוק / פעוט / בוגר means exactly those — and otherwise the
 * position is used, because the columns are the same three brackets in the same
 * order whatever they are called.
 *
 * AND POSITION ONLY WHEN THERE ARE EXACTLY THREE COLUMNS. The positional rule
 * is a claim about a specific matrix: three columns, the state's three
 * brackets, in the state's order. A branch that priced two columns or four is
 * not that matrix, and mapping בוגר to column 2 of a four-column table would
 * bill a family off a bracket nobody chose. Fewer or more columns than the
 * three we know means the name has to match or nothing does.
 */
function ageGroupIndex(ageGroup, ageGroups = []) {
  const group = String(ageGroup || '').trim();
  if (!group) return -1;
  const byName = ageGroups.findIndex(g => String(g || '').trim() === group);
  if (byName >= 0) return byName;
  if (ageGroups.length !== AGE_GROUP_ORDER.length) return -1;
  return AGE_GROUP_ORDER.indexOf(group);
}

/**
 * The fee this child's דרגה prices, or null.
 *
 * `pricing` is a BranchPricing document (lean or hydrated), `tier` is the raw
 * `contract.tier` string off the row, and `ageGroup` is the group the child is
 * actually being placed in — the manager's override first, then the computed
 * one; see effectiveAgeGroup in the controller.
 *
 * TIER 0 AND A BLANK TIER BOTH MEAN "WE DO NOT KNOW". `parseContractsRow` keeps
 * the tier as a string precisely because 0 is a value a spreadsheet writes into
 * an empty cell, and a zeroth דרגה prices nothing — the state's brackets start
 * at 1. Reading 0 as a tier would price a whole cohort off row zero of somebody
 * else's matrix.
 */
function tierFeeFor({ pricing, tier, ageGroup } = {}) {
  if (!pricing || pricing.pricing_type !== 'subsidized') return null;
  // '' and '0' are both "no tier" — see above.
  if (!Number(tierNumberOf(tier))) return null;

  const tiers = Array.isArray(pricing.tiers) ? pricing.tiers : [];
  const row = tierIndex(tier, tiers);
  if (row < 0) return null;

  const col = ageGroupIndex(ageGroup, pricing.age_groups || []);
  if (col < 0) return null;

  const prices = Array.isArray(tiers[row]?.prices) ? tiers[row].prices : [];
  const fee = Number(prices[col]);
  // A cell that is empty, negative or not a number is a matrix that does not
  // price this combination — not a fee of zero.
  if (!Number.isFinite(fee) || fee <= 0) return null;

  return {
    fee,
    tier: String(tier).trim(),
    tier_label: tiers[row]?.label || `דרגה ${tierNumberOf(tier)}`,
    tier_index: row,
    age_group: String(ageGroup || '').trim(),
    age_group_index: col,
  };
}

/**
 * What this child's דרגה costs in EVERY age group — `{ תינוק, פעוט, בוגר }`,
 * each a number or null.
 *
 * BECAUSE THE ROOM DECIDES THE GROUP, AND THE ROOM IS PICKED AFTER THE BOARD IS
 * DRAWN. The placement screen shows a fee beside each child and then lets the
 * manager move that child into any room in the year — and `confirmPlacement`
 * bills the group of the room they landed in, not the group they were computed
 * into. One number per child was therefore a number that could be quietly
 * wrong by the time the button was pressed. The row carries the whole tier
 * line instead, and the screen re-reads it from whichever room is selected, so
 * what the board promises and what the confirm writes are the same arithmetic.
 */
function tierFeesByGroup({ pricing, tier } = {}) {
  const out = {};
  for (const group of AGE_GROUP_ORDER) {
    out[group] = tierFeeFor({ pricing, tier, ageGroup: group })?.fee ?? null;
  }
  return out;
}

module.exports = {
  tierFeeFor, tierFeesByGroup, tierIndex, ageGroupIndex, tierNumberOf, AGE_GROUP_ORDER,
};
