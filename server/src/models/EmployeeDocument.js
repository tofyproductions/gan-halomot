const mongoose = require('mongoose');

/**
 * A free-form document the accountant/manager attaches to an employee from the
 * monthly salary table's notes column — a file plus a human label and a detail
 * note for the accountant (רו"ח). Stored as base64 in Mongo, mirroring how
 * Contract / EmployeeRequest certificates are kept.
 */
const employeeDocumentSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  month: { type: String, default: null },        // optional 'YYYY-MM' context
  name: { type: String, required: true },         // label shown in the list
  description: { type: String, default: '' },     // detail for the accountant
  file_data: { type: String, required: true },    // base64 (no data: prefix)
  file_name: { type: String, default: '' },       // original filename
  file_mimetype: { type: String, default: 'application/octet-stream' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // --- What kind of document this is -------------------------------------
  //
  // Everything used to be 'other' with a free-text label, so "does this
  // employee have a טופס 101" was answered by matching /101/ against the
  // label — which reads as missing for anyone whose file happens to be named
  // something else, and as present for a note that merely mentions 101.
  // A form the tax authority requires is not a naming convention.
  doc_type: { type: String, enum: ['form_101', 'other'], default: 'other', index: true },
  // טופס 101 is filed per TAX YEAR (calendar year, refiled every January), so
  // "has one" is always "has one for this year". Null for 'other'.
  tax_year: { type: Number, default: null },

  // --- Where the file came from ------------------------------------------
  source: { type: String, enum: ['upload', 'mail'], default: 'upload' },
  // Set when the employee uploaded it themselves from the portal, rather than
  // a manager attaching it for them.
  self_uploaded: { type: Boolean, default: false },
  // Provenance for a file pulled out of the mailbox, so a wrong attribution is
  // traceable back to the message it came from.
  mail: {
    from: { type: String, default: '' },
    subject: { type: String, default: '' },
    date: { type: Date, default: null },
    uid: { type: Number, default: null },
    // sha256 of the attachment — the dedupe key. The same message re-read on
    // the next scan must not attach the same form twice.
    hash: { type: String, default: null, index: true, sparse: true },
  },
  // How the file was tied to this employee. 'israeli_id' and 'sender_email'
  // are identity matches; 'name' is a guess that happened to be unique, and is
  // worth showing as such in the review screen.
  match_basis: { type: String, enum: ['manual', 'israeli_id', 'sender_email', 'name'], default: 'manual' },
  match_confidence: { type: String, enum: ['high', 'medium', 'low', ''], default: '' },
  // What the scan read off the form, kept so a human can check the machine.
  scan_notes: { type: String, default: '' },
  // Until the accountant marks it seen, the file shows as "ממתין בקבצים" in the
  // salary table's notes column so uploads aren't missed.
  acknowledged: { type: Boolean, default: false },
  acknowledged_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  acknowledged_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

employeeDocumentSchema.index({ employee_id: 1, created_at: -1 });
// "who has a 101 for year X" is asked for the whole roster at once, on every
// employee-list load.
employeeDocumentSchema.index({ doc_type: 1, tax_year: 1, employee_id: 1 });

module.exports = mongoose.model('EmployeeDocument', employeeDocumentSchema);
