const mongoose = require('mongoose');

/** A charge description that never gets an invoice (municipal tax, bank fees...) — excluded from the pairing pool. */
const noInvoiceRuleSchema = new mongoose.Schema({
  label: { type: String, required: true },
  pattern: { type: String, required: true },
  note: { type: String, default: '' },
  built_in: { type: Boolean, default: false },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// One row per built-in pattern, even when two instances boot and seed at once.
noInvoiceRuleSchema.index({ pattern: 1 }, { unique: true, partialFilterExpression: { built_in: true } });

module.exports = mongoose.model('NoInvoiceRule', noInvoiceRuleSchema);
