const mongoose = require('mongoose');

/**
 * One line on a bank or card statement. Money out is NEGATIVE.
 *
 * `hash` is the row's identity (see services/financeIngest.service#txHash) —
 * a re-sent statement updates, never duplicates. `counterparty` and
 * `transfer_note` are NOT part of the identity: the payee arrives later than
 * the row and must enrich it, not create a twin.
 */
const bankTransactionSchema = new mongoose.Schema({
  account_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', required: true },
  date: { type: String, required: true },            // YYYY-MM-DD, Israel date
  processed_date: { type: String, default: null },   // card: the billing date
  amount: { type: Number, required: true },
  currency: { type: String, default: 'ILS' },
  description: { type: String, default: '' },
  original_description: { type: String, default: '' },
  provider_category: { type: String, default: null },
  status: { type: String, enum: ['pending', 'completed'], default: 'completed' },
  bank_ref: { type: String, default: null },
  dup_seq: { type: Number, default: null },
  hash: { type: String, required: true, unique: true },
  counterparty: { type: String, default: null },
  transfer_note: { type: String, default: null },
  is_internal_transfer: { type: Boolean, default: false },
  is_one_time: { type: Boolean, default: false },
  matched_card_account_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
  // The office said "this is not the card bill" — the next pass must not re-link it.
  settlement_dismissed: { type: Boolean, default: false },
  flagged_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  flagged_at: { type: Date, default: null },
  source: { type: String, enum: ['agent', 'max_xlsx'], default: 'agent' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

bankTransactionSchema.index({ account_id: 1, date: -1 });

module.exports = mongoose.model('BankTransaction', bankTransactionSchema);
