// client/src/utils/webPush.js
import { Capacitor } from '@capacitor/core';

/**
 * Browser Web Push — the counterpart to utils/nativePush.js, for the site
 * itself rather than the installed app. Inert (and never even imported by
 * anything that matters) on a native build: Capacitor.isNativePlatform()
 * true means nativePush.js is already handling it through FCM directly.
 */

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function isWebPushSupported() {
  return (
    !Capacitor.isNativePlatform()
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
  );
}

export async function getWebPushSubscriptionState() {
  if (!(await isWebPushSupported())) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub ? 'subscribed' : 'not-subscribed';
}

export async function subscribeWebPush(registerEndpoint) {
  if (!(await isWebPushSupported())) throw new Error('הדפדפן הזה לא תומך בהתראות');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('לא ניתנה הרשאה להתראות');

  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;

  const { data } = await registerEndpoint.get('/push/vapid-public-key');
  if (!data?.publicKey) throw new Error('התראות דפדפן לא מוגדרות בשרת');

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(data.publicKey),
  });
  const json = subscription.toJSON();
  await registerEndpoint.post('/push/register-web', { endpoint: json.endpoint, keys: json.keys });
}

export async function unsubscribeWebPush(registerEndpoint) {
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await registerEndpoint.post('/push/unregister-web', { endpoint }).catch(() => {});
}
