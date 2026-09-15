const mongoose = require('mongoose');

/**
 * A gan that publishes jobs. NOT necessarily a customer of חלום.
 *
 * The board is open to every gan in Israel, and that is the decision the whole
 * product rests on: a board holding only our own customers' jobs is a board
 * with a handful of ads, and a jobseeker who arrives from a paid campaign and
 * finds nothing near her does not come back. An outside gan gets the ad and an
 * emailed list of applicants; a חלום customer gets the pipeline. The gap is
 * the sales pitch, not a wall.
 *
 * Which also means: anybody can sign up claiming to be a gan, and a jobs board
 * for women is a known target for harvesting personal details. That is what
 * `status` and the manual first-ad review exist for.
 */
const employerSchema = new mongoose.Schema({
  gan_name: { type: String, required: true, trim: true },

  /** Whoever manages the account. The person, not the institution. */
  contact_name:  { type: String, required: true, trim: true },
  contact_phone: { type: String, required: true, trim: true, index: true },
  email:         { type: String, required: true, trim: true, lowercase: true, unique: true },

  /**
   * Business identifier — עוסק מורשה, ח.פ. or עמותה number. Not validated
   * against any registry, because no free one exists; it is here because
   * typing a real one is friction a bot will not bother with, and because it
   * gives the manual reviewer something to check.
   */
  business_id: { type: String, trim: true, default: '' },

  password_hash: { type: String, required: true },

  /**
   * pending  — signed up, no ad approved yet. May write ads; they wait.
   * active   — first ad reviewed by a person. Later ads publish immediately.
   * blocked  — refused or removed. Keeps the row so the email cannot re-register.
   */
  status: { type: String, enum: ['pending', 'active', 'blocked'], default: 'pending', index: true },
  status_note: { type: String, default: '' },
  reviewed_at: { type: Date, default: null },

  /**
   * The tie back to חלום, when there is one — this is what unlocks tiers 2
   * and 3. Null for an outside gan. Stored as the tenant slug rather than an
   * id because the two systems have separate databases and a slug is the one
   * identifier that means the same thing on both sides.
   */
  tenant_slug: { type: String, default: null, index: true },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

employerSchema.methods.isCustomer = function isCustomer() {
  return Boolean(this.tenant_slug);
};

/** Tier 1 for everybody; 2 and 3 only reach customers. Enforced on read. */
employerSchema.methods.maxTier = function maxTier() {
  return this.tenant_slug ? 3 : 1;
};

employerSchema.pre('save', function stampUpdated(next) {
  this.updated_at = new Date();
  next();
});

module.exports = employerSchema;
