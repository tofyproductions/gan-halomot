const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

/**
 * The parent portal's own front door, sharing nothing with the staff one.
 *
 * `authMiddleware` accepts any token that verifies against JWT_SECRET and
 * hands it straight through as `req.user`; the role checks that follow are
 * separate middlewares, applied route by route. That is fine while everyone
 * holding a token works here — a route protected by authentication alone is
 * then protected by employment. Give a few hundred parents a token from the
 * same signing key and it stops being true: every such route opens to them,
 * and the only thing standing in the way is that somebody remembered to add a
 * role check to each one.
 *
 * So parent tokens are signed with a DIFFERENT key. Not a different claim
 * inside the same token — a different key, so a parent's token fails signature
 * verification on the staff side and a staff token fails it here. The
 * separation then holds by cryptography rather than by review, and it cannot
 * be undone by forgetting a check on a new route.
 *
 * The key is derived from JWT_SECRET rather than configured, so there is no
 * second secret to set, rotate or leak — and rotating JWT_SECRET rotates both.
 * Deriving is not the same as reusing: HMAC is one-way, so holding this key
 * tells you nothing about the one it came from.
 */
const PARENT_SECRET = crypto
  .createHmac('sha256', String(env.JWT_SECRET))
  .update('gan-halomot/parent-portal/v1')
  .digest('hex');

const TOKEN_TTL = '30d';

/**
 * A token for a parent who has finished activating.
 *
 * It carries the account id and nothing about children. Which children a
 * parent may see is resolved per request from the current registrations — a
 * list baked into a thirty-day token would still name a child who left in
 * September.
 */
function signParentToken(account) {
  return jwt.sign(
    { pid: String(account._id), id_number: account.id_number, typ: 'parent' },
    PARENT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

/**
 * A short-lived ticket saying "this phone answered a code just now".
 *
 * It authorises exactly one thing — choosing a password — and expires in ten
 * minutes. Without it, `set-password` would have to trust an id number, which
 * is the account takeover the code exists to prevent.
 */
function signSetupToken(account, purpose) {
  return jwt.sign(
    { pid: String(account._id), typ: 'parent_setup', purpose },
    PARENT_SECRET,
    { expiresIn: '10m' }
  );
}

function verifySetupToken(token, purpose) {
  const decoded = jwt.verify(token, PARENT_SECRET);
  if (decoded.typ !== 'parent_setup') throw new Error('wrong token type');
  if (purpose && decoded.purpose !== purpose) throw new Error('wrong token purpose');
  return decoded;
}

/**
 * Guard every parent route. Attaches `req.parent` — deliberately not
 * `req.user`, so a controller written for staff cannot be pointed at a parent
 * route and quietly work.
 */
function parentAuthMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'נדרשת התחברות' });
  }
  try {
    const decoded = jwt.verify(header.split(' ')[1], PARENT_SECRET);
    if (decoded.typ !== 'parent') {
      return res.status(401).json({ error: 'נדרשת התחברות' });
    }
    req.parent = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'ההתחברות פגה, יש להתחבר מחדש' });
  }
}

module.exports = {
  parentAuthMiddleware,
  signParentToken,
  signSetupToken,
  verifySetupToken,
  PARENT_SECRET,
};
