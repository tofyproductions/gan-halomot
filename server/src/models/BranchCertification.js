const mongoose = require('mongoose');
const { CERT_TYPES } = require('../services/compliance');

/**
 * אישור מעון — one paper a branch holds: רישיון הפעלה, אישור חשמלאי, גילוי אש
 * and their siblings. Each row is one issued document with its own expiry;
 * renewing does not overwrite it but archives it and adds the new one, because
 * the inspector who shows up in two years asks for the old certificate too.
 *
 * The file itself is either base64 in the row (the pattern everywhere else in
 * this system) or a link to where it already lives — years of these sit in
 * Drive, and re-uploading history nobody scans again is busywork.
 */
const branchCertificationSchema = new mongoose.Schema({
  // Indexed via the compound below.
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  cert_type: { type: String, enum: Object.keys(CERT_TYPES), required: true },
  // Shown when cert_type is 'other'; optional refinement otherwise
  // ("ביקורת משרד הבריאות" under 'inspection').
  label: { type: String, default: '' },

  issued_at: { type: Date, default: null },
  // null means nobody has entered one yet — surfaced as its own state, never
  // treated as "valid forever".
  expires_at: { type: Date, default: null, index: true },

  file_data: { type: String, default: null },      // base64, no data: prefix
  file_name: { type: String, default: '' },
  file_mimetype: { type: String, default: 'application/octet-stream' },
  external_url: { type: String, default: '' },     // e.g. the Drive link it already has

  notes: { type: String, default: '' },

  // Renewal keeps history: the old row is archived and points forward.
  is_archived: { type: Boolean, default: false, index: true },
  replaced_by: { type: mongoose.Schema.Types.ObjectId, ref: 'BranchCertification', default: null },

  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// The screen's one query: every live certificate of a branch.
branchCertificationSchema.index({ branch_id: 1, is_archived: 1, cert_type: 1 });

branchCertificationSchema.statics.CERT_TYPES = CERT_TYPES;

module.exports = mongoose.model('BranchCertification', branchCertificationSchema);
