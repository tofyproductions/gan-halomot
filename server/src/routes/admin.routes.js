const router = require('express').Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/admin.controller');
const dataDeletion = require('../controllers/dataDeletion.controller');

router.use(authMiddleware, requireRole('system_admin'));

router.get('/users', ctrl.listUsers);
router.patch('/users/:id/tabs', ctrl.updateUserTabs);
router.patch('/users/:id/role', ctrl.updateUserRole);
router.post('/users/:id/reset-password', ctrl.resetPassword);

// Role-wide tab overrides (bulk: applies to every user of the role)
router.get('/role-tabs', ctrl.getRoleTabs);
router.put('/role-tabs', ctrl.setRoleTabs);

// SMTP diagnostics
router.get('/email-diagnostic', ctrl.emailDiagnostic);
router.post('/email-test', ctrl.emailTest);

// Pending "delete my account" requests — see dataDeletion.service for what
// completing one actually does.
router.get('/data-deletion', dataDeletion.adminList);
router.post('/data-deletion/:id/complete', dataDeletion.adminComplete);

module.exports = router;
