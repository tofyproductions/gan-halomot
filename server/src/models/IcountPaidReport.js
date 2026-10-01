const mongoose = require('mongoose');

/** Records that "paid" was reported to iCount for a document (expense_paid + date only), so it can be undone. One per document. */
const icountPaidReportSchema = new mongoose.Schema({
  document_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ExpenseDocument', required: true },
  icount_id: { type: String, required: true },
  paid_date: { type: String, default: '' }, // YYYY-MM-DD
  reported_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reported_at: { type: Date, default: Date.now },
});

icountPaidReportSchema.index({ document_id: 1 }, { unique: true });

module.exports = mongoose.model('IcountPaidReport', icountPaidReportSchema);
