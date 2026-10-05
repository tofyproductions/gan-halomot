const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireBrainKey } = require('../middleware/brainAuth');
const { asyncWrap } = require('../utils/asyncWrap');
const svc = require('../services/brainRead.service');

/**
 * The brain's read window. GET only, no body, no writes — the router declares
 * no other method, so POST/PUT/PATCH/DELETE fall through to the 404 handler.
 * Mounted BEFORE authMiddleware in routes/index.js (it has its own key, not a
 * user session). Responses are closed shapes with no contact details, IDs,
 * addresses, notes, bank data or salaries — see services/brainRead.service.js.
 */
const router = express.Router();

// BEFORE the key check on purpose: an anonymous flood of guesses is throttled
// too, not just the holder of the key. Keyed by IP (trust proxy is set).
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limited' },
});

router.use(limiter, requireBrainKey);

// `month` is optional (defaults to the current Israel month, like /summary), but
// when given it must be a valid YYYY-MM or the call is refused.
const monthOf = (req, res) => {
  if (req.query.month === undefined) return svc.currentMonthKey();
  if (typeof req.query.month === 'string' && svc.parseMonth(req.query.month)) return req.query.month;
  res.status(400).json({ error: 'month must be YYYY-MM (2020-01 .. 2040-12)' });
  return null;
};

router.get('/summary', asyncWrap(async (req, res) => res.json(await svc.summary())));
router.get('/payments', asyncWrap(async (req, res) => {
  const month = monthOf(req, res); if (!month) return;
  res.json(await svc.payments(month));
}));
router.get('/unpaid', asyncWrap(async (req, res) => {
  const month = monthOf(req, res); if (!month) return;
  res.json(await svc.unpaid(month));
}));
router.get('/children', asyncWrap(async (req, res) => {
  // Only active children exist here; `active=true` is accepted for the brain's
  // sake, anything else is refused rather than silently ignored.
  if (req.query.active !== undefined && req.query.active !== 'true') return res.status(400).json({ error: 'only active=true is supported' });
  res.json(await svc.children());
}));

// Anything else under /brain: no write method exists here, and says so (405)
// rather than falling through to routes that would answer with a login prompt.
router.use((req, res) => res.status(req.method === 'GET' ? 404 : 405).json({ error: req.method === 'GET' ? 'not found' : 'read only' }));

module.exports = router;
