const mongoose = require('mongoose');

/**
 * What an employee received for a month, archived to their file. Created when
 * payslips are sent to employees ("אושר ושולם") — one document per
 * (employee × month). Stores the PDF bytes so the employee's payslip for any
 * month can be re-produced or exported later, independent of the originating
 * audit run (whose PDFs may be pruned).
 *
 * The hours report rides along. It was attached to the same email and then
 * dropped, so "התלושים שלי" could show the payslip and nothing else — an
 * employee who wanted the hours behind the number had to go find the mail.
 * Both documents are what was sent, so both are kept.
 *
 * `data` is optional because a month can have an hours report and no payslip:
 * the hours distribution runs on its own schedule and does not wait for an
 * approved audit.
 *
 * One page (~150-300KB) per document sits well under the 16MB cap.
 */
const savedPayslipSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  israeli_id:  { type: String, default: '' },
  year_month:  { type: String, required: true, index: true }, // 'YYYY-MM'
  branch:      { type: String, default: '' },
  data:        { type: Buffer, default: null },               // one-page payslip PDF
  audit_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'PayslipAuditRecord', default: null },
  page:        { type: Number, default: null },
  sent_to:     { type: String, default: '' },                 // email it was sent to
  sent_at:     { type: Date, default: Date.now },
  sent_by:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // The monthly hours report that went out with (or instead of) the payslip.
  hours_report_data:    { type: Buffer, default: null },
  hours_report_sent_at: { type: Date, default: null },
}, { timestamps: true });

// One archived payslip per employee per month (re-sending upserts/replaces).
savedPayslipSchema.index({ employee_id: 1, year_month: 1 }, { unique: true });

module.exports = mongoose.model('SavedPayslip', savedPayslipSchema);
