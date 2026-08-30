const mongoose = require('mongoose');

/**
 * בקשת העלאת שכר קבועה — the manager's half of a raise.
 *
 * Per the contract, the branch manager decides the raise and the office
 * records it. Until now she had no way to say it in the system: a permanent
 * rate change was accountant-only (employment terms panel), so raises arrived
 * as WhatsApp messages and one-off bonuses. This row carries what she decided
 * — the new rate and the date it starts — and the accountant's approval
 * applies it through employmentTerms.applyTermsChange, the dated path, never
 * as a bare card edit that silently re-rates past months.
 */
const rateChangeRequestSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

  effective_date: { type: Date, required: true },
  salary_type: { type: String, enum: ['hourly', 'global'], required: true },
  hourly_rate: { type: Number, default: null },
  global_salary: { type: Number, default: null },
  global_ot_rate: { type: Number, default: null },
  required_hours: { type: Number, default: null },
  reason: { type: String, default: '' },

  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  requested_by_name: { type: String, default: '' },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_by_name: { type: String, default: '' },
  decided_at: { type: Date, default: null },
  decided_note: { type: String, default: '' },
  // Set on approval: the month payroll actually starts paying the new rate.
  applied_effective_month: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

rateChangeRequestSchema.index({ status: 1, created_at: -1 });

module.exports = mongoose.model('RateChangeRequest', rateChangeRequestSchema);
