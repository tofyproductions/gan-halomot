const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

/**
 * Two kinds of account, two kinds of token, one signing key that is nobody
 * else's.
 *
 * `JOBGAN_JWT_SECRET` is deliberately not JWT_SECRET. One key shared across
 * services means a token minted here verifies there — and a jobseeker's token
 * would be accepted by the server that runs a gan. The platform layer learned
 * this already and has its own key; this is the same lesson, applied before
 * rather than after.
 *
 * And no default value. A secret with a fallback is a secret that silently
 * isn't one the day the variable goes missing: the process keeps serving,
 * signing with a string that is printed in the source. It refuses to start
 * instead.
 */

const SECRET = process.env.JOBGAN_JWT_SECRET;

function assertSecret() {
  if (!SECRET || SECRET.length < 16) {
    throw new Error('חסר JOBGAN_JWT_SECRET (לפחות 16 תווים). מסרב לעלות.');
  }
}

const hash = (plain) => bcrypt.hash(String(plain), 10);
const verifyPassword = (plain, stored) => bcrypt.compare(String(plain), stored || '');

/** `kind` separates the two audiences inside one key. */
function sign(kind, id, rememberMe = false) {
  return jwt.sign({ kind, id: String(id) }, SECRET, { expiresIn: rememberMe ? '30d' : '12h' });
}

function decode(token) {
  try { return jwt.verify(token, SECRET); } catch { return null; }
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

/**
 * A gate per audience, rather than one gate plus a role check inside every
 * handler. A seeker's token reaching an employer route has to be refused by
 * the router, not by whoever remembered to check.
 */
function requireEmployer(req, res, next) {
  const claims = decode(bearer(req));
  if (!claims || claims.kind !== 'employer') {
    return res.status(401).json({ error: 'נדרשת התחברות כגן.' });
  }
  req.employerId = claims.id;
  next();
}

function requireSeeker(req, res, next) {
  const claims = decode(bearer(req));
  if (!claims || claims.kind !== 'seeker') {
    return res.status(401).json({ error: 'נדרשת התחברות.' });
  }
  req.seekerId = claims.id;
  next();
}

/**
 * Us. The manual review queue and nothing else.
 * A shared secret in a header rather than an account, because there is exactly
 * one operator and an account would be a login screen nobody else may reach.
 */
function requireOperator(req, res, next) {
  const expected = process.env.JOBGAN_ADMIN_SECRET;
  if (!expected || expected.length < 16) {
    return res.status(503).json({ error: 'ניהול אינו מוגדר בשרת.' });
  }
  const got = req.headers['x-jobgan-admin'] || '';
  // Constant-time-ish: compare full length regardless of where it differs.
  if (got.length !== expected.length) return res.status(401).json({ error: 'לא מורשה.' });
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return res.status(401).json({ error: 'לא מורשה.' });
  next();
}

module.exports = {
  assertSecret, hash, verifyPassword, sign, decode,
  requireEmployer, requireSeeker, requireOperator,
};
