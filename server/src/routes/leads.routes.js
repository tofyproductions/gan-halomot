const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/leads.controller');

router.use(authMiddleware);
router.use(requireRole('system_admin', 'branch_manager', 'accountant'));

router.get('/', c.list);
router.get('/counts', c.counts);
router.put('/:id', c.update);
router.delete('/:id', requireRole('system_admin', 'branch_manager'), c.remove);

module.exports = router;
