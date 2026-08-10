const mongoose = require('mongoose');

/**
 * A טופס 101 that arrived by mail and could NOT be tied to an employee.
 *
 * The alternative to this collection is dropping the file and logging a line,
 * which is the same failure the Cibus import was written against: the form was
 * filed, the employee believes it is handled, and the record says it is
 * missing. Keeping the file means the answer to "I sent it in January" is a
 * two-click assignment rather than asking the person to send it again.
 *
 * Matched forms do NOT land here — they become EmployeeDocuments directly.
 */
const form101InboxSchema = new mongoose.Schema({
  status: { type: String, enum: ['pending', 'assigned', 'discarded'], default: 'pending', index: true },

  file_data: { type: String, required: true },   // base64 (no data: prefix)
  file_name: { type: String, default: '' },
  file_mimetype: { type: String, default: 'application/pdf' },
  // sha256 of the file — the dedupe key shared with EmployeeDocument.mail.hash,
  // so a message re-read on the next scan is not queued twice.
  hash: { type: String, required: true, unique: true },

  mail: {
    from: { type: String, default: '' },
    subject: { type: String, default: '' },
    date: { type: Date, default: null },
    uid: { type: Number, default: null },
  },

  // What the scan read off the form. This is what the review screen shows, and
  // what makes an assignment a confirmation rather than a guess.
  scan: {
    is_form_101: { type: Boolean, default: false },
    employee_name: { type: String, default: '' },
    israeli_id: { type: String, default: '' },
    tax_year: { type: Number, default: null },
    employer_name: { type: String, default: '' },
    signed: { type: Boolean, default: false },
    confidence: { type: String, default: '' },
    notes: { type: String, default: '' },
  },

  // Why it is here rather than attached: no candidate at all, or several.
  reason: { type: String, default: '' },
  // Employees the scan considered but could not choose between — the review
  // screen offers these first.
  candidates: {
    type: [{
      employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
      full_name: String,
      basis: String,
      _id: false,
    }],
    default: [],
  },

  assigned_to: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  assigned_document_id: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeDocument', default: null },
  resolved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolved_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

form101InboxSchema.index({ status: 1, created_at: -1 });

module.exports = mongoose.model('Form101Inbox', form101InboxSchema);
