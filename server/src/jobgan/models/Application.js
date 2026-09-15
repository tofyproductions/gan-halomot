const mongoose = require('mongoose');

/**
 * One person applying to one job. The only route by which a gan ever sees her.
 *
 * THERE IS NO BROWSABLE DATABASE OF CANDIDATES, and that absence is a feature
 * somebody will ask to remove. A ganenet looking for work WHILE EMPLOYED — by
 * another gan, which may well be on this board — will not apply if her current
 * employer could find her name in a list. That fear is correct, it is the
 * first thing anybody job-hunting thinks about, and the supply side is the
 * side we cannot buy. So: a gan sees exactly the people who chose to write to
 * it, and nobody else exists as far as it is concerned.
 */
const applicationSchema = new mongoose.Schema({
  job_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
  seeker_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'Seeker', required: true, index: true },
  employer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employer', required: true, index: true },

  /** Optional note to this gan specifically. */
  message: { type: String, trim: true, default: '', maxlength: 1000 },

  /**
   * new       — waiting for the gan.
   * invited   — "מזמינים לראיון".
   * rejected  — "לא מתאים כרגע".
   * job_closed — the ad closed under it. Not the gan's answer, but an answer:
   *              nobody is left hanging, which is the whole point of having
   *              this value at all.
   * withdrawn — she took it back.
   */
  status: {
    type: String,
    enum: ['new', 'invited', 'rejected', 'job_closed', 'withdrawn'],
    default: 'new',
    index: true,
  },

  /**
   * When the gan first opened it. Recorded because the privacy policy promises
   * her that details are revealed only on opening, and a promise nobody can
   * check is not a promise.
   */
  opened_at: { type: Date, default: null },

  answered_at: { type: Date, default: null },

  /**
   * 14 days from submission. The sweeper answers on the gan's behalf rather
   * than leaving silence — somebody who applied to three jobs and heard
   * nothing from any of them does not come back, and tells her friends. That
   * is exactly the audience being bought with advertising money.
   */
  auto_answer_at: { type: Date, default: null, index: true },
  auto_answered: { type: Boolean, default: false },

  /**
   * Set when she deletes her account. The copy the gan already pulled is
   * beyond our reach — the policy says so plainly — but the gan is shown this
   * so it knows, which is more than any board does today.
   */
  deletion_requested: { type: Boolean, default: false },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

/** One person, one application per job. A second press is not a second row. */
applicationSchema.index({ job_id: 1, seeker_id: 1 }, { unique: true });

/** The gan's inbox: its own applications, newest first. */
applicationSchema.index({ employer_id: 1, status: 1, created_at: -1 });

applicationSchema.pre('save', function stampUpdated(next) {
  this.updated_at = new Date();
  next();
});

module.exports = applicationSchema;
