const mongoose = require('mongoose');

/**
 * One notification, for one recipient, about one underlying record.
 *
 * Delivery and resolution are deliberately decoupled: this row says WHO
 * still needs telling about WHAT, and stays 'pending' until something that
 * already changes the underlying record (an approval, a status change)
 * explicitly resolves it — never because a push was sent. A row is sent
 * again every hour (see notification.service.js#deliver / the resend job in
 * index.js) for as long as it stays pending, whether or not the recipient
 * ever acted on the last one.
 *
 * Two documents can point at the same (ref_collection, ref_id) — one row per
 * recipient — so that resolving the underlying record can close every
 * recipient's row in one update (see resolveEvents), including a manager who
 * never opened her push at all.
 */
const notificationEventSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: [
      'new_lead', 'new_candidate', 'punch_pending_manager', 'punch_pending_accountant',
      // A תינוקייה asked to move a child up; the branch manager decides,
      // because the room decides the fee.
      'child_move_request',
      // A manager or admin moved a child directly (drag on the dashboard).
      'child_moved',
      // A branch was invited into a joint supply order; its manager adds items.
      'order_shared',
      // The 07:00 punch-issues digest — per branch manager, and the office summary.
      'punch_issues_digest', 'punch_issues_digest_office',
      // Punch follow-up (docs/superpowers/specs/2026-09-27-punch-followup-design.md):
      // the employee's morning push, a manager's reminder, and the decision on her fix.
      'punch_followup_employee', 'punch_followup_reminder', 'punch_followup_decision',
      // "פניות למשרד": a new request (or the employee's reply) for the routed office
      // people, and the office's answer for the employee.
      'contact_request_new', 'contact_request_reply',
      // Finance part 1: the bank-pi agent stopped delivering the gan's account.
      'bank_feed_stale',
      // סידור עבודה (docs/superpowers/specs/2026-10-04-shifts-phase1-design.md):
      // published / changed for the employee, Friday reminder and the office's
      // edit request for the manager, the decision back to the office.
      'shift_published', 'shift_changed', 'shift_close_reminder',
      'shift_edit_request', 'shift_edit_decision',
      // אילוצים (docs/superpowers/specs/2026-10-04-shifts-phase2-constraints-design.md).
      'constraint_decision', 'constraint_cancelled',
      // סניפים אחרים (docs/superpowers/specs/2026-10-04-shifts-phase3-crossbranch-design.md).
      'rate_request', 'rate_request_decision', 'cross_placement_request', 'cross_placement_decision',
      'cross_arrangement', 'shift_attendance_report', 'shift_attendance_report_office',
      'swap_request', 'swap_response', 'swap_offer', 'swap_picked',
    ],
    required: true,
  },
  ref_collection: { type: String, required: true }, // 'Lead' | 'Candidate' | 'Punch' | 'ClassroomMoveRequest' | 'Child' | 'Order'
  ref_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  recipient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  title: { type: String, required: true },
  body: { type: String, required: true },
  url: { type: String, default: '' }, // deep link the client opens on tap

  status: { type: String, enum: ['pending', 'resolved'], default: 'pending' },
  last_sent_at: { type: Date, default: null },
  next_send_at: { type: Date, required: true },
  resolved_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// The resend job's query.
notificationEventSchema.index({ status: 1, next_send_at: 1 });
// resolveEvents' query.
notificationEventSchema.index({ ref_collection: 1, ref_id: 1 });
// createEvent's dedup check (one pending row per type+ref+recipient).
notificationEventSchema.index({ type: 1, ref_id: 1, recipient_id: 1, status: 1 });

module.exports = mongoose.model('NotificationEvent', notificationEventSchema);
