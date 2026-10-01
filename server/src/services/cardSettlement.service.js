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

  for (const card of cards) {
    const bills = await BankTransaction.aggregate([
      { $match: { account_id: card._id, status: 'completed', processed_date: { $ne: null } } },
      { $group: { _id: '$processed_date', total: { $sum: { $multiply: ['$amount', -1] } } } },
      { $match: { total: { $gt: 0 } } },
    ]);
    const pattern = CARD_PATTERNS.find(p => p.institution === card.institution);

    for (const bill of bills) {
      // Already paid by a linked bank line? A second card-looking debit (a
      // re-taken bounce) must not also be marked internal.
      const linked = await BankTransaction.exists({
        matched_card_account_id: card._id,
        date: { $gte: shiftDay(bill._id, -2), $lte: shiftDay(bill._id, 2) },
      });
      if (linked) continue;
      const candidates = await BankTransaction.find({
        account_id: { $in: bankIds },
        amount: { $lt: 0 },
        date: { $gte: shiftDay(bill._id, -2), $lte: shiftDay(bill._id, 2) },
        matched_card_account_id: null,
        settlement_dismissed: { $ne: true },
      }).lean();
      const hit = candidates.find((c) => {
        const looksLikeCard = pattern?.re.test(c.description) || GENERIC_CARD.test(c.description);
        if (!looksLikeCard) return false;
        return Math.abs(-c.amount - bill.total) <= Math.max(1, bill.total * 0.01);
      });
      if (!hit) continue;
      await BankTransaction.updateOne({ _id: hit._id }, { $set: { matched_card_account_id: card._id, is_internal_transfer: true } });
      matches.push({ transaction_id: hit._id, card_account_id: card._id, date: hit.date, amount: -hit.amount });
    }
  }
  return matches;
}

async function unlinkSettlement(transactionId) {
  await BankTransaction.updateOne(
    { _id: transactionId },
    { $set: { matched_card_account_id: null, is_internal_transfer: false, settlement_dismissed: true } },
  );
}

module.exports = { detectCardSettlements, unlinkSettlement };
