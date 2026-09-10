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
    enum: ['new_lead', 'punch_pending_manager', 'punch_pending_accountant'],
    required: true,
  },
  ref_collection: { type: String, required: true }, // 'Lead' | 'Punch'
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
