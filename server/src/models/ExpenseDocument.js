const mongoose = require('mongoose');

const ref = (model) => ({ type: mongoose.Schema.Types.ObjectId, ref: model, default: null });

/**
 * A supplier document (invoice, receipt, credit note) the office pays against.
 * amount_total includes VAT — the gan is VAT-exempt, so there is no VAT split.
 */
const expenseDocumentSchema = new mongoose.Schema({
  source: { type: String, enum: ['mail_sorter', 'manual', 'icount'], required: true },
  mail_sorter_id: { type: Number, default: undefined },
  file_id: ref('ExpenseFile'),
  attachment_sha256: { type: String, default: '' },
  supplier_id: ref('Supplier'),
  vendor_name: { type: String, default: '' },
  supplier_tax_id: { type: String, default: '' },
  doc_type: { type: String, enum: ['tax_invoice', 'invoice_receipt', 'receipt', 'credit_note', 'other'], default: 'tax_invoice' },
  doc_number: { type: String, default: '' },
  doc_date: { type: String, default: '' }, // YYYY-MM-DD
  amount_total: { type: Number, default: 0 },
  currency: { type: String, default: 'ILS' },
  amount_original: { type: Number, default: null },
  fx_confirmed: { type: Boolean, default() { return (this.currency || 'ILS') === 'ILS'; } },
  branch_id: ref('Branch'),
  is_general: { type: Boolean, default: false },
  order_id: ref('Order'),
  needs_review: { type: Boolean, default: false },
  linked_invoice_id: ref('ExpenseDocument'),
  receipt_disposition: { type: String, enum: ['has_invoice', 'is_document', null], default: null },
  receipt_disposition_at: { type: Date, default: null },
  status: { type: String, enum: ['active', 'void'], default: 'active' },
  created_by: ref('User'),
  confirmed_by: ref('User'),
  confirmed_at: { type: Date, default: null },
  // iCount standing (part 2ב): icount_id is iCount's expense id, set once the doc is there.
  icount_id: { type: String, default: null },
  icount_docnum: { type: String, default: '' },
  icount_filed_at: { type: Date, default: null },
  icount_filed_by: ref('User'),
  icount_gone_at: { type: Date, default: null },
  icount_voided_by_bridge: { type: Boolean, default: false }, // voided because it left iCount; only these come back
  icount_id_released: { type: String, default: null }, // icount_id a person's void let go of (the row gets its own document)
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

expenseDocumentSchema.index({ mail_sorter_id: 1 }, { unique: true, sparse: true });
expenseDocumentSchema.index({ status: 1, doc_date: -1 });
expenseDocumentSchema.index({ supplier_id: 1 });
expenseDocumentSchema.index({ attachment_sha256: 1 });
expenseDocumentSchema.index({ icount_id: 1 }, { unique: true, partialFilterExpression: { icount_id: { $type: 'string' } } });

module.exports = mongoose.model('ExpenseDocument', expenseDocumentSchema);
