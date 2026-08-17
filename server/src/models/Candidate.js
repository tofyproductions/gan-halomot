const mongoose = require('mongoose');

/**
 * Candidate — somebody who asked to work here.
 *
 * They arrive today from a form on the website, which mails גן החלומות and is
 * read by mail-sorter. That is one `source` among several: the form is being
 * rebuilt inside this system, and other boards will follow. So nothing below
 * knows what a mailbox is. A candidate is a person with a phone number who
 * wants a job, and where the message came from is a field.
 *
 * IDENTITY IS THE PHONE. Not the mail-sorter id, and not the name — people
 * apply twice, spell themselves differently, and the same person coming back
 * two months later is the same person, whose history the manager needs on the
 * screen when she picks up the phone. `phone` is normalised to digits and is
 * the unique key; each arrival is appended to `applications`.
 *
 * NOBODY IS DELETED. Three unanswered calls archives a candidate — off the
 * manager's screen entirely, still findable by name or phone. Somebody who
 * missed three calls in four days may simply have been at work, and if they
 * ring back there has to be a record of who they are.
 */

/** One arrival — the same person applying again appends rather than replaces. */
const applicationSchema = new mongoose.Schema({
  at: { type: Date, required: true },
  source: { type: String, default: 'mail_sorter' },
  // The id in the originating system, so the same message is never ingested
  // twice. mail-sorter serves its list with all=1 and never forgets a row.
  source_ref: { type: String, default: '' },
  // What the applicant picked in the form, verbatim: 'הרצליה', 'כפר סבא',
  // 'תל אביב', 'משרד'. Kept beside the resolved branches because the form's
  // list and this system's branches are not the same list and never will be.
  requested_branch: { type: String, default: '' },
  raw_subject: { type: String, default: '' },
  message: { type: String, default: '' },
}, { _id: false });

/** A call that was made. Kept per attempt so the schedule can be reconstructed. */
const attemptSchema = new mongoose.Schema({
  at: { type: Date, required: true },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  outcome: { type: String, enum: ['no_answer'], default: 'no_answer' },
}, { _id: false });

/** Anything that happened, in order, for the manager and for an audit. */
const eventSchema = new mongoose.Schema({
  at: { type: Date, required: true },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  by_name: { type: String, default: '' },
  type: { type: String, required: true },
  note: { type: String, default: '' },
}, { _id: false });

const STATUSES = [
  'new',                 // arrived, nobody has called
  'no_answer',           // called, no answer — comes back on next_action_at
  'interview_scheduled', // called, invited, date set
  'not_relevant',        // called, closed. may still carry a callback date
  'archived',            // three unanswered calls, or aged out. off the screen
];

const candidateSchema = new mongoose.Schema({
  full_name: { type: String, required: true },
  /** Digits only. The identity — see the note at the top. */
  phone: { type: String, required: true, unique: true, index: true },
  /** As written, for display and for dialling. */
  phone_raw: { type: String, default: '' },

  /**
   * The branches whose managers see this candidate.
   *
   * A list, not one id, because the form offers "כפר סבא" and this system has
   * two branches by that name. One manager holds both, so the distinction is
   * ours and not the applicant's — resolving to both and letting whoever
   * manages either one see it is the honest reading of what they chose.
   *
   * EMPTY MEANS THE OFFICE. Someone who picked "מענה כללי" has not chosen a
   * gan, and guessing one for them would route a person to a manager who has
   * no reason to expect them. Accounting and the system admins route these.
   */
  branch_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true }],
  /** The label as chosen, kept for display: 'כפר סבא', 'משרד', … */
  requested_branch: { type: String, default: '' },
  /** True when the form's branch matched nothing — needs a human, not a guess. */
  branch_unmatched: { type: Boolean, default: false },

  status: { type: String, enum: STATUSES, default: 'new', index: true },

  /**
   * When this candidate should be in front of a manager again.
   *
   * One field for three rules that are the same rule: a new candidate is due
   * now; an unanswered call is due in two days and then one; somebody closed as
   * "relevant later" is due on the date the manager chose. The screen asks for
   * everything due, and never has to know which of the three it is looking at.
   */
  next_action_at: { type: Date, default: Date.now, index: true },

  applications: { type: [applicationSchema], default: [] },
  attempts: { type: [attemptSchema], default: [] },
  events: { type: [eventSchema], default: [] },

  interview: {
    at: { type: Date, default: null },
    note: { type: String, default: '' },
    scheduled_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    scheduled_at: { type: Date, default: null },
  },

  /** Why they were closed. Required by the screen, not by the schema. */
  close_reason: { type: String, default: '' },
  /** Worth calling again, and when. Drives next_action_at above. */
  future_relevant: { type: Boolean, default: false },

  /**
   * Files that arrived with the application, once we can tell whose they are.
   *
   * A CV reaches mail-sorter as a SEPARATE item carrying no name and no phone,
   * so attaching one is a matching problem and not a fetch. Until that match is
   * certain this stays empty and the files are listed on their own — a CV shown
   * against the wrong candidate is worse than a CV shown against nobody.
   */
  attachments: [{
    source_ref: { type: String, default: '' },
    filename: { type: String, default: '' },
    _id: false,
  }],

  /**
   * Two years from the last thing that happened, unless a callback is set for
   * later — these are private phone numbers of people who were not hired.
   * Kept as a date rather than computed at read time so a sweep can act on it.
   */
  retain_until: { type: Date, default: null, index: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

candidateSchema.statics.STATUSES = STATUSES;

/** Everything a manager still has to do, oldest first. */
candidateSchema.index({ status: 1, next_action_at: 1 });

module.exports = mongoose.model('Candidate', candidateSchema);
