const mongoose = require('mongoose');

/**
 * A request to erase a login and its personal data — the record of the ask,
 * not the erasure itself.
 *
 * Deliberately two steps, not one: `dataDeletion.service.js` does the actual
 * anonymizing, and it runs only when a system_admin completes a request here,
 * never the instant someone asks. A fingerprint template and a bank account
 * are not the kind of thing a stray click, a compromised session, or a
 * spiteful click by someone else on a shared device should be able to erase
 * unattended. The office sees every pending request and the person's name
 * before anything is touched.
 *
 * `user_id` xor `parent_id`, same convention as PushSubscription — staff and
 * parents are different collections with different data to anonymize
 * (see dataDeletion.service.js), and a request belongs to exactly one.
 */
const dataDeletionRequestSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  parent_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ParentAccount', default: null },

  status: { type: String, enum: ['pending', 'completed'], default: 'pending', index: true },
  completed_at: { type: Date, default: null },
  completed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'requested_at', updatedAt: 'updated_at' } });

dataDeletionRequestSchema.pre('validate', function ensureExactlyOneOwner(next) {
  const hasUser = !!this.user_id;
  const hasParent = !!this.parent_id;
  if (hasUser === hasParent) {
    return next(new Error('DataDeletionRequest needs exactly one of user_id / parent_id'));
  }
  next();
});

module.exports = mongoose.model('DataDeletionRequest', dataDeletionRequestSchema);
