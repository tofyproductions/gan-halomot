const mongoose = require('mongoose');

/**
 * One child, approved by משרד התמ"ת for one gan for one year.
 *
 * The ministry's list is the other half of the enrollment answer. ClickTac
 * says who registered with us; this says who the state allowed to. A child
 * needs both, and the reconciliation screen exists to find the ones who have
 * only one.
 *
 * The list is republished through the summer, so this record is not a snapshot
 * of one upload — it accumulates. `presence` remembers when the child first
 * appeared and whether the newest file still contains them, because a name
 * that DISAPPEARS from the ministry's list is the most consequential change
 * there is: the state withdrew an approval and the place is now free.
 */

const tmtApprovalSchema = new mongoose.Schema({
  source: { type: String, default: 'tmt', index: true },
  source_file: { type: String, default: '' },
  imported_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  /**
   * The branch, supplied at upload — never read from the file.
   *
   * The ministry's portal is per-מעון: the operator signs into each gan's own
   * account and downloads that gan's list. The file itself has no branch
   * column, so nothing here could infer it.
   */
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  academic_year: { type: String, required: true, index: true },

  child: {
    first_name: { type: String, default: '' },
    last_name: { type: String, default: '' },
    full_name: { type: String, default: '' },
    // Normalized to nine digits — the ministry pads with a space, ClickTac
    // keeps leading zeros, and this is the key both sides are matched on.
    id_number: { type: String, default: '', index: true },
    birth_date: { type: Date, default: null },
    // Canonical singular (תינוק / פעוט / בוגר), so it compares with ClickTac's.
    age_group: { type: String, default: '' },
    // The ministry's own wording (תינוקות / פעוטות / בוגרים), kept verbatim.
    source_age_group: { type: String, default: '' },
  },

  /**
   * The ministry's contact for the family — a name, a phone and a mail.
   *
   * Not necessarily either parent in ClickTac. When it matches neither, that
   * is a number nobody here has, and it is the number the state will use.
   */
  contact: {
    name: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
  },

  ministry: {
    decision: { type: String, default: '' },        // התקבל / נקלט במעון
    is_approved: { type: Boolean, default: false, index: true },
    absorbed_at: { type: Date, default: null },     // תאריך הקליטה
    // null, not false: a blank cell is "not stated", and the difference
    // matters when the value is being compared against ClickTac's own.
    continuing: { type: Boolean, default: null },
    welfare: { type: Boolean, default: null },
    priority: { type: String, default: '' },
    committee_place: { type: String, default: '' },
  },

  /**
   * Which uploads this child has been in.
   *
   * `is_present` is false when the newest file for this branch and year no
   * longer lists them. The record is kept rather than deleted — a withdrawn
   * approval is a fact about the summer, and the screen has to be able to say
   * "was approved on 12/07, gone on 04/08" rather than simply forgetting.
   */
  presence: {
    is_present: { type: Boolean, default: true, index: true },
    first_seen_at: { type: Date, default: Date.now },
    last_seen_at: { type: Date, default: Date.now },
    missing_since: { type: Date, default: null },
  },

  /**
   * What changed between uploads, oldest first.
   *
   * The list is republished several times through the summer and the operator
   * has to see what moved rather than re-read seventy rows. Only meaningful
   * fields are logged; a reordered column is not a change.
   */
  changes: [{
    at: { type: Date, default: Date.now },
    field: { type: String, default: '' },
    from: { type: String, default: '' },
    to: { type: String, default: '' },
    _id: false,
  }],

  // The row exactly as it came out of the ministry's portal, so a wrong
  // mapping is a re-parse rather than a re-download.
  raw: { type: mongoose.Schema.Types.Mixed, default: {} },
  content_hash: { type: String, required: true, index: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// One row per child per branch per year. A child could in principle be
// approved at two of the network's gans, and that is a finding rather than a
// collision — so the branch is part of the key.
tmtApprovalSchema.index(
  { branch_id: 1, academic_year: 1, 'child.id_number': 1 },
  { unique: true },
);

module.exports = mongoose.model('TmtApproval', tmtApprovalSchema);
