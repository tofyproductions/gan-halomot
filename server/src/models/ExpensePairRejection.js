const mongoose = require('mongoose');

/** "Not this charge" — a suggested document/charge pair the office rejected. */
const expensePairRejectionSchema = new mongoose.Schema({
  document_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ExpenseDocument', required: true },
  transaction_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', required: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

expensePairRejectionSchema.index({ document_id: 1, transaction_id: 1 }, { unique: true });

module.exports = mongoose.model('ExpensePairRejection', expensePairRejectionSchema);
