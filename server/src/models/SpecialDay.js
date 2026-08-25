const mongoose = require('mongoose');

/**
 * יום מיוחד — a day the gan did not run for a reason that is not a calendar
 * holiday: an end-of-year party, a staff day, a one-off closure.
 *
 * This is NOT the same as a Holiday document, and collapsing the two would be
 * wrong. A Holiday is a closure the employee is expected to absorb — it becomes
 * a vacation day drawn from her balance. A special day is the employer's
 * decision to shut, so the question is not "whose day is it" but "who gets
 * paid", and the answer differs by how the employee is paid:
 *
 *   • A global (תקן) employee simply missed a committed day. Left alone the
 *     month reads it as an unexplained absence and DEDUCTS a daily rate from
 *     her salary. `pay_global` makes the day a recognised closure so nothing is
 *     deducted — she is paid as if she worked it.
 *
 *   • An hourly employee loses nothing from a balance; she just isn't paid,
 *     because she punched no hours. `pay_hourly` credits her the day at her
 *     rate, and neither takes a vacation day nor touches her balance.
 *
 * Both switches are independent and default OFF for hourly, ON for global,
 * because a global's default outcome without this is an active deduction while
 * an hourly employee's is merely nothing.
 */
const specialDaySchema = new mongoose.Schema({
  name: { type: String, required: true },        // 'מסיבת סיום'
  date: { type: String, required: true },         // 'YYYY-MM-DD' (Israel-local)
  // null = every branch. A one-branch event carries that branch's id.
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

  pay_global: { type: Boolean, default: true },
  pay_hourly: { type: Boolean, default: false },
  // Hours to credit an hourly employee for the day. 0 = use her own average
  // working day this month, which is fairer than a flat 8 for part-timers.
  hourly_hours: { type: Number, default: 0 },

  note: { type: String, default: '' },

  // --- What the calendar shows -------------------------------------------
  // Display only, and the same three fields a Holiday carries, so one merged
  // calendar can be built without the reader caring which model a row came from.
  hebrew: { type: String, default: '' },
  return_note: { type: String, default: '' },
  emoji: { type: String, default: '' },
  color: { type: String, default: '' },
  sort_order: { type: Number, default: 0 },
  academic_year: { type: String, default: '' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  created_by_name: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

specialDaySchema.index({ date: 1, branch_id: 1 });

module.exports = mongoose.model('SpecialDay', specialDaySchema);
