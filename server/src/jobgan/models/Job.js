const mongoose = require('mongoose');
const { AREA_IDS, ROLE_IDS, SALARY_UNIT_IDS, SCOPE_IDS } = require('../constants');

/**
 * A published position.
 *
 * EVERYTHING THE BOARD FILTERS BY IS STRUCTURED, and free text is only ever
 * additional. "שכר טוב למתאימות" cannot be filtered, cannot be compared, and
 * is the reason people do not answer ads. A gan picks an area, a role, a scope
 * and a salary range from fixed values, or it does not publish.
 *
 * ⚠️ The salary range is required. Beyond being the single biggest reason an ad
 * goes unanswered, Israeli law may require stating it — that is one of the
 * items waiting on a lawyer, and the field is mandatory either way.
 */
const jobSchema = new mongoose.Schema({
  employer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employer', required: true, index: true },

  title: { type: String, required: true, trim: true },

  area:  { type: String, required: true, enum: AREA_IDS, index: true },
  role:  { type: String, required: true, enum: ROLE_IDS, index: true },
  scope: { type: String, required: true, enum: SCOPE_IDS },

  /** City is free text and is NOT filtered on — the area is. It is shown. */
  city: { type: String, trim: true, default: '' },

  salary_min:  { type: Number, required: true, min: 0 },
  salary_max:  { type: Number, required: true, min: 0 },
  salary_unit: { type: String, required: true, enum: SALARY_UNIT_IDS },

  starts_on: { type: Date, required: true },

  /** Additional, never instead of the structured fields above. */
  description: { type: String, trim: true, default: '', maxlength: 4000 },

  /**
   * 1 — free, every gan. 2 and 3 are customers only and are not built yet;
   * the field exists so that switching them on is configuration rather than a
   * migration, and `Employer.maxTier()` is what refuses a value above it.
   */
  tier: { type: Number, enum: [1, 2, 3], default: 1 },

  /**
   * draft     — caught by the wording screen, or saved unfinished. Not public.
   * pending   — waiting for a person, because the gan has no approved ad yet.
   * published — on the board.
   * closed    — expired, filled, or withdrawn. Closing cascades to its
   *             applications, so nobody is left without an answer.
   */
  status: { type: String, enum: ['draft', 'pending', 'published', 'closed'], default: 'pending', index: true },

  /** What the wording screen caught, kept so the gan can be shown it again. */
  flagged_grounds: [{ type: String }],

  published_at: { type: Date, default: null },
  /** 30 days from publication. The sweeper reads this and nothing else. */
  expires_at:   { type: Date, default: null, index: true },
  closed_at:    { type: Date, default: null },
  close_reason: { type: String, enum: ['expired', 'filled', 'withdrawn', 'removed', ''], default: '' },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

/** Ordering is relevance, never money: area and role filter, date sorts. */
jobSchema.index({ status: 1, area: 1, role: 1, published_at: -1 });

jobSchema.pre('save', function stampUpdated(next) {
  this.updated_at = new Date();
  next();
});

jobSchema.methods.isLive = function isLive() {
  return this.status === 'published' && (!this.expires_at || this.expires_at > new Date());
};

module.exports = jobSchema;
