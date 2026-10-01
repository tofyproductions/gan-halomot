const mongoose = require('mongoose');

/** One upload of a ClickTac monthly collection report (debt_contract_export) — the audit trail of ClickTacMonthRow. */
const clickTacImportSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  month: { type: String, required: true }, // YYYY-MM
  file_name: { type: String, default: '' },
  rows: { type: Number, default: 0 },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

clickTacImportSchema.index({ branch_id: 1, month: 1, created_at: -1 });

module.exports = mongoose.model('ClickTacImport', clickTacImportSchema);
