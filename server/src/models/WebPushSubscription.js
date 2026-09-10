const mongoose = require('mongoose');

/**
 * One browser's Web Push subscription — the counterpart to the existing
 * `PushSubscription` (native FCM), kept as a separate model rather than
 * merged in: different shape (`endpoint`+`keys` vs. `fcm_token`+`platform`),
 * different send call (`web-push` npm vs. fcm.service.js), and merging them
 * would mean touching the already-shipped native push model for a browser
 * feature it has nothing to do with.
 *
 * Always staff (`user_id`) — no parent-portal web push in v1.
 */
const webPushSubscriptionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('WebPushSubscription', webPushSubscriptionSchema);
