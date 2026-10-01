const express = require('express');
const { financeAuth } = require('../middleware/financeAuth');
const { asyncWrap } = require('../utils/asyncWrap');
const c = require('../controllers/financeAgent.controller');

/**
 * The bank-pi agent's routes. Signed (financeAuth), NOT bearer-authed — so
 * this router is mounted BEFORE authMiddleware in routes/index.js.
 */
const router = express.Router();
router.use(financeAuth);
router.post('/ingest', asyncWrap(c.ingestFeed));
router.get('/sync/claim', asyncWrap(c.claim));
router.post('/sync/finish', asyncWrap(c.finish));
module.exports = router;
