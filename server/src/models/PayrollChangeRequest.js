const mongoose = require('mongoose');

/**
 * A batch of payroll-table edits staged by a branch manager and submitted to
 * the accountant for approval. Branch managers can't write PayrollMonth
 * directly (read-only) — they stage changes in the UI and send them here.
 *
 * Each `changes` entry is one manual-field edit for one employee in one
 * month. On approval the accountant's controller applies every change to the
 * matching PayrollMonth.manual document (same shape as upsertEntry uses).
 */
const changeItemSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  employee_name: { type: String, default: '' },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  field: { type: String, required: true },       // manual.<field> key, e.g. 'sick_days', 'cibus'
  field_label: { type: String, default: '' },    // Hebrew label for the UI
  current_value: { type: mongoose.Schema.Types.Mixed, default: null },
  requested_value: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

const payrollChangeRequestSchema = new mongoose.Schema({
  month: { type: String, required: true, index: true }, // 'YYYY-MM'
  // Submitting branch manager
  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  requested_by_name: { type: String, default: '' },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  branch_name: { type: String, default: '' },

  note: { type: String, default: '' },           // optional free-text from the manager
  changes: { type: [changeItemSchema], default: [] },

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'partially_approved'],
    default: 'pending',
    index: true,
  },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_by_name: { type: String, default: '' },
  decided_at: { type: Date, default: null },
  decision_note: { type: String, default: '' },
  // Per-change accountant decision when partially approving:
  // index-aligned with `changes`; values: 'approved' | 'rejected' | 'pending'
  change_decisions: { type: [String], default: [] },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

payrollChangeRequestSchema.index({ status: 1, created_at: -1 });
payrollChangeRequestSchema.index({ requested_by: 1, created_at: -1 });

module.exports = mongoose.model('PayrollChangeRequest', payrollChangeRequestSchema);
