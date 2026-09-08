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

/** The digits in a label, or '' — "דרגה 1" -> "1", "1" -> "1", "דרגה" -> "". */
const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');

/**
 * Which row of the matrix this contract's דרגה is, or -1.
 *
 * THE LABEL FORMAT IS THE BRANCH'S, NOT OURS. A pricing document is typed in by
 * hand and its rows have been seen as "דרגה 1", as "1", and as "דרגה 1 (עד
 * 4,000 ₪)". Comparing the whole string would match none of them, so the match
 * is on the DIGITS in the label — which is the tier number, and the only part
 * of it the state actually names.
 *
 * The fallback is the row's position, and it is deliberately narrow: it applies
 * only when NO row in the matrix has a digit in its label at all (a branch that
 * typed "דרגה ראשונה", or left the labels blank). Then and only then, tier N is
 * the Nth row, one-based, because that is what "דרגה 1" means everywhere else
 * in this system. Using position as a general fallback would silently price a
 * child from the wrong row the moment one label is mistyped.
 */
function tierIndex(tier, tiers = []) {
  const want = digitsOf(tier);
  if (!want) return -1;
  const byLabel = tiers.findIndex(t => digitsOf(t?.label) === want);
  if (byLabel >= 0) return byLabel;
  if (tiers.some(t => digitsOf(t?.label))) return -1;
  const n = Number(want);
  return n >= 1 && n <= tiers.length ? n - 1 : -1;
}

/**
 * Which column of the matrix this child's age group is, or -1.
 *
 * The branch's own wording wins when it happens to match — a branch that typed
 * its columns as תינוק / פעוט / בוגר means exactly those — and otherwise the
 * position is used, because the columns are the same three brackets in the same
 * order whatever they are called. A matrix with a different number of columns
 * than three is a matrix this rule does not understand, and it says so by
 * failing the bounds check below rather than by picking a neighbour.
 */
function ageGroupIndex(ageGroup, ageGroups = []) {
  const group = String(ageGroup || '').trim();
  if (!group) return -1;
  const byName = ageGroups.findIndex(g => String(g || '').trim() === group);
  if (byName >= 0) return byName;
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
  if (!Number(digitsOf(tier))) return null;

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
    tier_label: tiers[row]?.label || `דרגה ${digitsOf(tier)}`,
    tier_index: row,
    age_group: String(ageGroup || '').trim(),
    age_group_index: col,
  };
}

module.exports = { tierFeeFor, tierIndex, ageGroupIndex, AGE_GROUP_ORDER };
