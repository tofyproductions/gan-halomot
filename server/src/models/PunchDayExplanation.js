const mongoose = require('mongoose');

/**
 * An employee's explanation for a scheduled day with no punches, when she did
 * not work and the reason is neither sick nor vacation (those go through
 * EmployeeRequest). The branch manager accepts (the day stops being a
 * problem — and is unpaid) or rejects it (back to the employee's popup).
 */
const punchDayExplanationSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  date: { type: String, required: true },                 // 'YYYY-MM-DD' (Israel-local)
  reason_text: { type: String, default: '' },
  status: { type: String, enum: ['pending_manager', 'accepted', 'rejected'], default: 'pending_manager' },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_at: { type: Date, default: null },
  reject_reason: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

punchDayExplanationSchema.index({ employee_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('PunchDayExplanation', punchDayExplanationSchema);
