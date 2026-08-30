const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');
const c = require('../controllers/rateChangeRequests.controller');

// Mounted below the global authMiddleware in routes/index.js.
router.use(requireRole('system_admin', 'accountant', 'branch_manager'));

router.get('/', c.list);
router.post('/', c.create);
// Only the office turns a request into pay.
router.post('/:id/decide', requireRole('system_admin', 'accountant'), c.decide);

module.exports = router;
