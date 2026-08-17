const mongoose = require('mongoose');

/**
 * A parent saying their child will not be in tomorrow.
 *
 * A CLAIM ABOUT THE FUTURE, and that is the whole reason it is its own record
 * rather than a value written onto the day. DailyLog.attendance is what the
 * staff observed — who walked through the door — and it is written by the
 * person who was there. This is what a family said in advance, written by the
 * family. Letting one overwrite the other would mean a parent who says "not
 * coming" and then brings the child anyway has edited the gan's own record of
 * a day it witnessed.
 *
 * So the two sit side by side: the teacher's list shows both, and where they
 * disagree that disagreement is the useful part.
 *
 * ONE ROW PER DAY, not a range. A sick child is Sunday to Tuesday, and every
 * screen that consumes this — the morning list, the monthly count — asks about
 * a single day. Storing a range means every one of those readers has to
 * re-derive the days, and one of them always gets the boundary wrong.
 *
 * NOTHING HERE TOUCHES MONEY. It was the first question asked about this
 * feature and the answer was no: the fee is for a place, not for attendance.
 * The screen says so in words, because a parent reporting a week of illness
 * will otherwise assume it does.
 */
const absenceSchema = new mongoose.Schema({
  child_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true },
  // Denormalised so the teacher's morning list is one query. A child who moves
  // room mid-year keeps the room they were in when the day was reported, which
  // is the room that was expecting them.
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },

  // 'YYYY-MM-DD', local. A day is a calendar day — the same reasoning as
  // DailyLog and DailyMenu, and the same string so the three can be joined.
  date: { type: String, required: true },

  child_name: { type: String, default: '' },

  /**
   * Why, in the family's own words, and optional.
   *
   * Required would produce "חולה" on every row within a week, which carries
   * less than an empty field: an empty one at least does not claim anything.
   * What the gan actually needs is the day, and a reason when there is
   * something worth saying — a stomach bug going round a room is the case this
   * field exists for.
   */
  reason: { type: String, default: '', maxlength: 300 },

  reported_by: { type: mongoose.Schema.Types.ObjectId, ref: 'ParentAccount', default: null },
  reported_by_name: { type: String, default: '' },

  /**
   * Withdrawn rather than deleted.
   *
   * A parent who reports Thursday and then changes their mind has told the gan
   * two things, and the second does not erase the first — a teacher who has
   * already planned around it should see that it moved, not find that it was
   * never there. Cancelled rows are hidden from the morning list and kept in
   * the record.
   */
  cancelled_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// One report per child per day. A parent tapping twice, or two parents of the
// same child reporting the same morning, is one absence — enforced here rather
// than in the controller, because the second tap arrives while the first is
// still being written.
absenceSchema.index({ child_id: 1, date: 1 }, { unique: true });
// The teacher's morning list, and the manager's month.
absenceSchema.index({ classroom_id: 1, date: 1 });
absenceSchema.index({ branch_id: 1, date: 1 });

module.exports = mongoose.model('Absence', absenceSchema);
