const mongoose = require('mongoose');

/**
 * One device's FCM registration — the native app only, never the browser.
 *
 * There is no web push here the way tofy-friends has one: this gan's client
 * deliberately ships no service worker (see client/index.html), so a browser
 * tab has nothing to receive a push with. A row here always means someone
 * installed the Android or iOS app and it registered a real device token.
 *
 * Exactly one of `user_id` / `parent_id` is set, never both and never
 * neither — staff and parents are different collections with different auth
 * (see ParentAccount.js), and a subscription belongs to exactly one of them.
 * `fcm_token` is unique: a reinstalled app gets a fresh Firebase token, and
 * the old row for that device is simply gone from Firebase's perspective —
 * upserting on the token is what keeps this table from accumulating dead rows
 * for every reinstall.
 */
const pushSubscriptionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  parent_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ParentAccount', default: null },

  fcm_token: { type: String, required: true, unique: true, trim: true },

  // 'android' | 'ios'. Both go through the same FCM sender (Firebase
  // forwards to APNS once an auth key is on file) — this is bookkeeping,
  // not a branch in how a send happens.
  platform: { type: String, enum: ['android', 'ios'], required: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

pushSubscriptionSchema.pre('validate', function ensureExactlyOneOwner(next) {
  const hasUser = !!this.user_id;
  const hasParent = !!this.parent_id;
  if (hasUser === hasParent) {
    return next(new Error('PushSubscription needs exactly one of user_id / parent_id'));
  }
  next();
});

pushSubscriptionSchema.index({ user_id: 1 });
pushSubscriptionSchema.index({ parent_id: 1 });

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
