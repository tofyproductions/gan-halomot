const router = require('express').Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/admin.controller');

router.use(authMiddleware, requireRole('system_admin'));

router.get('/users', ctrl.listUsers);
router.patch('/users/:id/tabs', ctrl.updateUserTabs);
router.patch('/users/:id/role', ctrl.updateUserRole);
router.post('/users/:id/reset-password', ctrl.resetPassword);

// SMTP diagnostics
router.get('/email-diagnostic', ctrl.emailDiagnostic);
router.post('/email-test', ctrl.emailTest);

module.exports = router;
