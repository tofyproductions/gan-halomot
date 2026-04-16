const mongoose = require('mongoose');

const contractSchema = new mongoose.Schema({
  registration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', default: null },
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  type: {
    type: String,
    enum: ['enrollment', 'employment'],
    required: true,
  },
  doc_type: {
    type: String,
    enum: ['employment_contract', 'enrollment_contract', 'form_161', 'final_settlement', 'other'],
    default: 'other',
  },
  file_name: { type: String, required: true },
  file_data: { type: String, required: true }, // base64 encoded PDF
  file_mimetype: { type: String, default: 'application/pdf' },
  status: {
    type: String,
    enum: ['draft', 'sent', 'signed'],
    default: 'draft',
  },
  notes: { type: String, default: null },
  signed_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

contractSchema.index({ registration_id: 1 });
contractSchema.index({ employee_id: 1 });

module.exports = mongoose.model('Contract', contractSchema);
