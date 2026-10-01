const mongoose = require('mongoose');

/** A person's answer to "is this the same document?" for a probable pair (port notes §6). Upserted, so minds can change. */
const expenseIdentityDecisionSchema = new mongoose.Schema({
  expense_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ExpenseDocument', required: true },
  icount_expense_id: { type: mongoose.Schema.Types.ObjectId, ref: 'IcountExpense', required: true },
  verdict: { type: String, enum: ['same', 'different'], required: true },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_at: { type: Date, default: Date.now },
});

expenseIdentityDecisionSchema.index({ expense_id: 1, icount_expense_id: 1 }, { unique: true });

module.exports = mongoose.model('ExpenseIdentityDecision', expenseIdentityDecisionSchema);
