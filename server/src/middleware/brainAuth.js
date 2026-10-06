/**
 * The brain's door (המוח — the master agent that answers business questions).
 *
 * One shared key, `Authorization: Bearer <BRAIN_READ_KEY>`, and the routes it
 * opens are GET-only. Same shape as FINANCE_INGEST_KEY / TASKS_SYNC_KEY:
 *
 *   UNSET (or shorter than 32 chars) MEANS CLOSED — 503, not 401. "Off" and
 *   "wrong key" send a person to two different places, and a short key is not a
 *   weak password, it is an open door.
 *
 *   Compared as sha256 digests through timingSafeEqual, so neither the content
 *   nor the LENGTH of the real key leaks through timing.
 *
 * Read through process.env at request time (not env.js's frozen snapshot) so the
 * key can be rotated on Render with a plain restart and tests can switch it.
 */
const crypto = require('crypto');

const MIN_KEY_LENGTH = 32;

const digest = (s) => crypto.createHash('sha256').update(String(s || '')).digest();

function requireBrainKey(req, res, next) {
  const key = process.env.BRAIN_READ_KEY || '';
  if (!key || key.length < MIN_KEY_LENGTH) return res.status(503).json({ error: 'brain read disabled' });

  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  const presented = m ? m[1] : '';
  if (!crypto.timingSafeEqual(digest(presented), digest(key))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

module.exports = { requireBrainKey };
