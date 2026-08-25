const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/account.controller');

/**
 * The customer's own subscription, read-only.
 *
 * system_admin only — this is the gan's commercial relationship with us, not
 * something a branch manager or an accountant employed by them needs. Read
 * only: what a customer pays is what was agreed, and an agreement is not a
 * form somebody edits.
 */
router.use(authMiddleware);
router.get('/', requireRole('system_admin'), c.myAccount);

module.exports = router;
