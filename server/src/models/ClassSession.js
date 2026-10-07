const mongoose = require('mongoose');

/**
 * ClassSession — a single dated meeting of a ClassProgram. This is the record
 * the occurrence popup drives and the unit payment is counted on.
 *
 * Status lifecycle:
 *   scheduled → occurred      (someone answered "כן, הגיע")
 *            → partial        (came, but did not do the whole thing — half a
 *                              lesson, or not the whole group. Paid at
 *                              `partial_amount` instead of `rate`.)
 *            → no_show        ("לא" without a reschedule)
 *            → postponed      ("לא" + reschedule → a NEW scheduled session is
 *                              created; this one is marked postponed and is
 *                              NEVER counted for payment, so no double pay)
 *
 * Popup answering: the popup fires to BOTH the branch manager and the relevant
 * class lead. Either can answer to record the occurrence, but the manager's
 * confirmation is always required — if only the lead answered,
 * `manager_confirmed` stays false and the manager still sees it pending.
 *
 * Payment: Σ rate over 'occurred', plus Σ partial_amount over 'partial'.
 * Postponed and no-show sessions contribute nothing.
 */
const classSessionSchema = new mongoose.Schema({
  program_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassProgram', required: true, index: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null },
  date: { type: String, required: true },                 // 'YYYY-MM-DD'
  time: { type: String, default: '' },                    // 'HH:mm' (defaults from program)
  rate: { type: Number, default: 0 },                     // ₪ for THIS session
  status: {
    type: String,
    enum: ['scheduled', 'occurred', 'partial', 'no_show', 'postponed'],
    default: 'scheduled',
  },
  /**
   * What a partial session is actually worth.
   *
   * The old spreadsheet carried a row reading "תשלום בחוסר שיעור - אוריאן" with
   * -180 against it, hand-entered, because the sheet counted a DATE and the
   * instructor had come that date and done less than she owed. The number was
   * right and nothing in the sheet explained it — a correction with no record
   * of what it corrected.
   *
   * Most of that disappears on its own now that each classroom is its own
   * session and each is ticked separately: a group that was not done is simply
   * a session that did not occur. What remains is the half-lesson, and this is
   * it — the amount due for THIS session, in place of `rate`.
   *
   * null while the status is anything but 'partial'.
   */
  partial_amount: { type: Number, default: null },
  no_show_reason: { type: String, default: '' },
  // Reschedule links (postpone = new session created, this one marked postponed).
  postponed_to_date: { type: String, default: null },
  postponed_to_session_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSession', default: null },
  postponed_from_session_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSession', default: null },
  // Who answered the "did it arrive?" popup.
  answered_by_manager: { type: Boolean, default: false },
  answered_by_lead: { type: Boolean, default: false },
  // The manager's confirmation is always required, even if the lead answered.
  manager_confirmed: { type: Boolean, default: false },
  responder_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  responded_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

classSessionSchema.index({ branch_id: 1, date: 1 });
classSessionSchema.index({ program_id: 1, date: 1 });

module.exports = mongoose.model('ClassSession', classSessionSchema);
