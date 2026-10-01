/**
 * "Not parent income" rules — a bank credit whose description contains the
 * pattern (the Emunah transfer, interest, refunds) never enters the
 * Kaplan allocation pool. Same shape as noInvoiceRules.service.
 *
 * Nothing disappears: a matched credit leaves the pool but is still shown
 * with the rule that caught it.
 */
const { IncomeRule } = require('../models');

const EMUNA_LABEL = 'העברה מאמונה — בלשונית אמונה';

// No "זיכוי" rule: the bank writes "זיכוי מ…" on ordinary parent transfers
// (e.g. "זיכוי מדיסקונט מ…"), so it would exempt the very income we match.
const BUILT_IN = [
  { pattern: 'אמונה', label: EMUNA_LABEL, note: 'התחשבנות מול אמונה נעשית בלשונית אמונה' },
  { pattern: 'ריבית', label: 'ריבית', note: 'לא הכנסת הורים' },
  { pattern: 'החזר', label: 'החזר', note: 'לא הכנסת הורים' },
];

/**
 * Idempotent: creates each missing built-in row by its pattern. Called once at
 * server boot (never from a GET). A row someone deactivated stays deactivated.
 */
async function seed() {
  try {
    await IncomeRule.bulkWrite(BUILT_IN.map(({ pattern, label, note }) => ({
      updateOne: {
        filter: { pattern, built_in: true },
        update: { $setOnInsert: { pattern, label, note, built_in: true, is_active: true } },
        upsert: true,
      },
    })), { ordered: false });
  } catch (e) {
    // A second instance seeding at the same moment inserted the row first —
    // the unique index refused ours, and the row exists. Fine.
    const errs = e.writeErrors || (e.code === 11000 ? [e] : null);
    if (!errs || !errs.every(w => (w.code ?? w.err?.code) === 11000)) throw e;
  }
}

/** Active rules, built-ins first, then by creation — first match wins. */
async function activeRules() {
  return IncomeRule.find({ is_active: { $ne: false } }).sort({ built_in: -1, created_at: 1, _id: 1 }).lean();
}

/** First active rule whose pattern the description contains (case-insensitive), else null. */
function match(description, rules) {
  const d = String(description || '').trim().toLowerCase();
  if (!d) return null;
  for (const r of rules || []) {
    if (r.is_active === false) continue;
    const p = String(r.pattern || '').trim().toLowerCase();
    if (p && d.includes(p)) return r;
  }
  return null;
}

module.exports = { seed, match, activeRules, BUILT_IN };
