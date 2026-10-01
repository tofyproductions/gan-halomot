const mongoose = require('mongoose');

/**
 * A slice of one bank transaction attributed to one child's billing month.
 * Stored apart from Collection — the collections table is fed by the Sheets
 * sync and the office's receipts and is never written from the bank.
 */
const incomeAllocationSchema = new mongoose.Schema({
  transaction_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', required: true },
  registration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', required: true },
  household_key: { type: String, default: '' },
  academic_year: { type: String, default: '' },
  month_number: { type: Number, required: true },
  amount: { type: Number, required: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

incomeAllocationSchema.index({ transaction_id: 1 });
incomeAllocationSchema.index({ registration_id: 1, academic_year: 1, month_number: 1 });

module.exports = mongoose.model('IncomeAllocation', incomeAllocationSchema);
