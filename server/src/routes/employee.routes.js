const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/employee.controller');

router.use(authMiddleware);

router.get('/', c.getAll);
router.get('/:id', c.getById);
router.post('/', requireRole('system_admin', 'branch_manager'), c.create);
router.put('/:id', requireRole('system_admin', 'branch_manager'), c.update);
router.delete('/:id', requireRole('system_admin', 'branch_manager'), c.remove);

module.exports = router;
