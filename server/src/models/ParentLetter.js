const mongoose = require('mongoose');

/**
 * אישור שהופק להורה — אישור שהות, אישור קייטנה. Mirrors EmployeeLetter: the
 * HTML is frozen as issued (the paper a parent handed to מס הכנסה must be
 * reproducible verbatim), the merge fields are kept so a re-issue starts from
 * them, and the PDF is deliberately not stored — it renders from the HTML.
 */
const parentLetterSchema = new mongoose.Schema({
  child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, index: true },
  registration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', default: null },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  letter_type: { type: String, required: true },
  html: { type: String, required: true },
  fields: { type: mongoose.Schema.Types.Mixed, default: {} },
  snapshot: {
    child_name: { type: String, default: '' },
    parent_name: { type: String, default: '' },
    branch_name: { type: String, default: '' },
    academic_year: { type: String, default: '' },
  },
  issued_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  signed_by_name: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

parentLetterSchema.index({ created_at: -1 });

module.exports = mongoose.model('ParentLetter', parentLetterSchema);
