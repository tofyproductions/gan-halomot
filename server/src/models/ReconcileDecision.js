const mongoose = require('mongoose');

/**
 * החלטות על ילד בהצלבת תמ"ת↔קליקטאק — what a PERSON decided, kept apart from
 * what either FILE says.
 *
 * The comparison is recomputed from the two uploads on every page load and
 * writes nothing; both uploads overwrite their rows on every re-import. So
 * there was nowhere for "this is an Eritrean child who cannot be in the
 * ministry's list and IS in the gan", or "the ministry's spelling is the
 * right one", or "the phone in ClickTac is wrong, use this one" to live —
 * every such note was lost by the next file.
 *
 * This collection is keyed by the child (branch, year, ת"ז) and by nothing
 * that an upload touches, which is what lets it survive them. Each decision
 * also remembers what the files said at the moment it was made (`snapshot`),
 * so a later file that changes the underlying value reopens the question
 * instead of being silently covered by an old answer.
 */

const resolutionSchema = new mongoose.Schema({
  // The finding this answers — an ISSUES code (name_mismatch, tmt_contact_unknown…).
  code: { type: String, required: true },
  /**
   * 'ok'       — "I looked, it is fine"; the finding is hidden.
   * 'tmt'      — the ministry's value is the right one (name, birth date…).
   * 'clicktac' — ClickTac's value is the right one.
   * 'custom'   — neither; `value` is.
   */
  choice: { type: String, enum: ['ok', 'tmt', 'clicktac', 'custom'], default: 'ok' },
  value: { type: String, default: '' },
  // What the two files said when this was decided. Compared on every read;
  // a difference means the files moved and the answer may no longer hold.
  snapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  note: { type: String, default: '' },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  by_name: { type: String, default: '' },
  at: { type: Date, default: Date.now },
}, { _id: false });

const partyOverrideSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  phone: { type: String, default: '' },
}, { _id: false });

/**
 * A file the office attached to this child — in practice, a signed debt
 * repayment agreement.
 *
 * It sits here rather than in its own collection because it answers the same
 * question the note does — "what do we know about this family's account" —
 * and is keyed by the same (branch, year, ת"ז) that survives every upload.
 * The archive purge already refuses to delete a row anybody has decided
 * something about, so an agreement cannot be swept away by a file import.
 *
 * The BYTES are in object storage; this is the permission and the paperwork.
 * A signed agreement is a legal document and routinely a phone photograph of
 * several megabytes, which is exactly what a MongoDB document cannot hold.
 *
 * TWO FLAGS DO THE WORK.
 *
 * `visible_to_parent` is off by default and always will be. The office
 * attaches internal things here too — a bookkeeper's screenshot, a note from
 * a lawyer — and a file that reaches a family's screen because somebody
 * uploaded it to the wrong row cannot be recalled. Sharing is a deliberate
 * second act.
 *
 * `deleted_at` is a soft delete with a week's grace, and the grace is the
 * point: deleting a signed agreement is destroying evidence of an obligation,
 * usually by accident. The row is hidden immediately, every system_admin gets
 * the file itself by email the moment it happens, and the object survives
 * seven more days so somebody who reads that email on Sunday can still get it
 * back.
 */
const debtDocumentSchema = new mongoose.Schema({
  key: { type: String, required: true },          // object storage key
  file_name: { type: String, default: '' },       // as the office named it
  content_type: { type: String, default: '' },
  bytes: { type: Number, default: 0 },

  /** Shown in the family's own מסמכים tab. Off unless somebody turns it on. */
  visible_to_parent: { type: Boolean, default: false },

  uploaded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  uploaded_by_name: { type: String, default: '' },
  uploaded_at: { type: Date, default: Date.now },

  // Soft delete. `purge_after` is when the bytes actually go.
  deleted_at: { type: Date, default: null },
  deleted_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  deleted_by_name: { type: String, default: '' },
  purge_after: { type: Date, default: null },
});

const reconcileDecisionSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  academic_year: { type: String, required: true, index: true },
  // The ministry's 9-digit shape (normalizeId) — the same key the comparison
  // rows carry as `id_number`.
  id_number: { type: String, required: true },

  /** Free text — whatever the office wants to remember about this child. */
  note: { type: String, default: '' },

  /**
   * The verdict a person overrides.
   *
   * 'private' — the child is in the gan WITHOUT the ministry: not funded by
   * תמ"ת and never going to be on its list (a child without residency, a
   * family that pays in full). The comparison would otherwise call them
   * "נרשם — אין אישור תמ"ת" forever and `apply` would keep dropping them from
   * the intake queue.
   */
  verdict_override: {
    kind: { type: String, enum: ['private', null], default: null },
    reason: { type: String, default: '' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    by_name: { type: String, default: '' },
    at: { type: Date, default: null },
  },

  /** Findings a person closed, one per code (a second answer replaces the first). */
  resolutions: { type: [resolutionSchema], default: [] },

  /** Signed agreements and anything else the office attached to this child. */
  documents: { type: [debtDocumentSchema], default: [] },

  /**
   * The family as the office knows it, where ClickTac is wrong. Shown, exported
   * and promoted in place of the file's values, with a reminder to fix the
   * source; an override equal to what the latest file says is simply done.
   */
  parent_overrides: {
    parent1: { type: partyOverrideSchema, default: null },
    parent2: { type: partyOverrideSchema, default: null },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    by_name: { type: String, default: '' },
    at: { type: Date, default: null },
  },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

reconcileDecisionSchema.index({ branch_id: 1, academic_year: 1, id_number: 1 }, { unique: true });

module.exports = mongoose.model('ReconcileDecision', reconcileDecisionSchema);
