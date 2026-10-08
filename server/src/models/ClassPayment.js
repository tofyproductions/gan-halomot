const mongoose = require('mongoose');

/**
 * ClassPayment — the accounting state of one provider's month at one branch:
 * was the money actually sent, and where is her invoice.
 *
 * The payment-summary endpoint already says what is OWED (occurred × rate,
 * VAT on top for the registered). What it could not say is whether anybody
 * PAID it — that lived in the accountant's head and in a bank screen. This
 * row is that answer, one per provider per month per branch, written only by
 * accounting hands (system_admin / accountant — see classes.routes).
 *
 * The invoice itself is NOT stored here. It is an ExpenseDocument like every
 * other supplier document, so the whole machinery the office already trusts —
 * bank pairing, the closed tab, iCount filing with its no-undo guards — works
 * on it unchanged. This row only remembers which document is this month's.
 */
const classPaymentSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  month: { type: String, required: true }, // YYYY-MM

  /**
   * One key for both kinds of provider: a registered one (its ObjectId as a
   * string) and the name-only instructor old programs still carry
   * ('name:<שם>') — the same two shapes the payment summary groups by, so a
   * row here always lands on exactly one row there.
   */
  provider_key: { type: String, required: true },
  provider_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassProvider', default: null },
  provider_name: { type: String, default: '' },

  paid: { type: Boolean, default: false },
  paid_at: { type: Date, default: null },
  paid_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  note: { type: String, default: '' },

  // This month's invoice, living in the expenses tab's own collection.
  expense_document_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ExpenseDocument', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

classPaymentSchema.index({ branch_id: 1, month: 1, provider_key: 1 }, { unique: true });

module.exports = mongoose.model('ClassPayment', classPaymentSchema);
