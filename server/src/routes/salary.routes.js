const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/salary.controller');

router.use(authMiddleware);

router.get('/', c.getAll);
router.post('/', requireRole('system_admin', 'branch_manager'), c.create);
router.post('/:id/approve', requireRole('system_admin'), c.approve);
router.post('/:id/reject', requireRole('system_admin'), c.reject);

module.exports = router;
