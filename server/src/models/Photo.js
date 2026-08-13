const mongoose = require('mongoose');

/**
 * A photograph, and who may see it.
 *
 * The bytes live in object storage; this row is the permission and the
 * context. Two kinds of photograph exist here and they are NOT the same
 * thing, which is the single most important line in this file.
 *
 * `staff` — taken by the gan, in the gan. The classroom's parents see it,
 * because the gan chose a class gallery: a parent should see what the week
 * looked like, not only the frames their own child happens to be in. Tagging
 * still matters, but for a different job — it is what makes "photos of MY
 * child" a filter rather than a hunt.
 *
 * `parent` — uploaded by a parent, of their own child. Visible to that parent
 * and to the staff, and to NOBODY else, ever. The system cannot know who is in
 * a photograph a parent sends; a birthday picture carries four other children
 * whose families never agreed to anything. Its only purpose is choosing a gift
 * photograph, and that does not require an audience.
 *
 * The rule is enforced by `source` at query time rather than by remembering to
 * filter. A photograph that reaches the wrong family cannot be recalled.
 */
const photoSchema = new mongoose.Schema({
  // The object storage keys. `thumb_key` is what a gallery loads — a grid of
  // twenty full-size photographs is twenty times more traffic than anyone
  // scrolling a phone needs.
  key: { type: String, required: true },
  thumb_key: { type: String, default: null },
  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 },
  bytes: { type: Number, default: 0 },

  source: { type: String, enum: ['staff', 'parent'], required: true, index: true },

  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  // Which room this belongs to. For a staff photo it decides the audience, so
  // it is required in practice even though the schema tolerates its absence
  // for a parent's own upload.
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null, index: true },

  // Who is in it. For a staff photo, set by the staff. For a parent's, exactly
  // one child — their own — because the parent said so and nobody else can see
  // it anyway.
  child_ids: { type: [mongoose.Schema.Types.ObjectId], ref: 'Child', default: [], index: true },

  // The day it belongs to, YYYY-MM-DD, local. Same reasoning as the daily
  // board: a day at the gan is a calendar day, and an instant lets a timezone
  // move an afternoon into the previous one.
  date: { type: String, required: true, index: true },

  caption: { type: String, default: '' },

  // Whoever put it there. A parent upload carries the parent account; a staff
  // upload carries the employee, with the name snapshotted so the gallery still
  // reads correctly after they leave.
  uploaded_by_user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  uploaded_by_parent: { type: mongoose.Schema.Types.ObjectId, ref: 'ParentAccount', default: null },
  uploaded_by_name: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// The two queries this collection exists to answer: a classroom's week, and
// one child's photographs.
photoSchema.index({ classroom_id: 1, source: 1, date: -1 });
photoSchema.index({ child_ids: 1, date: -1 });

module.exports = mongoose.model('Photo', photoSchema);
