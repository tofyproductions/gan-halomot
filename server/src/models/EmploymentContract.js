const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * הסכם העסקה for one employee.
 *
 * The lifecycle mirrors what actually happens in the office:
 *
 *   draft         — generated from the employee card, not yet sent
 *   pending_admin — a branch manager issued it; a system admin must approve
 *                   the terms BEFORE any link reaches the employee
 *   sent          — a signing link is live; the employee signs on her phone
 *   signed        — she signed; the branch manager counter-signs (a saved
 *                   signature, applied on her one-click confirmation), and the
 *                   full contract goes out to accounting, to the employee's
 *                   file and to the employee herself
 *   approved      — accounting confirmed → the employee is fully set up
 *
 * plus two escapes for the ~80 people already employed without a contract in
 * the system, so introducing this doesn't make every existing employee look
 * non-compliant overnight:
 *
 *   waived   — "התעלם מחוזה עבודה", with a reason and who decided it
 *   uploaded — a contract signed on paper, scanned and attached
 *
 * `html` is frozen the moment it is sent: the employee signs a specific text,
 * and that text must stay reproducible even after the template changes.
 */
const employmentContractSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

  variant: { type: String, enum: ['hourly', 'global'], default: 'hourly' },
  status: {
    type: String,
    enum: ['draft', 'pending_admin', 'sent', 'signed', 'approved', 'waived', 'uploaded'],
    default: 'draft',
    index: true,
  },

  // --- admin gate before sending (branch-manager-issued contracts) --------
  admin_approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  admin_approved_by_name: { type: String, default: '' },
  admin_approved_at: { type: Date, default: null },

  fields: { type: mongoose.Schema.Types.Mixed, default: {} },
  html: { type: String, default: '' },     // frozen at send time

  // --- mobile signing link ------------------------------------------------
  // Same shape as the parent enrollment link: an unguessable token with an
  // expiry, so a forwarded link cannot be signed months later by anyone.
  access_token: { type: String, default: null, index: true },
  token_expires_at: { type: Date, default: null },
  sent_at: { type: Date, default: null },

  signature_data: { type: String, default: null },   // data:image/png;base64,…
  signer_name: { type: String, default: '' },        // typed by the signer
  signer_id_last4: { type: String, default: '' },    // last 4 of ת"ז, entered to unlock
  signed_at: { type: Date, default: null },
  signed_ip: { type: String, default: '' },

  // --- employer counter-signature ----------------------------------------
  // The branch manager's SAVED signature, stamped when she confirms the signed
  // contract. She draws it once (User.signature_image); here it is a copy, so
  // the document stays reproducible even if she later changes her signature.
  employer_signature_data: { type: String, default: null },
  employer_signer_name: { type: String, default: '' },
  employer_signed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  employer_signed_at: { type: Date, default: null },
  /** When the countersigned contract went out (accounting + employee + תיק). */
  distributed_at: { type: Date, default: null },

  // --- accounting confirmation -------------------------------------------
  approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  approved_by_name: { type: String, default: '' },
  approved_at: { type: Date, default: null },

  // --- escapes for pre-existing staff ------------------------------------
  waived_reason: { type: String, default: '' },
  waived_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  waived_by_name: { type: String, default: '' },
  waived_at: { type: Date, default: null },

  uploaded_file: {
    // Where the bytes are. A contract scanned on a phone is routinely larger
    // than the 16MB a MongoDB document can hold, so new uploads go to object
    // storage and this keeps only the key.
    //
    // `data` stays for every contract filed before that changed. Nothing is
    // migrated: those files are small (they had to be) and rewriting historical
    // records to move a working file is risk with no reader asking for it.
    storage_key: { type: String, default: null },
    size_bytes: { type: Number, default: 0 },
    data: { type: String, default: null },      // legacy: base64, no data: prefix
    name: { type: String, default: '' },
    mimetype: { type: String, default: '' },
    uploaded_by_name: { type: String, default: '' },
    uploaded_at: { type: Date, default: null },
  },

  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  created_by_name: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// One live contract per employee. History is kept by never deleting, so the
// index is on the employee + creation order rather than unique on employee.
employmentContractSchema.index({ employee_id: 1, created_at: -1 });

employmentContractSchema.statics.newToken = () => crypto.randomBytes(24).toString('hex');

module.exports = mongoose.model('EmploymentContract', employmentContractSchema);
