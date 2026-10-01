const mongoose = require('mongoose');

/** A bank-line description that is NOT parent income (interest, refunds, the Emunah transfer...) — excluded from the income pool. */
const incomeRuleSchema = new mongoose.Schema({
  label: { type: String, required: true },
  pattern: { type: String, required: true },
  note: { type: String, default: '' },
  built_in: { type: Boolean, default: false },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// One row per built-in pattern, even when two instances boot and seed at once.
incomeRuleSchema.index({ pattern: 1 }, { unique: true, partialFilterExpression: { built_in: true } });

module.exports = mongoose.model('IncomeRule', incomeRuleSchema);
