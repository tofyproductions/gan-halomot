const { PushSubscription, WebPushSubscription } = require('../models');
const env = require('../config/env');

/**
 * Register (or re-register) this device's FCM token.
 *
 * Upserts on the token itself, not on (owner, platform) — a phone that
 * reinstalls the app gets a brand-new token from Firebase, so there is never
 * a stale row to find by owner; the old row for that device is simply
 * unreachable from Firebase's side now and worth deleting later on the first
 * failed send (see fcm.service.js's `unregistered`), not here.
 *
 * `ownerField` is 'user_id' or 'parent_id' — which one is set is how a
 * subscription is scoped to staff vs. the parent portal (see
 * PushSubscription.js). The two routes below never call this with the
 * other's field.
 */
async function register(ownerField, ownerId, req, res) {
  const { fcm_token, platform } = req.body || {};
  if (!fcm_token || !platform) {
    return res.status(400).json({ error: 'fcm_token ו-platform נדרשים' });
  }
  if (!['android', 'ios'].includes(platform)) {
    return res.status(400).json({ error: 'platform לא תקין' });
  }

  await PushSubscription.findOneAndUpdate(
    { fcm_token },
    { fcm_token, platform, user_id: null, parent_id: null, [ownerField]: ownerId },
    { upsert: true }
  );
  res.json({ ok: true });
}

/** A logout, or a token the client is discarding — stop sending to it. */
async function unregister(req, res) {
  const { fcm_token } = req.body || {};
  if (!fcm_token) return res.status(400).json({ error: 'fcm_token נדרש' });
  await PushSubscription.deleteOne({ fcm_token });
  res.json({ ok: true });
}

exports.registerStaff = (req, res) => register('user_id', req.user.id, req, res);
exports.registerParent = (req, res) => register('parent_id', req.parent.pid, req, res);
exports.unregister = unregister;

/** POST /api/push/register-web — upsert this browser's Web Push subscription. */
async function registerWeb(req, res) {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'endpoint ו-keys נדרשים' });
  }
  await WebPushSubscription.findOneAndUpdate(
    { endpoint },
    { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, user_id: req.user.id },
    { upsert: true }
  );
  res.json({ ok: true });
}

/** POST /api/push/unregister-web */
async function unregisterWeb(req, res) {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint נדרש' });
  await WebPushSubscription.deleteOne({ endpoint });
  res.json({ ok: true });
}

/** GET /api/push/vapid-public-key */
function vapidPublicKey(req, res) {
  res.json({ publicKey: env.VAPID_PUBLIC_KEY || null });
}

exports.registerWeb = registerWeb;
exports.unregisterWeb = unregisterWeb;
exports.vapidPublicKey = vapidPublicKey;
