const mongoose = require('mongoose');

const contractVersionSchema = new mongoose.Schema({
  registration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', required: true },
  version: { type: Number, required: true },
  contract_pdf_path: { type: String, default: null },
  signature_data: { type: String, default: null },
  agreement_signed: { type: Boolean, default: false },
  // Snapshot of registration fields at the time the contract was active.
  snapshot: {
    child_name: String,
    parent_name: String,
    parent_id_number: String,
    classroom_name: String,
    monthly_fee: Number,
    registration_fee: Number,
    start_date: Date,
    end_date: Date,
    configuration: mongoose.Schema.Types.Mixed,
  },
  reason: { type: String, default: null }, // why archived (e.g. fields changed)
  archived_at: { type: Date, default: Date.now },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

contractVersionSchema.index({ registration_id: 1, archived_at: -1 });

module.exports = mongoose.model('ContractVersion', contractVersionSchema);
