const mongoose = require('mongoose');

/** "Not paid yet" — the office confirmed a document is genuinely unpaid. */
const expenseUnpaidMarkSchema = new mongoose.Schema({
  document_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ExpenseDocument', required: true, unique: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('ExpenseUnpaidMark', expenseUnpaidMarkSchema);
