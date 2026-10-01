/**
 * Mark the bank line that pays a card bill as an internal transfer.
 * Ported from tofy-friends finance.service.detectCardSettlements:
 * per card, sum completed charges by billing date (processed_date); find a
 * bank debit within ±2 days whose text looks like a card issuer and whose
 * amount is within max(1 ₪, 1%) of that sum.
 */
const { BankAccount, BankTransaction } = require('../models');

const CARD_PATTERNS = [
  { institution: 'visaCal', re: /כאל|cal\b|ויזה\s*כאל/i },
  { institution: 'max', re: /\bmax\b|מקס|לאומי\s*קארד/i },
  { institution: 'isracard', re: /ישראכרט|isracard/i },
  { institution: 'amex', re: /אמריקן|amex|american\s*express/i },
];
const GENERIC_CARD = /כרטיסי?\s*אשראי|חיוב\s*כרטיס|אשראי\s*חודשי/i;

const shiftDay = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function detectCardSettlements() {
  const cards = await BankAccount.find({ type: 'card', is_active: true }).lean();
  const banks = await BankAccount.find({ type: 'bank', is_active: true }).select('_id').lean();
  if (!cards.length || !banks.length) return [];
  const bankIds = banks.map(b => b._id);
  const matches = [];
  // The bank names the card on the debit ("מקס הבינלאומי - 7996"). Two cards
  // billed the same day must each take their own line.
  const last4 = (a) => String(a.account_number || a.external_id || '').replace(/\D/g, '').slice(-4);
  const allDigits = cards.map(last4).filter(Boolean);

  for (const card of cards) {
    const bills = await BankTransaction.aggregate([
      { $match: { account_id: card._id, status: 'completed', processed_date: { $ne: null } } },
      { $group: { _id: '$processed_date', total: { $sum: { $multiply: ['$amount', -1] } } } },
      { $match: { total: { $gt: 0 } } },
    ]);
    const pattern = CARD_PATTERNS.find(p => p.institution === card.institution);

    const mine = last4(card);
    const others = allDigits.filter(d => d !== mine);

    for (const bill of bills) {
      // Already paid by a linked bank line? Keyed on THIS bill's date, not a
      // window: Max bills one card on days two apart (8093: 3, 5 and 7 May
      // 2026), and a window would let the first bill swallow the next. It
      // still stops a second card-looking debit (a re-taken bounce) from also
      // being marked internal for the same bill.
      const linked = await BankTransaction.exists({ matched_card_account_id: card._id, matched_bill_date: bill._id });
      if (linked) continue;
      const candidates = await BankTransaction.find({
        account_id: { $in: bankIds },
        amount: { $lt: 0 },
        date: { $gte: shiftDay(bill._id, -2), $lte: shiftDay(bill._id, 2) },
        matched_card_account_id: null,
        settlement_dismissed: { $ne: true },
      }).lean();
      const fits = candidates.filter((c) => {
        const looksLikeCard = pattern?.re.test(c.description) || GENERIC_CARD.test(c.description);
        if (!looksLikeCard) return false;
        // A debit that names another of our cards is that card's, never this one's.
        if (mine && others.some(d => c.description.includes(d)) && !c.description.includes(mine)) return false;
        return Math.abs(-c.amount - bill.total) <= Math.max(1, bill.total * 0.01);
      });
      // Prefer the line that names this card; then the closest amount.
      fits.sort((a, b) => (Number(mine && b.description.includes(mine)) - Number(mine && a.description.includes(mine)))
        || (Math.abs(-a.amount - bill.total) - Math.abs(-b.amount - bill.total)));
      const hit = fits[0];
      if (!hit) continue;
      await BankTransaction.updateOne({ _id: hit._id }, { $set: { matched_card_account_id: card._id, matched_bill_date: bill._id, is_internal_transfer: true } });
      matches.push({ transaction_id: hit._id, card_account_id: card._id, date: hit.date, amount: -hit.amount });
    }
  }
  return matches;
}

async function unlinkSettlement(transactionId) {
  await BankTransaction.updateOne(
    { _id: transactionId },
    { $set: { matched_card_account_id: null, matched_bill_date: null, is_internal_transfer: false, settlement_dismissed: true } },
  );
}

module.exports = { detectCardSettlements, unlinkSettlement };
