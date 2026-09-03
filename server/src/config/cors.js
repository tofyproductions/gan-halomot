const env = require('./env');

/**
 * A validated CORS allowlist instead of `origin: FRONTEND_URL || '*'`.
 *
 * The old fallback turned into `*` with credentials the moment FRONTEND_URL was
 * unset — a broken, fully-open combination — and a single string cannot serve a
 * platform whose customers each have their own subdomain. Here the allowed set
 * is explicit: the configured frontend, any extra origins named in
 * CORS_EXTRA_ORIGINS, localhost in development, and — in platform mode — any
 * subdomain of PLATFORM_DOMAIN. Anything else is refused rather than reflected.
 */
const strip = (s) => String(s || '').trim().replace(/\/+$/, '');

const allowlist = new Set();
if (env.FRONTEND_URL) allowlist.add(strip(env.FRONTEND_URL));
(process.env.CORS_EXTRA_ORIGINS || '')
  .split(',').map(strip).filter(Boolean)
  .forEach((o) => allowlist.add(o));
if (env.NODE_ENV !== 'production') {
  ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000']
    .forEach((o) => allowlist.add(o));
}

const platformDomain = String(process.env.PLATFORM_DOMAIN || '').trim().toLowerCase();

function isAllowed(origin) {
  if (allowlist.has(strip(origin))) return true;
  if (platformDomain) {
    let host;
    try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
    if (host === platformDomain || host.endsWith(`.${platformDomain}`)) return true;
  }
  return false;
}

module.exports = {
  origin(origin, cb) {
    // Same-origin requests and non-browser clients (curl, the Pi agents, health
    // checks) send no Origin header — allow them; they were never a CORS case.
    if (!origin) return cb(null, true);
    return cb(null, isAllowed(origin));
  },
  credentials: true,
};
