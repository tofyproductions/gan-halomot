const mongoose = require('mongoose');

const employeeRequestSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  type: {
    type: String,
    enum: ['vacation', 'sick'],
    required: true,
  },
  from_date: { type: String, required: true }, // YYYY-MM-DD
  to_date: { type: String, default: null },
  reason: { type: String, default: null },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  reviewed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewed_at: { type: Date, default: null },
  medical_file_data: { type: String, default: null }, // base64 for sick certificate
  medical_file_name: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

employeeRequestSchema.index({ user_id: 1, type: 1 });
employeeRequestSchema.index({ branch_id: 1, status: 1 });

module.exports = mongoose.model('EmployeeRequest', employeeRequestSchema);
