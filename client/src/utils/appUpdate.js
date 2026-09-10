import { Capacitor } from '@capacitor/core';

/**
 * Telling a running app that it is out of date.
 *
 * Two completely different problems wearing one name.
 *
 * ON THE WEB the new build is already on the server the moment a deploy
 * finishes — there is no caching service worker in this app, on purpose (see
 * index.html) — and a reload would pick it up. The trouble is that nobody
 * reloads. A tab left open on a teacher's phone, or an installed home-screen
 * app resumed a week later, runs last Tuesday's bundle indefinitely and
 * nothing on the screen says so. Every build stamps itself and emits that
 * stamp as /version.json beside the bundle; the page fetches the file, compares
 * it to the stamp compiled into itself, and offers a reload when they differ.
 *
 * IN THE STORE APPS there is nothing to reload. An App Store or Play build
 * ships its own copy of the whole front end, so a stale one stays stale until
 * the user updates it — which only they can do. There the honest message is
 * "there is a newer version" and the only useful button opens the store. What
 * counts as newer is typed in by a system_admin when Apple or Google approve a
 * build (GET /api/app-version); until it is filled in, nobody is told
 * anything, because a wrong claim sends every parent to a store page offering
 * them nothing.
 */

/** The stamp compiled into THIS bundle. Defined by vite.config.js. */
// eslint-disable-next-line no-undef
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '';

export const isNative = () => Capacitor.isNativePlatform?.() === true;

/** '2.1.3' vs '2.2' — true when `a` is strictly newer. Missing parts are zero. */
export function isNewer(a, b) {
  const parts = (v) => String(v || '').trim().split('.').map(n => parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * Is a newer WEB build live?
 *
 * `cache: 'no-store'` is the whole trick: without it the browser happily
 * answers this question from the copy it downloaded when the page loaded,
 * which is by definition the stale one.
 *
 * Any failure answers "no". This runs every few minutes on somebody's phone
 * and a flaky connection must never produce a banner telling them to reload.
 */
export async function webUpdateAvailable() {
  if (!BUILD_ID) return false;
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    return typeof data?.build === 'string' && data.build !== '' && data.build !== BUILD_ID;
  } catch {
    return false;
  }
}

/**
 * Is a newer STORE build published? Returns the store link when so.
 *
 * Reads the running app's own version through Capacitor rather than from
 * anything bundled: the number that matters is the one Apple and Google
 * installed, and package.json is not it.
 */
export async function nativeUpdateAvailable() {
  if (!isNative()) return null;
  try {
    const { App } = await import('@capacitor/app');
    const [info, res] = await Promise.all([
      App.getInfo(),
      fetch('/api/app-version', { cache: 'no-store' }),
    ]);
    if (!res.ok) return null;

    const published = await res.json();
    const platform = Capacitor.getPlatform() === 'ios' ? 'ios' : 'android';
    const latest = published?.[platform];
    // Nothing filled in yet — say nothing. Silence is the right answer to "we
    // do not know", and it is the state this lives in between store releases.
    if (!latest?.version) return null;
    if (!isNewer(latest.version, info.version)) return null;

    return { version: latest.version, url: latest.url || '' };
  } catch {
    return null;
  }
}
