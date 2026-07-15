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
  // Until the accountant marks it seen, the file shows as "ממתין בקבצים" in the
  // salary table's notes column so uploads aren't missed.
  acknowledged: { type: Boolean, default: false },
  acknowledged_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  acknowledged_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

employeeDocumentSchema.index({ employee_id: 1, created_at: -1 });

module.exports = mongoose.model('EmployeeDocument', employeeDocumentSchema);
