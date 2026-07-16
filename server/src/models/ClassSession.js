const mongoose = require('mongoose');

/**
 * ClassSession — a single dated meeting of a ClassProgram. This is the record
 * the occurrence popup drives and the unit payment is counted on.
 *
 * Status lifecycle:
 *   scheduled → occurred      (someone answered "כן, הגיע")
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
 * Payment: total = Σ (sessions where status='occurred') × rate. Postponed and
 * no-show sessions contribute nothing.
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
    enum: ['scheduled', 'occurred', 'no_show', 'postponed'],
    default: 'scheduled',
  },
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
