const mongoose = require('mongoose');

/**
 * A payslip PDF uploaded straight for distribution, with no audit behind it.
 *
 * The audit path is the right one when a whole month is being checked against
 * the salary table. It is the wrong one for the two cases that actually recur:
 * a final file that was already verified elsewhere and only needs sending, and
 * a single page for the one person who was forgotten in the big file. Forcing
 * those through an audit produced a round where everyone else read as
 * "missing" — noise that then had to be approved to become sendable.
 *
 * So the file is parsed, each page is matched to an employee by ת״ז, and the
 * result sits here as a reviewable list until someone presses send. Nothing
 * goes out on upload.
 *
 * The PDF is kept whole rather than pre-split per page: the pages are extracted
 * at send time, exactly as the audit distribution does, so both paths mail
 * bytes that came out of the file the user actually uploaded.
 */
const itemSchema = new mongoose.Schema({
  page: { type: Number, required: true },          // 1-based page in the PDF
  israeli_id: { type: String, default: '' },       // as read off the payslip
  name_on_payslip: { type: String, default: '' },
  year_month: { type: String, default: '' },       // as read off the payslip

  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  employee_name: { type: String, default: '' },
  email: { type: String, default: '' },
  // How the page was tied to an employee. 'manual' means a human picked, which
  // is the only way an unmatched page ever becomes sendable.
  match_basis: { type: String, enum: ['israeli_id', 'name', 'manual', ''], default: '' },

  // pending  — matched, not sent yet
  // no_match — no employee behind the ת״ז/name on the page
  // no_email — matched, but no real inbox to send to
  // sent / error — outcome of a send
  status: { type: String, enum: ['pending', 'no_match', 'no_email', 'sent', 'error'], default: 'pending' },
  error: { type: String, default: '' },
  sent_to: { type: String, default: '' },
  sent_at: { type: Date, default: null },
}, { _id: false });

const directPayslipBatchSchema = new mongoose.Schema({
  // The month everything in this batch is filed under. Read off the payslips,
  // overridable at upload — a page whose month didn't parse would otherwise be
  // archived under nothing.
  month: { type: String, required: true },         // 'YYYY-MM'
  branch: { type: String, default: '' },           // free-text label, for the archive row
  file_name: { type: String, default: '' },
  page_count: { type: Number, default: 0 },
  data: { type: Buffer, required: true },

  items: { type: [itemSchema], default: [] },

  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  created_by_name: { type: String, default: '' },
  last_send_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

directPayslipBatchSchema.index({ month: 1, created_at: -1 });

module.exports = mongoose.model('DirectPayslipBatch', directPayslipBatchSchema);
