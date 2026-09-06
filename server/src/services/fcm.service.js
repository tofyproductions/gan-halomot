/**
 * Sending a push notification to the native app, behind one door.
 *
 * Only the native shell (Android/iOS) can ever receive one of these — this
 * gan's web client ships no service worker on purpose (see client/index.html),
 * so a browser tab has nothing to catch a push with. Every row this service
 * sends to comes from someone who installed the app (models/PushSubscription.js).
 *
 * FCM's HTTP v1 API needs a short-lived OAuth access token, not the service
 * account key itself. `google-auth-library` signs that JWT and exchanges it —
 * `firebase-admin` would do the same thing but pulls in Firestore, Storage and
 * Auth to use one HTTP endpoint, so it was left out.
 *
 * A missing or malformed FCM_SERVICE_ACCOUNT never throws: unlike the SMS
 * codes that gate account activation, nothing here is on a path a user is
 * blocked on. A push that never sends is silently absent, the same as before
 * this file existed.
 */

const { JWT } = require('google-auth-library');
const env = require('../config/env');

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let cachedClient = null;
let cachedProjectId = null;

function credentials() {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try {
    return JSON.parse(env.FCM_SERVICE_ACCOUNT);
  } catch {
    console.error('FCM_SERVICE_ACCOUNT is not valid JSON — push disabled');
    return null;
  }
}

function isConfigured() {
  return !!credentials();
}

function client() {
  if (cachedClient) return cachedClient;
  const creds = credentials();
  if (!creds) return null;
  cachedClient = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [FCM_SCOPE],
  });
  cachedProjectId = creds.project_id;
  return cachedClient;
}

/**
 * Send one push to one device token.
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, unregistered: true }`
 * when Firebase confirms the token is dead (the app was uninstalled, or a
 * reinstall issued a new one) — the caller should delete that subscription
 * row so it stops being tried. Any other failure (a dropped connection, a
 * transient 503) comes back as `{ ok: false, unregistered: false }`: worth
 * logging, not worth deleting the row over.
 */
async function sendPush({ token, title, body, data }) {
  const jwt = client();
  if (!jwt) return { ok: false, unregistered: false };

  let accessToken;
  try {
    ({ token: accessToken } = await jwt.getAccessToken());
  } catch (err) {
    console.error('FCM auth failed:', err.message);
    return { ok: false, unregistered: false };
  }

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${cachedProjectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          // Every value must be a string — FCM's data payload has no other type.
          data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
        },
      }),
    }
  );

  if (res.ok) return { ok: true };

  const failure = await res.json().catch(() => ({}));
  const status = failure?.error?.status;
  const unregistered = res.status === 404 || status === 'UNREGISTERED' || status === 'NOT_FOUND';
  if (!unregistered) console.error('FCM send failed:', res.status, failure?.error?.message);
  return { ok: false, unregistered };
}

module.exports = { sendPush, isConfigured };
