const mongoose = require('mongoose');

/**
 * A payslip archived to an employee's file. Created when payslips are sent to
 * employees ("אושר ושולם") — one document per (employee × month). Stores the
 * single-page payslip PDF bytes so the employee's payslip for any month can be
 * re-produced or exported later, independent of the originating audit run (whose
 * PDFs may be pruned).
 *
 * One page (~150-300KB) per document sits well under the 16MB cap.
 */
const savedPayslipSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  israeli_id:  { type: String, default: '' },
  year_month:  { type: String, required: true, index: true }, // 'YYYY-MM'
  branch:      { type: String, default: '' },
  data:        { type: Buffer, required: true },              // one-page payslip PDF
  audit_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'PayslipAuditRecord', default: null },
  page:        { type: Number, default: null },
  sent_to:     { type: String, default: '' },                 // email it was sent to
  sent_at:     { type: Date, default: Date.now },
  sent_by:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// One archived payslip per employee per month (re-sending upserts/replaces).
savedPayslipSchema.index({ employee_id: 1, year_month: 1 }, { unique: true });

module.exports = mongoose.model('SavedPayslip', savedPayslipSchema);
