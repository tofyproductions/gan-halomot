const mongoose = require('mongoose');

/**
 * An HR letter that was actually issued for an employee — a hearing
 * invitation, a hearing protocol, a dismissal letter or an employment
 * confirmation (services/employeeLetters.js renders them).
 *
 * The rendered `html` is stored, not just the field values: a letter is a
 * legal record of what the employee was handed, and if the template is
 * reworded next year the old letter must still read exactly as it was sent.
 * `fields` is kept alongside so a follow-up letter (invitation → protocol →
 * dismissal) can start from what the previous one already said.
 *
 * The PDF is generated on demand rather than stored — Chromium is memory-tight
 * on this tier and the HTML is the source of truth anyway.
 */
const employeeLetterSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  type: {
    type: String,
    required: true,
    enum: ['hearing_invite', 'termination', 'hearing_protocol', 'employment_confirmation'],
  },
  title: { type: String, default: '' },      // Hebrew label, for the list
  html: { type: String, required: true },     // the letter as issued — immutable
  fields: { type: mongoose.Schema.Types.Mixed, default: {} }, // merge context used

  // Snapshot of the employee facts at issue time. The employee card keeps
  // changing; a letter must be able to say what it was based on.
  snapshot: {
    full_name: { type: String, default: '' },
    israeli_id: { type: String, default: '' },
    position: { type: String, default: '' },
    branch_name: { type: String, default: '' },
    start_date: { type: Date, default: null },
    seniority: { type: String, default: '' },
    notice_days: { type: Number, default: 0 },
  },

  // Who operated the system, and who the letter is SIGNED BY — not always the
  // same person. An admin can issue a letter for a branch that is signed by
  // that branch's manager; the audit trail has to keep both.
  issued_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  issued_by_name: { type: String, default: '' },
  signed_by_name: { type: String, default: '' },
  signed_by_title: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

employeeLetterSchema.index({ employee_id: 1, created_at: -1 });

module.exports = mongoose.model('EmployeeLetter', employeeLetterSchema);
