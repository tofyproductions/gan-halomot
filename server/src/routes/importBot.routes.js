const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const env = require('../config/env');
const c = require('../controllers/importBot.controller');

const router = express.Router();

/**
 * The import bot's door — a robot posting report files, and nothing else.
 *
 * WHY IT EXISTS. Cibus and ClickTac publish the two reports this system cannot
 * work without, and neither publishes an API: the files can only be taken off
 * their own websites, behind their own login. So something signs in there,
 * downloads, and posts the file here. On Cibus that is worth a day — the site
 * has the month's report on the 1st at 00:01 and the email arrives on the 2nd —
 * and on ClickTac it is the difference between automatic and somebody
 * remembering.
 *
 * WHY IT IS NOT AN ACCOUNT. The obvious move is a user with a password, and it
 * is the wrong one twice over. A login can read, and this caller has no reason
 * to read anything: it delivers files. And a token here expires in 24 hours
 * (30 days with "remember me"), so a robot holding one would spend its life
 * re-authenticating against the same screen a person uses. The Pi agents at the
 * branches solved this years ago with a shared secret and four routes
 * (middleware/agentAuth.js), and the task board with a signed key
 * (routes/sync.routes.js). This is the third of the same kind.
 *
 * WHAT IT CAN DO, exhaustively: post a Cibus report, and post a ClickTac export
 * for a named branch. There is no GET here and there will not be one. A caller
 * that cannot read cannot leak, whatever it is and whoever runs it — and the
 * two handlers answer with counts rather than names for the same reason.
 *
 * UNSET SECRET MEANS CLOSED, exactly as TASKS_SYNC_KEY closes /api/sync. A
 * feature nobody configured answers 503, not 401: "off" and "you guessed
 * wrong" are different facts and the wrong one sends somebody hunting for a
 * password that was never set.
 */

// 10MB, matching the manual upload. The 77-row ClickTac export is 27KB and a
// Cibus month is smaller; anything at this size is not one of these reports.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * Key, timestamp, signature — the same three the task-board sync uses, for the
 * same reasons and with the same window.
 *
 * The signature covers the TIMESTAMP only, not the file. Signing a multipart
 * body would mean capturing the raw bytes before multer parses them, and what
 * it would buy is integrity on a channel that is already TLS. What the
 * timestamp does buy is a five-minute replay window: a captured request cannot
 * be posted again tomorrow to re-import a month.
 *
 * Both comparisons are constant-time. A comparison that returns early on the
 * first wrong byte tells a patient caller how much of the secret it has.
 */
function verifyCaller(req, res) {
  const secret = env.IMPORT_BOT_SECRET || '';
  if (!secret || secret.length < 32) {
    res.status(503).json({
      error: { code: 'NOT_CONFIGURED', message: 'ייבוא אוטומטי לא הוגדר בשרת' },
    });
    return false;
  }

  const key = String(req.headers['x-import-key'] || '');
  const keyBuf = Buffer.from(key);
  const secretBuf = Buffer.from(secret);
  if (keyBuf.length !== secretBuf.length || !crypto.timingSafeEqual(keyBuf, secretBuf)) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'מפתח לא תקין' } });
    return false;
  }

  const ts = Number(req.headers['x-import-ts'] || 0);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) {
    res.status(401).json({ error: { code: 'STALE', message: 'חותמת זמן לא תקינה' } });
    return false;
  }

  const expected = crypto.createHmac('sha256', secret).update(`${ts}.`).digest('hex');
  const sigBuf = Buffer.from(String(req.headers['x-import-sig'] || ''));
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    res.status(401).json({ error: { code: 'BAD_SIGNATURE', message: 'חתימה לא תקינה' } });
    return false;
  }

  return true;
}

function authed(req, res, next) {
  if (!verifyCaller(req, res)) return undefined;
  return next();
}

/**
 * Express 4 does not catch a rejection thrown inside an async handler: the
 * request gets no response and the caller hangs until its own timeout. A bot
 * that hangs retries, and a retry of an import is the one thing worth avoiding
 * here — so a failure is a fast 500 that names itself.
 */
function guard(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * The brake.
 *
 * Not about guessing the key — that is a long secret behind a constant-time
 * compare. It is about what one ACCEPTED request costs: a spreadsheet parsed,
 * every active employee loaded, up to seventy children written, and an email to
 * the office. A bot in a retry loop against this is a self-inflicted outage on
 * the 512MB tier.
 *
 * WHY FORTY AND NOT TWELVE, which is what this was first written as. Two monthly
 * reports sounds like two requests, and it is not: ClickTac publishes TWO
 * exports (registrations and contracts) and the branch is a parameter, so one
 * full refresh is 2 × the number of branches — eight today, and sixteen if each
 * needs a second attempt. A cap set to the number of REPORTS rather than the
 * number of UPLOADS would have throttled the office doing ordinary work, and
 * the caller it throttles is a robot that would simply retry into the wall.
 *
 * Forty leaves room for that and still stops a loop dead, since a loop makes
 * thousands rather than dozens. It is tunable because the figure grows with the
 * branch count: a network of forty gans needs a different number, and finding
 * that out should not require a deploy.
 */
const limiter = require('express-rate-limit')({
  windowMs: 60 * 60 * 1000,
  max: Math.max(1, parseInt(process.env.IMPORT_BOT_RATE_MAX, 10) || 40),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'יותר מדי העלאות. נסו שוב בעוד שעה.' } },
});

router.post('/cibus', limiter, authed, upload.single('file'), guard(c.cibus));
router.post('/clicktac', limiter, authed, upload.single('file'), guard(c.clicktac));

// The dry run for ClickTac — identifies the export, checks the file's city
// against the branch, counts rows, and writes nothing. Before /clicktac in
// nobody's way, since Express matches the full path.
router.post('/clicktac/validate', limiter, authed, upload.single('file'), guard(c.clicktacValidate));

module.exports = router;
