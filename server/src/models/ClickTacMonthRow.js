const mongoose = require('mongoose');

/** A child's line in a branch's ClickTac monthly report. Re-uploading the same branch+month replaces its rows. */
const clickTacMonthRowSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  month: { type: String, required: true }, // YYYY-MM
  // Digits padded to 9; a passport is kept as is (upper-cased).
  child_id_number: { type: String, required: true },
  child_name: { type: String, default: '' },
  status: { type: String, default: '' },
  charges: { type: Number, default: 0 },
  target: { type: Number, default: 0 },
  paid: { type: Number, default: 0 },
  adjustments: { type: Number, default: 0 },
  collection_status: { type: String, default: '' },
  payment_method: { type: String, default: '' },
  import_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ClickTacImport', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

clickTacMonthRowSchema.index({ branch_id: 1, month: 1, child_id_number: 1 }, { unique: true });

module.exports = mongoose.model('ClickTacMonthRow', clickTacMonthRowSchema);
