const mongoose = require('mongoose');

/** "✗ not this one" — a household the office ruled out for a transaction; never proposed again. */
const incomeRejectionSchema = new mongoose.Schema({
  transaction_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', required: true },
  household_key: { type: String, required: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

incomeRejectionSchema.index({ transaction_id: 1, household_key: 1 }, { unique: true });

module.exports = mongoose.model('IncomeRejection', incomeRejectionSchema);
