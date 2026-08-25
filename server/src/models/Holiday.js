const mongoose = require('mongoose');

const holidaySchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  academic_year: { type: String, required: true },
  name: { type: String, required: true },
  start_date: { type: Date, required: true },
  end_date: { type: Date, required: true },
  is_custom: { type: Boolean, default: false },

  /**
   * Closed, or open and finishing early.
   *
   * 'closure'   — the gan does not run. Every weekday in the range draws a
   *               vacation day from the employee's balance.
   * 'short_day' — the gan RUNS and ends early (יום הזיכרון until 12:00, the
   *               staff day until 15:00). She works, she is paid for the hours
   *               she punched, and NOTHING is drawn from her balance. Marking
   *               such a day as a closure would charge her a vacation day for a
   *               day she actually worked, which is the whole reason this field
   *               exists rather than reusing `is_half_day` — that one means
   *               "half a vacation day", which is a different claim.
   *
   * A short day still belongs here rather than in SpecialDay: parents need it
   * on the calendar with its finishing time, and it is a property of the gan's
   * year, not an employer closure.
   */
  kind: { type: String, enum: ['closure', 'short_day'], default: 'closure', index: true },
  // Half-day support — when `is_half_day` is true the LAST day of the range
  // is short (employees work until `end_time`, default 12:00). Single-day
  // holidays use end_time on that one day. Used by attendance / reports.
  is_half_day: { type: Boolean, default: false },
  end_time: { type: String, default: '' }, // "HH:MM" — is_half_day, or the finishing time of a short_day

  // --- What the calendar shows -------------------------------------------
  // Display only. Nothing here is read by payroll or attendance.
  hebrew: { type: String, default: '' },      // 'כ״ט אלול – ב׳ תשרי'
  note: { type: String, default: '' },        // 'עובדים עד 12:00'
  return_note: { type: String, default: '' }, // 'חזרה לגן: יום שני, 14.9'
  emoji: { type: String, default: '' },
  color: { type: String, default: '' },
  sort_order: { type: Number, default: 0 },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

holidaySchema.index({ branch_id: 1, academic_year: 1 });

module.exports = mongoose.model('Holiday', holidaySchema);
