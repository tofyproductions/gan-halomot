const mongoose = require('mongoose');

/** A remembered bank payer text (normalised) → household. After the first match the next transfer scores 100. */
const incomePayerAliasSchema = new mongoose.Schema({
  payer_key: { type: String, required: true },
  household_key: { type: String, required: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

incomePayerAliasSchema.index({ payer_key: 1 }, { unique: true });

module.exports = mongoose.model('IncomePayerAlias', incomePayerAliasSchema);
