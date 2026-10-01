const mongoose = require('mongoose');

/** One manual closing decision per document that has no matching bank charge. */
const expenseDocDecisionSchema = new mongoose.Schema({
  document_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ExpenseDocument', required: true, unique: true },
  kind: { type: String, enum: ['closed_anyway', 'paid_outside_bank'], required: true },
  note: { type: String, default: '' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('ExpenseDocDecision', expenseDocDecisionSchema);
