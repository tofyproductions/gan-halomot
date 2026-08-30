const mongoose = require('mongoose');
const { COURSE_TYPES } = require('../services/compliance');

/**
 * קורס של עובדת — עזרה ראשונה, התנהלות בטוחה, קורס מטפלות. One row per
 * certificate actually earned (or per registration on its way to one), with
 * the expiry that decides when she is summoned again.
 *
 * The certificate is either base64 in the row or a link to where it already
 * lives — the whole back-catalogue is in Drive, and the requirement is that
 * every תעודה opens in one click, not that every תעודה moves house.
 */
const employeeCourseSchema = new mongoose.Schema({
  // Indexed via the compound below.
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  course_type: { type: String, enum: Object.keys(COURSE_TYPES), required: true },
  label: { type: String, default: '' },            // shown when course_type is 'other'

  completed_at: { type: Date, default: null },
  // מד"א and התנהלות בטוחה expire; קורס מטפלות does not. null on an expiring
  // course type means the date is simply not entered yet — the screen says so.
  expires_at: { type: Date, default: null, index: true },

  file_data: { type: String, default: null },      // base64, no data: prefix
  file_name: { type: String, default: '' },
  file_mimetype: { type: String, default: 'application/octet-stream' },
  external_url: { type: String, default: '' },     // the Drive link the tracking sheet held

  // The human state the sheet was full of — "רשומה לקורס בספטמבר",
  // "עושה רק את המבחן". Free text beside the date, not instead of it.
  status_note: { type: String, default: '' },
  notes: { type: String, default: '' },

  // A renewed course archives the old certificate rather than deleting it.
  is_archived: { type: Boolean, default: false, index: true },

  source: { type: String, enum: ['manual', 'import'], default: 'manual' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// The matrix screen's one query: live courses for a set of employees.
employeeCourseSchema.index({ employee_id: 1, is_archived: 1, course_type: 1 });

employeeCourseSchema.statics.COURSE_TYPES = COURSE_TYPES;

module.exports = mongoose.model('EmployeeCourse', employeeCourseSchema);
