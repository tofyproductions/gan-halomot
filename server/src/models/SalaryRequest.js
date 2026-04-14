const mongoose = require('mongoose');

const salaryRequestSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  current_salary: { type: Number, required: true },
  new_salary: { type: Number, required: true },
  reason: { type: String, default: '' },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_at: { type: Date, default: null },
  decided_note: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('SalaryRequest', salaryRequestSchema);
