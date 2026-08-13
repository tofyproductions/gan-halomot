const mongoose = require('mongoose');

/**
 * What the תינוקייה served on one day, at one branch.
 *
 * The menu is per branch and per day, not per child: one kitchen cooks one
 * meal. It is separate from DailyLog for that reason — storing it on each
 * child's row would be the same sentence written fourteen times, and the
 * fourteenth would eventually disagree with the first.
 *
 * `selections` is a free map of "meal.category" to the dishes chosen, e.g.
 * { "breakfast.חלבון": ["ביצה קשה"], "lunch.ירק": ["גזר", "סלק"] }. The
 * categories are the gan's own and it changes them — breakfast has protein,
 * carbohydrate, vegetable and a fixed item; the four o'clock has a sandwich
 * and a fruit — so a schema that named them would have to be migrated the
 * first time the kitchen reorganised.
 *
 * Always an array, even for one dish. The sheet stored several joined by a
 * pipe, which meant every reader had to know how to split them and one of them
 * always didn't.
 */
const dailyMenuSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  // YYYY-MM-DD, local. Same reasoning as DailyLog: a day is a calendar day.
  date: { type: String, required: true, index: true },

  selections: { type: mongoose.Schema.Types.Mixed, default: {} },

  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updated_by_name: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

dailyMenuSchema.index({ branch_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyMenu', dailyMenuSchema);
