/**
 * The one-time code that stands between a phone number and a parent's account.
 *
 * This is the whole security model of the portal. Day to day a parent signs in
 * with a password or a fingerprint, and neither of those exists until a code
 * sent to the phone WE already have on file has been typed back. Everything
 * else — the contract, the payments, the photographs of a child — sits behind
 * that one exchange.
 *
 * So the code is treated as a secret and not as a convenience:
 *
 *   It is stored hashed. A database dump is then a pile of dead hashes rather
 *   than a pile of live codes.
 *
 *   Wrong guesses are counted and the code dies at the limit. Six digits is a
 *   million possibilities, which is a lot for a person and nothing at all for
 *   a script; the attempt cap is what makes the number mean anything.
 *
 *   Sends are throttled twice over — a minimum gap, and a ceiling per window.
 *   Partly so a bought package cannot be drained by someone leaning on the
 *   button, and partly because an unthrottled sender is a way to make a
 *   stranger's phone ring all night.
 *
 *   It expires in minutes. A code read off a screen an hour later is not a
 *   secret any more.
 *
 * The code is never written to a log or returned in a response. The only place
 * it is ever legible is the SMS itself.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const CODE_LENGTH = 6;
const TTL_MS = 5 * 60 * 1000;          // a code is good for five minutes
const MAX_ATTEMPTS = 5;                // wrong guesses before the code dies
const MIN_GAP_MS = 60 * 1000;          // no resending within a minute
const WINDOW_MS = 15 * 60 * 1000;      // ...and no more than
const MAX_SENDS_PER_WINDOW = 3;        //    three in a quarter of an hour

/**
 * Six digits from a real random source.
 *
 * `Math.random()` is seeded and predictable, which for a value that authorises
 * an account is the difference between a secret and a formality.
 */
function generateCode() {
  const max = 10 ** CODE_LENGTH;
  return String(crypto.randomInt(0, max)).padStart(CODE_LENGTH, '0');
}

/**
 * May this account be sent a code right now?
 *
 * Returns { ok: true } or { ok: false, reason, retryAfterSeconds }. The reason
 * is for the log; what reaches the parent is a wait time, because telling them
 * which rule they hit tells an attacker the same thing.
 */
function canSend(account, now = new Date()) {
  if (account.otp_sent_at) {
    const since = now - new Date(account.otp_sent_at);
    if (since < MIN_GAP_MS) {
      return {
        ok: false,
        reason: 'min_gap',
        retryAfterSeconds: Math.ceil((MIN_GAP_MS - since) / 1000),
      };
    }
  }

  const windowStart = account.otp_window_started_at ? new Date(account.otp_window_started_at) : null;
  const windowLive = windowStart && (now - windowStart) < WINDOW_MS;
  if (windowLive && (account.otp_sends_in_window || 0) >= MAX_SENDS_PER_WINDOW) {
    return {
      ok: false,
      reason: 'window_exhausted',
      retryAfterSeconds: Math.ceil((WINDOW_MS - (now - windowStart)) / 1000),
    };
  }

  return { ok: true };
}

/**
 * Put a fresh code on the account and hand the plaintext back — once — so the
 * caller can text it. Nothing else in the system can read it afterwards.
 *
 * The caller must save the account. It is left unsaved on purpose: the code
 * must not be committed before the SMS has actually gone out, or a provider
 * failure leaves a parent holding a code that was never delivered while the
 * previous, working one has already been overwritten.
 */
function issueCode(account, now = new Date()) {
  const code = generateCode();

  account.otp_hash = bcrypt.hashSync(code, 10);
  account.otp_expires_at = new Date(now.getTime() + TTL_MS);
  account.otp_attempts = 0;

  const windowStart = account.otp_window_started_at ? new Date(account.otp_window_started_at) : null;
  const windowLive = windowStart && (now - windowStart) < WINDOW_MS;
  if (windowLive) {
    account.otp_sends_in_window = (account.otp_sends_in_window || 0) + 1;
  } else {
    account.otp_window_started_at = now;
    account.otp_sends_in_window = 1;
  }
  account.otp_sent_at = now;

  return code;
}

/**
 * Check a code the parent typed.
 *
 * Returns { ok: true } or { ok: false, reason }. On any outcome other than a
 * correct, live code the account is mutated — a wrong guess is counted, and
 * the last allowed wrong guess clears the code entirely — so the caller must
 * save the account whether it succeeded or not.
 *
 * A correct code is consumed here. It authorises exactly one thing.
 */
function verifyCode(account, submitted, now = new Date()) {
  if (!account.otp_hash || !account.otp_expires_at) {
    return { ok: false, reason: 'no_code' };
  }
  if (now > new Date(account.otp_expires_at)) {
    clearCode(account);
    return { ok: false, reason: 'expired' };
  }
  if ((account.otp_attempts || 0) >= MAX_ATTEMPTS) {
    clearCode(account);
    return { ok: false, reason: 'too_many_attempts' };
  }

  const given = String(submitted || '').replace(/\D/g, '');
  if (!given || !bcrypt.compareSync(given, account.otp_hash)) {
    account.otp_attempts = (account.otp_attempts || 0) + 1;
    if (account.otp_attempts >= MAX_ATTEMPTS) clearCode(account);
    return { ok: false, reason: 'wrong' };
  }

  clearCode(account);
  return { ok: true };
}

function clearCode(account) {
  account.otp_hash = null;
  account.otp_expires_at = null;
  account.otp_attempts = 0;
}

module.exports = {
  generateCode,
  canSend,
  issueCode,
  verifyCode,
  clearCode,
  CODE_LENGTH,
  TTL_MS,
  MAX_ATTEMPTS,
  MAX_SENDS_PER_WINDOW,
};
