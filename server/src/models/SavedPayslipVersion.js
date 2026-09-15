const mongoose = require('mongoose');

/**
 * A payslip that was superseded by a later one for the same (employee × month).
 *
 * An approved cycle is closed, but a single correction for a single person is
 * still allowed after their payslip was approved and sent. That correction used
 * to overwrite SavedPayslip.data in place, which destroyed the document the
 * employee had actually received — a payroll archive that quietly loses what it
 * mailed is worse than no archive.
 *
 * So nothing is deleted. The active payslip stays exactly where it was, on
 * SavedPayslip under its unique {employee_id, year_month} — deliberately NOT
 * widened to include a version, because dropping and re-creating a unique index
 * on a live payroll collection is a migration, and this feature does not need
 * one. The version being replaced is copied here first, whole, and the active
 * row's `version` counts up.
 *
 * `superseded_at` is when it stopped being the current payslip;
 * `sent_at`/`sent_to` are preserved from the original send, so the question
 * "what did she get, and when, before the correction" has an answer.
 */
const savedPayslipVersionSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  israeli_id:  { type: String, default: '' },
  year_month:  { type: String, required: true, index: true }, // 'YYYY-MM'
  branch:      { type: String, default: '' },

  // Which version of this month's payslip these bytes were.
  version:     { type: Number, required: true },
  data:        { type: Buffer, default: null },

  // Copied from the SavedPayslip row as it stood before the replacement.
  audit_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'PayslipAuditRecord', default: null },
  page:        { type: Number, default: null },
  sent_to:     { type: String, default: '' },
  sent_at:     { type: Date, default: null },
  sent_by:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Whether the EMPLOYEE had this version, or only her manager. A version she
  // never received is kept for the record but is not a payslip that "was
  // replaced" as far as she is concerned.
  delivered_to_employee: { type: Boolean, default: false },
  manager_sent_to: { type: String, default: '' },
  manager_sent_at: { type: Date, default: null },

  superseded_at: { type: Date, default: Date.now },
  superseded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// The history of one employee's month, oldest version first.
savedPayslipVersionSchema.index({ employee_id: 1, year_month: 1, version: 1 }, { unique: true });

module.exports = mongoose.model('SavedPayslipVersion', savedPayslipVersionSchema);
