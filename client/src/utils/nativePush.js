import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

/**
 * Wire up native push for whichever side is logged in — staff or parent.
 *
 * A no-op everywhere that isn't the installed app: the web client has no
 * service worker on purpose (see index.html), so there is nothing for a
 * browser tab to register. `registerEndpoint` is the axios instance to post
 * the token to — `api` for staff, `parentApi` for the parent portal — each
 * already carries the right bearer token via its own interceptor.
 *
 * Registration happens once per login, not once per app launch: a token is
 * only useful tied to whoever is signed in right now, and there is nothing
 * to register before that.
 */

// The plugin has no "give me the current token" call — only the one-time
// 'registration' event. Kept here so a logout in the same session can hand
// it back (see unregisterNativePush) without asking the OS to register again.
let lastToken = null;

export async function registerNativePush(registerEndpoint) {
  if (!Capacitor.isNativePlatform()) return;

  /**
   * `addListener` itself crosses the native bridge — it is not wired up the
   * instant this line returns. Calling `register()` right after, without
   * awaiting it, was racing the two: on a device that already has
   * permission, the native 'registration' event has fired and been dropped
   * (nothing listening yet) before the listener finished attaching. Both
   * listeners must be confirmed attached before anything can ask for a token.
   */
  await PushNotifications.addListener('registration', (token) => {
    lastToken = token.value;
    registerEndpoint.post('/push/register', {
      fcm_token: token.value,
      platform: Capacitor.getPlatform(),
    }).catch(() => { /* next foreground / relaunch retries via a fresh register() */ });
  });

  await PushNotifications.addListener('registrationError', (err) => {
    console.error('Push registration failed:', err.error);
  });

  const status = await PushNotifications.checkPermissions();
  const result = status.receive === 'prompt'
    ? await PushNotifications.requestPermissions()
    : status;
  if (result.receive !== 'granted') return;
  await PushNotifications.register();
}

/** Logout: hand the token back so a stale session stops receiving pushes. */
export function unregisterNativePush(registerEndpoint) {
  if (!Capacitor.isNativePlatform() || !lastToken) return;
  registerEndpoint.post('/push/unregister', { fcm_token: lastToken }).catch(() => {});
}
