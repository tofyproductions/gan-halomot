const mongoose = require('mongoose');

/**
 * One bank account or credit card the gan's money moves through.
 *
 * `external_id` is the identity both feeds agree on: the bank-pi agent sends
 * `beinleumi:••••0463`, the Max xlsx upload builds `max:••••7996` — the same
 * format the agent would build, so a working card scraper later lands on the
 * same account instead of a twin.
 */
const bankAccountSchema = new mongoose.Schema({
  external_id: { type: String, required: true, unique: true },
  institution: { type: String, required: true },
  label: { type: String, required: true },
  account_number: { type: String, default: null },
  type: { type: String, enum: ['bank', 'card'], default: 'bank' },
  currency: { type: String, default: 'ILS' },
  balance: { type: Number, default: null },
  balance_at: { type: Date, default: null },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('BankAccount', bankAccountSchema);
