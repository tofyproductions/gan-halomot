const mongoose = require('mongoose');
const { AREA_IDS, ROLE_IDS, SCOPE_IDS } = require('../constants');

/**
 * Somebody looking for work in a gan.
 *
 * THE FIELD LIST IS DELIBERATELY SHORT. Every question added here costs a
 * percentage of the people who finish signing up, and this is the side that
 * does not pay us and without which there is no product. A gan would rather
 * have somebody who registered in ninety seconds than a perfect form nobody
 * completed — so seven required fields, and everything else optional and shown
 * to the gan as "השלימה 4 מתוך 7".
 */
const seekerSchema = new mongoose.Schema({
  full_name: { type: String, required: true, trim: true },

  /** The identity. The gan is going to telephone her; nothing else is needed. */
  phone: { type: String, required: true, trim: true, unique: true, index: true },

  /** Optional: used for notifications only, never shown before she applies. */
  email: { type: String, trim: true, lowercase: true, default: '' },

  password_hash: { type: String, required: true },

  areas: { type: [{ type: String, enum: AREA_IDS }], default: [] },
  roles: { type: [{ type: String, enum: ROLE_IDS }], default: [] },
  scope: { type: String, enum: SCOPE_IDS, default: 'full' },

  /** When she could start. A date, because "מיידי" ages badly in a row. */
  available_from: { type: Date, default: null },

  /** Three lines about herself. Short on purpose. */
  about: { type: String, trim: true, default: '', maxlength: 600 },

  // ---- optional, and their absence is never a blocker ----
  experience_years: { type: Number, default: null, min: 0 },
  training:  { type: String, trim: true, default: '' },
  references: { type: String, trim: true, default: '' },

  /**
   * ⚠️ THE CERTIFICATE ITSELF IS NEVER STORED. NOT THE FILE, NOT A COPY.
   *
   * Holding a police clearance document for hundreds of women, on a public
   * server, without being an authority of any kind, is a liability there is no
   * reason to take on — and the statutory mechanism runs through the EMPLOYER
   * applying to the police, not through a file passed hand to hand. What is
   * kept is her own statement that she holds one and until when, which saves
   * the gan a telephone call and nothing more.
   *
   * It does not discharge the gan of anything. The gate that matters is the
   * one in the candidate→employee bridge, where the gan states it saw the
   * certificate itself.
   */
  police_cert_declared: { type: Boolean, default: false },
  police_cert_valid_from: { type: Date, default: null },
  police_cert_valid_to:   { type: Date, default: null },

  /** Opt-in, separate from operational mail. Off unless she says otherwise. */
  wants_job_alerts: { type: Boolean, default: false },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
  last_login_at: { type: Date, default: null },

  /** Set when she presses delete. The row goes; this is for the audit only. */
  deleted_at: { type: Date, default: null },
});

/** The seven the gan is shown as a completeness score. */
const PROFILE_FIELDS = [
  'full_name', 'phone', 'areas', 'roles', 'scope', 'available_from', 'about',
];

seekerSchema.methods.completeness = function completeness() {
  let filled = 0;
  for (const f of PROFILE_FIELDS) {
    const v = this[f];
    if (Array.isArray(v) ? v.length > 0 : (v !== null && v !== undefined && v !== '')) filled++;
  }
  return { filled, total: PROFILE_FIELDS.length };
};

seekerSchema.pre('save', function stampUpdated(next) {
  this.updated_at = new Date();
  next();
});

module.exports = seekerSchema;
module.exports.PROFILE_FIELDS = PROFILE_FIELDS;
