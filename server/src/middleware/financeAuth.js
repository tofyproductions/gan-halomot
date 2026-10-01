/**
 * The bank-pi agent's door. Same protocol as tofy-friends (agent/src/http.mjs):
 * a shared key authenticates; an HMAC over `${ts}.${rawBody}` pins the exact
 * body to a five-minute window, so a captured request can be neither replayed
 * nor edited. A GET signs the empty string.
 */
const crypto = require('crypto');
const env = require('../config/env');

const WINDOW_S = 300;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const configuredKey = () => env.FINANCE_INGEST_KEY || process.env.FINANCE_INGEST_KEY;

/** Header-only check: is the caller holding the configured (>=32 char) key? */
function hasFinanceKey(req) {
  const key = configuredKey();
  return !!key && key.length >= 32 && safeEqual(req.get('X-Finance-Key'), key);
}

function financeAuth(req, res, next) {
  const key = configuredKey();
  if (!key || key.length < 32) return res.status(503).json({ error: 'קליטת הבנק לא מוגדרת' });

  if (!safeEqual(req.get('X-Finance-Key'), key)) return res.status(401).json({ error: 'מפתח שגוי' });
  const ts = Number(req.get('X-Finance-Ts'));
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > WINDOW_S) {
    return res.status(401).json({ error: 'חותמת זמן לא בתוקף' });
  }
  // Fail closed: a body-bearing request whose raw bytes were not captured
  // (e.g. a path-case mismatch) must never validate against an empty-body sig.
  if (req.method !== 'GET' && !req.rawBody) return res.status(401).json({ error: 'חתימה שגויה' });
  const raw = req.method === 'GET' ? '' : (req.rawBody ? req.rawBody.toString('utf8') : '');
  const expected = crypto.createHmac('sha256', key).update(`${ts}.${raw}`).digest('hex');
  if (!safeEqual(req.get('X-Finance-Sig'), expected)) return res.status(401).json({ error: 'חתימה שגויה' });
  return next();
}

module.exports = { financeAuth, hasFinanceKey };
