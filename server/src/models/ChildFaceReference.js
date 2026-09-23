const mongoose = require('mongoose');
const { REFERENCES_PER_CHILD } = require('../services/face/constants');

/**
 * What the system remembers of a child's face — and deliberately the only
 * biometric data it keeps.
 *
 * A photograph is ordinary personal data. An embedding — 512 numbers
 * describing the geometry of a face — is biometric data about a minor, which
 * is a different legal category and the thing worth being careful with. Almost
 * all of them are unnecessary: once a face has been matched and the photograph
 * labelled, the tag is the answer and the embedding has done its job. Keeping
 * every one would build a store of roughly 180,000 templates of children a
 * year; keeping only what matching needs is 4,400.
 *
 * So this collection holds REFERENCES_PER_CHILD faces per child and nothing
 * else. It ROLLS rather than accumulates: a one-year-old stops looking like
 * their September photograph by January, so a new confirmed tag pushes the
 * oldest reference out and the system ages with the child instead of hunting
 * for who they used to be.
 *
 * Deleted the moment a child leaves, and by any deletion request — see
 * dataDeletion.service.js.
 */
const childFaceReferenceSchema = new mongoose.Schema({
  child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, index: true },

  /**
   * The embedding, unit length, stored as plain numbers.
   *
   * Mongo has no float32 array, and the alternative — a base64 Buffer — would
   * be smaller but unreadable to anyone debugging a bad match at two in the
   * morning. 512 doubles is 4KB a row and there are only ever a few thousand
   * rows, so legibility wins.
   */
  embedding: { type: [Number], required: true },

  // Where it came from, so a reference built on a mistake can be traced back
  // and removed rather than merely overwritten.
  source_photo: { type: mongoose.Schema.Types.ObjectId, ref: 'Photo', default: null },
  // 'bootstrap' — the teachers' training week
  // 'staff'     — a teacher tagged it afterwards
  // 'parent'    — a parent tagged their own child AND a teacher confirmed it.
  //               A parent's tag alone never becomes a reference: a parent who
  //               taps the wrong face would teach the system another family's
  //               child, systematically, for both families.
  source: { type: String, enum: ['bootstrap', 'staff', 'parent'], required: true },

  // Detection confidence of the face this came from. A reference built from a
  // barely-seen face drags every later comparison towards noise, so the
  // weakest is the first to be dropped when the set is full.
  det_score: { type: Number, default: 0 },

  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// The only query that matters at scan time: every reference for the handful of
// children who were in the room, newest first.
childFaceReferenceSchema.index({ child_id: 1, created_at: -1 });

/**
 * Keep the set at its ceiling.
 *
 * Drops by age, not by score: an old reference is actively harmful here in a
 * way a mediocre recent one is not, because the child no longer looks like it.
 */
childFaceReferenceSchema.statics.trim = async function trim(childId) {
  const extra = await this.find({ child_id: childId })
    .sort({ created_at: -1 })
    .skip(REFERENCES_PER_CHILD)
    .select('_id')
    .lean();
  if (extra.length) {
    await this.deleteMany({ _id: { $in: extra.map((d) => d._id) } });
  }
  return extra.length;
};

module.exports = mongoose.model('ChildFaceReference', childFaceReferenceSchema);
