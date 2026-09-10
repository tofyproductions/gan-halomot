const mongoose = require('mongoose');

/**
 * What a class did today — one line, for the whole room.
 *
 * The older rooms had no daily board at all: DailyLog is per child and made of
 * bottles, naps and nappies, which is the infant day and nobody else's. Asking
 * a teacher of twenty four-year-olds to fill one of those in per child would
 * mean it is never filled in.
 *
 * So their day is a sentence, written once, read by every family in the room:
 * "יצאנו לחצר, הכנו עוגיות, קראנו את הסיפור על הפיל". Together with the
 * kitchen's menu — which is already per branch and per day — and the
 * photographs the staff upload, that is the whole of what an older child's
 * parent came here to see.
 *
 * Keyed by room and date, never wiped. The same reasoning as DailyLog: a day
 * at the gan is a calendar day, so the date is a string and no timezone gets
 * to move an afternoon into the evening before it.
 */
const classroomDaySchema = new mongoose.Schema({
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', required: true, index: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

  // YYYY-MM-DD, local.
  date: { type: String, required: true, index: true },

  /** The line itself. Free text — it is a teacher describing a morning. */
  activity: { type: String, default: '' },

  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updated_by_name: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

classroomDaySchema.index({ classroom_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('ClassroomDay', classroomDaySchema);
