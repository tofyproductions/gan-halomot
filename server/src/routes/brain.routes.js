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
router.get('/sync', asyncWrap(async (req, res) => res.json(await svc.sync())));
router.get('/children', asyncWrap(async (req, res) => {
  // Only active children exist here; `active=true` is accepted for the brain's
  // sake, anything else is refused rather than silently ignored.
  if (req.query.active !== undefined && req.query.active !== 'true') return res.status(400).json({ error: 'only active=true is supported' });
  res.json(await svc.children());
}));

// The morning report's reads (המוח). `date` is optional (today, Israel) but when
// given must be a real YYYY-MM-DD; `days` 1..14 — anything else is refused, not
// guessed at, like `month` above.
const dateOf = (req, res) => {
  if (req.query.date === undefined) return svc.todayKey();
  if (typeof req.query.date === 'string' && svc.parseDate(req.query.date)) return req.query.date;
  res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  return null;
};
const daysOf = (req, res, dflt) => {
  if (req.query.days === undefined) return dflt;
  if (typeof req.query.days === 'string' && /^([1-9]|1[0-4])$/.test(req.query.days)) return Number(req.query.days);
  res.status(400).json({ error: 'days must be 1..14' });
  return null;
};
router.get('/attendance', asyncWrap(async (req, res) => {
  const date = dateOf(req, res); if (!date) return;
  res.json(await svc.attendance(date));
}));
router.get('/orders', asyncWrap(async (req, res) => {
  if (Object.keys(req.query).length) return res.status(400).json({ error: 'no parameters' });
  res.json(await svc.pendingOrders());
}));
router.get('/birthdays', asyncWrap(async (req, res) => {
  const days = daysOf(req, res, 7); if (!days) return;
  res.json(await svc.birthdays(days));
}));
router.get('/shifts', asyncWrap(async (req, res) => {
  const date = dateOf(req, res); if (!date) return;
  res.json(await svc.shifts(date));
}));
router.get('/signups', asyncWrap(async (req, res) => {
  const days = daysOf(req, res, 1); if (!days) return;
  res.json(await svc.signups(days));
}));

// Anything else under /brain: no write method exists here, and says so (405)
// rather than falling through to routes that would answer with a login prompt.
router.use((req, res) => res.status(req.method === 'GET' ? 404 : 405).json({ error: req.method === 'GET' ? 'not found' : 'read only' }));

module.exports = router;
