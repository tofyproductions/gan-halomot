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

  // --- Face recognition ---
  // `child_ids` above stays the single answer to "who is in this photograph",
  // whether a person or the scanner put a name there. What follows is how that
  // answer was reached, which the gallery never needs and a correction always
  // does: a parent saying "that is not my child" about a photograph with five
  // faces in it teaches nothing unless the system can say which face it meant.
  face_scan_status: {
    type: String,
    enum: ['pending', 'done', 'failed', 'skipped'],
    default: 'pending',
    index: true,
  },
  face_scanned_at: { type: Date, default: null },
  // Why a scan failed, kept so a stuck queue can be diagnosed from the data
  // rather than from logs that have already rotated away.
  face_scan_error: { type: String, default: '' },

  faces: {
    type: [{
      bbox: { type: [Number], required: true },          // x1, y1, x2, y2
      det_score: { type: Number, required: true },
      child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', default: null },
      // Cosine similarity to the matched child's best reference. Null when
      // nobody matched — that face goes to the "who is this?" queue.
      confidence: { type: Number, default: null },
      // Who decided. 'system' is the scanner; the others are corrections, and
      // they are never overwritten by a later scan.
      decided_by: {
        type: String,
        enum: ['system', 'staff', 'parent'],
        default: 'system',
      },
    }],
    default: [],
  },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// The two queries this collection exists to answer: a classroom's week, and
// one child's photographs.
photoSchema.index({ classroom_id: 1, source: 1, date: -1 });
photoSchema.index({ child_ids: 1, date: -1 });
// The scan queue: oldest unscanned first, so a backlog drains in the order the
// photographs arrived rather than newest-first, which would strand the tail.
photoSchema.index({ face_scan_status: 1, created_at: 1 });

module.exports = mongoose.model('Photo', photoSchema);
