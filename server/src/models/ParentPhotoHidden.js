const mongoose = require('mongoose');

/**
 * "אל תציג לי את זה" — a preference, and deliberately not a correction.
 *
 * A parent presses this for a reason the system must not learn from: the child
 * is crying in the frame, or mid-sneeze, or they simply do not want it. The
 * tag is RIGHT. Treating it as a mistake would teach the recogniser that their
 * child is not their child, and after a dozen of them the family's gallery
 * would quietly stop working.
 *
 * That is why the screen has two buttons and not one. "זה לא הילד שלי" is a
 * correction: it changes the tag for everyone and the system learns. This one
 * changes nothing except what this parent sees.
 *
 * Its own collection rather than an array on ParentAccount: a parent hides a
 * handful of photographs a year, an account document is read on every request,
 * and a growing array inside it would be carried around forever to answer a
 * question only the gallery asks.
 */
const parentPhotoHiddenSchema = new mongoose.Schema({
  parent_id: {
    type: mongoose.Schema.Types.ObjectId, ref: 'ParentAccount', required: true, index: true,
  },
  photo_id: {
    type: mongoose.Schema.Types.ObjectId, ref: 'Photo', required: true, index: true,
  },
  // Which child's feed this was hidden from. A parent with two children in the
  // gan may want a photograph gone from one gallery and not the other.
  child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// Pressing it twice is not an error, it is a double tap on a phone.
parentPhotoHiddenSchema.index({ parent_id: 1, photo_id: 1, child_id: 1 }, { unique: true });

module.exports = mongoose.model('ParentPhotoHidden', parentPhotoHiddenSchema);
