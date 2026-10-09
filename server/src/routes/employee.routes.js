const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole, requireBranchScope } = require('../middleware/auth');
const c = require('../controllers/employee.controller');

router.use(authMiddleware);

// The user directory is a management screen: phones, addresses, emails and
// start dates of the whole branch are not a carer's read (M5).
router.get('/', requireBranchScope, c.getAll);
router.get('/:id', requireBranchScope, c.getById);
router.post('/', requireRole('system_admin', 'branch_manager'), c.create);
router.put('/:id', requireRole('system_admin', 'branch_manager'), c.update);
router.delete('/:id', requireRole('system_admin', 'branch_manager'), c.remove);

module.exports = router;
