/**
 * Which browser/WebView origins may talk to this API.
 *
 * Was a single `env.FRONTEND_URL` compared with `===`. That is exactly the
 * bug tofy-friends had a live outage over: an installed PWA keeps the origin
 * it was installed from — it does not follow FRONTEND_URL if that ever moves
 * — and a Capacitor native shell isn't `FRONTEND_URL` at all. iOS serves the
 * app from `capacitor://localhost`, Android from `https://localhost`; neither
 * is the deployed website's origin, and a single-origin check rejects both.
 * The browser attaches an `Origin` header to every POST/PATCH/DELETE
 * regardless of same-origin-ness, so the failure mode is silent and partial:
 * reads keep working, every write comes back as a CORS error.
 *
 * The production URL is a permanent entry below, not something read from
 * FRONTEND_URL — the same reasoning: a domain change must never re-lock out
 * whichever origin people already have installed.
 */

/** The gan's own deployed origin. Never remove while anyone has it installed. */
const PRIMARY_ORIGIN = 'https://gan-halomot.onrender.com';

/** Capacitor WebView origins — iOS serves `capacitor://`, Android `https://localhost`. */
const NATIVE_ORIGINS = ['capacitor://localhost', 'https://localhost'];

function buildAllowedOrigins(env) {
  const configured = env.FRONTEND_URL || 'http://localhost:5173';
  const all = [configured, PRIMARY_ORIGIN, ...NATIVE_ORIGINS].map((s) => s.replace(/\/+$/, ''));
  return [...new Set(all)];
}

/** No Origin header (same-origin GETs, curl, server-to-server) is allowed through. */
function isOriginAllowed(origin, allowed) {
  if (!origin) return true;
  return allowed.includes(origin.replace(/\/+$/, ''));
}

module.exports = { PRIMARY_ORIGIN, NATIVE_ORIGINS, buildAllowedOrigins, isOriginAllowed };
