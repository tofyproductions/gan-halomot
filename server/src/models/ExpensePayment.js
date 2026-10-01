const mongoose = require('mongoose');

/** A bank charge (fully or partly) paying a document. */
const expensePaymentSchema = new mongoose.Schema({
  document_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ExpenseDocument', required: true },
  transaction_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', required: true },
  amount: { type: Number, required: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

expensePaymentSchema.index({ document_id: 1, transaction_id: 1 }, { unique: true });
expensePaymentSchema.index({ transaction_id: 1 });

module.exports = mongoose.model('ExpensePayment', expensePaymentSchema);
