const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');
const { ADMIN_VIEWER } = require('../constants/roles');
const c = require('../controllers/proposedChanges.controller');

// Mounted below the global authMiddleware in routes/index.js.
// A viewer lists her own; the office lists and decides everything.
router.get('/', requireRole('system_admin', 'accountant', ADMIN_VIEWER), c.list);
router.get('/count', requireRole('system_admin', 'accountant'), c.count);
router.post('/:id/decide', requireRole('system_admin', 'accountant'), c.decide);
router.post('/:id/retry', requireRole('system_admin', 'accountant'), c.retry);

module.exports = router;
