const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/branchPricing.controller');

// Pricing config is an admin/finance area.
router.use(authMiddleware, requireRole('system_admin', 'branch_manager', 'accountant'));

router.get('/', c.getAll);
router.get('/:branchId', c.getForBranch);
router.put('/:branchId', c.upsert);

module.exports = router;
