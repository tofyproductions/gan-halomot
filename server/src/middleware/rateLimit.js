const rateLimit = require('express-rate-limit');

/**
 * A brute-force brake on the authentication surface. Identity here is
 * name + ת.ז + password — and ת.ז is low-entropy and widely known — so without
 * a cap an attacker can credential-stuff a known employee at machine speed.
 *
 * Keyed by IP (app.set('trust proxy', 1) makes that the real client). Generous
 * enough that a human mistyping a password never notices, tight enough that
 * automated guessing dies quickly.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי ניסיונות התחברות. נסו שוב בעוד כמה דקות.' },
});

/**
 * The tighter cap for one-time codes (SMS reset, parent activation): a short
 * numeric code is the most guessable secret in the system.
 */
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.' },
});

module.exports = { authLimiter, otpLimiter };
