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

/**
 * The public forms a stranger can reach: the parent inquiry, and the hiring
 * application a paid Facebook campaign sends traffic to.
 *
 * Neither is an authentication surface, so the brake is not about guessing a
 * secret. It is about what ONE submit costs us: a database row, a file in the
 * bucket, an email to every branch manager and a push to each of their phones.
 * Unthrottled, a bored person with a loop empties the SMS balance's neighbour
 * — the mail quota — and buries eighty real applicants under ten thousand
 * fake ones on the morning the campaign goes live.
 *
 * Generous per window, because a family and a jobseeker on the same office
 * Wi-Fi share an IP and neither should ever meet this.
 */
const publicFormLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'נשלחו יותר מדי פניות. נסו שוב בעוד כמה דקות.' },
});

module.exports = { authLimiter, otpLimiter, publicFormLimiter };
