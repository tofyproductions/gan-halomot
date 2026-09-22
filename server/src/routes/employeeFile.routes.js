const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/employeeFile.controller');

router.use(authMiddleware);
// A branch manager keeps her own staff's file. The controller scopes every
// call to her branches, and refuses an employee outside them by name.
router.use(requireRole('system_admin', 'accountant', 'branch_manager'));

router.get('/:employeeId', c.get);

module.exports = router;
