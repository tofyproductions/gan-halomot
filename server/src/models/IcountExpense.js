const mongoose = require('mongoose');

/**
 * Read-only copy of one expense recorded in iCount (port notes §5, §12).
 * Written only by icountMirror.service; never edited by people. `icount_id` is
 * iCount's own expense id, the one /expense/update needs later.
 */
const icountExpenseSchema = new mongoose.Schema({
  icount_id: { type: String, required: true },
  supplier_id: { type: String, default: '' },     // iCount's supplier id
  supplier_name: { type: String, default: '' },
  supplier_tax_id: { type: String, default: '' },
  doc_number: { type: String, default: '' },      // the supplier's printed number, kept verbatim
  doc_date: { type: String, required: true },     // YYYY-MM-DD
  amount_total: { type: Number, required: true }, // shekels
  doctype: { type: String, default: '' },         // iCount's expense_doctype (invoice|invrec|receipt|refund|…)
  is_storno: { type: Boolean, default: false },   // cancelled / cancelling doc: mirrored, never a document
  matched_expense_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ExpenseDocument', default: null },
  // 'held': an active document already answers for this row under another icount_id — no document created (bridge).
  match_kind: { type: String, enum: ['same_document', 'probable', 'held', null], default: null },
  match_why: { type: String, default: '' },
  first_seen_at: { type: Date, default: Date.now },
  last_seen_at: { type: Date, default: Date.now },
  gone_at: { type: Date, default: null },         // vanished from iCount; never deleted
});

icountExpenseSchema.index({ icount_id: 1 }, { unique: true });
icountExpenseSchema.index({ doc_date: 1 });
icountExpenseSchema.index({ matched_expense_id: 1 });
icountExpenseSchema.index({ supplier_tax_id: 1, doc_number: 1 });
icountExpenseSchema.index({ supplier_id: 1, gone_at: 1 });

module.exports = mongoose.model('IcountExpense', icountExpenseSchema);
