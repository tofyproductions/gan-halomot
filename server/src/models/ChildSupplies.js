const mongoose = require('mongoose');

/**
 * מה חסר לילד — a standing state, not a daily entry.
 *
 * WHY NOT THE DAILY BOARD. The תינוקייה board already has a `missing` field
 * and it is the wrong shape for this twice over. It exists only for the infant
 * rooms, so a three-year-old who is out of nappies has nowhere to be recorded;
 * and it belongs to ONE DAY, so "the wipes ran out" is a fact about Tuesday
 * that stops being true on Wednesday while the wipes are still missing.
 *
 * What the gan actually needs to say is "this is outstanding until somebody
 * brings it". So there is one row per child, it carries the open items, and an
 * item leaves when it is brought rather than when the day ends.
 *
 * WHO MARKED IT AND WHEN, per item. A parent who is told "you owe wipes" will
 * ask when that was decided, and "some time in the last month" is not an
 * answer. It also lets the screen show the oldest outstanding item first,
 * which is the one being forgotten.
 */

const missingItemSchema = new mongoose.Schema({
  // The item's stable key from the catalogue (services/supplies.js). Stored
  // rather than the label so renaming "מגבונים" to "מגבונים לחים" later does
  // not orphan every row that mentions it.
  key: { type: String, required: true },
  // What the gan typed, when the item is not in the catalogue. The catalogue
  // covers the list on the door; a gan will always need one more thing.
  label: { type: String, default: '' },
  note: { type: String, default: '' },
  marked_at: { type: Date, default: Date.now },
  marked_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  marked_by_name: { type: String, default: '' },
}, { _id: false });

const childSuppliesSchema = new mongoose.Schema({
  // One row per child, ever. The row is created the first time something is
  // marked and then reused — the history of what was outstanding is not what
  // this is for, and a row per request would make "what is open now" a query
  // instead of a read.
  child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, unique: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null, index: true },

  missing: { type: [missingItemSchema], default: [] },

  // When the last item was cleared. Shown to nobody; it is here so "nothing is
  // missing" can be told apart from "nobody has ever looked".
  last_cleared_at: { type: Date, default: null },
  updated_by_name: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

childSuppliesSchema.index({ branch_id: 1, classroom_id: 1 });

module.exports = mongoose.model('ChildSupplies', childSuppliesSchema);
