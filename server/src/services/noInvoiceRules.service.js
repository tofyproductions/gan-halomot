/**
 * "No invoice needed" rules — a bank charge whose description contains the
 * pattern (salaries, bank fees, taxes...) never gets a supplier invoice.
 * Ported from tofy-friends noInvoiceRules.service (port notes §6).
 *
 * Two invariants carried over:
 *  - nothing disappears: a matched charge leaves the pairing queue but is
 *    still returned with the rule that caught it (expenseCore.chargePool);
 *  - a rule only ever concerns a charge, it never closes a document.
 *
 * Matching is case-insensitive here (tofy: case-sensitive) — Hebrew has no
 * case, and a Latin bank line ("BANK FEE") should not slip past "bank fee".
 */
const { NoInvoiceRule } = require('../models');

const SALARIES = 'משכורות';
const SALARIES_NOTE = 'התלוש הוא המסמך, לא חשבונית ספק';
const FEES = 'עמלות בנק';
const FEES_NOTE = 'הבנק לא מוציא חשבונית לכל עמלה';
const TAXES = 'מיסים ורשויות';
const AUTHORITY_NOTE = 'תשלום לרשות, לא לספק';
const LOANS = 'החזרי הלוואה';
const LOANS_NOTE = 'החזר, לא הוצאה עם חשבונית';

// Port notes §6.2 — the 5 groups, 10 rows.
const BUILT_IN = [
  { pattern: 'משכורת', label: SALARIES, note: SALARIES_NOTE },
  { pattern: 'העברת משכורות', label: SALARIES, note: SALARIES_NOTE },
  { pattern: 'עמלה', label: FEES, note: FEES_NOTE },
  { pattern: 'עמלת העברה', label: FEES, note: FEES_NOTE },
  { pattern: 'מע"מ', label: TAXES, note: AUTHORITY_NOTE },
  { pattern: 'מקדמות מס', label: TAXES, note: AUTHORITY_NOTE },
  { pattern: 'מס הכנסה', label: TAXES, note: AUTHORITY_NOTE },
  { pattern: 'ביטוח לאומי', label: 'ביטוח לאומי', note: AUTHORITY_NOTE },
  { pattern: 'החזר הלוואה', label: LOANS, note: LOANS_NOTE },
  { pattern: 'קרן והצמדה', label: LOANS, note: LOANS_NOTE },
];

/**
 * Idempotent: upserts each built-in row by its pattern. Called once at server
 * boot (never from a GET). A row someone deactivated stays deactivated —
 * only a missing row is created.
 */
async function seed() {
  try {
    await NoInvoiceRule.bulkWrite(BUILT_IN.map(({ pattern, label, note }) => ({
      updateOne: {
        filter: { pattern, built_in: true },
        update: { $setOnInsert: { pattern, label, note, built_in: true, is_active: true } },
        upsert: true,
      },
    })), { ordered: false });
  } catch (e) {
    // A second instance booting at the same moment inserted the same row
    // first — the unique index refused ours, and the row exists. Fine.
    const errs = e.writeErrors || (e.code === 11000 ? [e] : null);
    if (!errs || !errs.every(w => (w.code ?? w.err?.code) === 11000)) throw e;
  }
}

/** Active rules, built-ins first, then by creation — first match wins. */
async function activeRules() {
  return NoInvoiceRule.find({ is_active: { $ne: false } }).sort({ built_in: -1, created_at: 1, _id: 1 }).lean();
}

/** First rule whose pattern the description contains (case-insensitive), else null. */
function matchRule(description, rules) {
  const d = String(description || '').trim().toLowerCase();
  if (!d) return null;
  for (const r of rules || []) {
    if (r.is_active === false) continue;
    const p = String(r.pattern || '').trim().toLowerCase();
    if (p && d.includes(p)) return r;
  }
  return null;
}

module.exports = { seed, matchRule, activeRules, BUILT_IN };
