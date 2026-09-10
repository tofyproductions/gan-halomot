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

// Custom roles — a named permission set built from one person's actual tabs,
// then assignable to others and editable like a built-in role.
// See models/CustomRole.js.
router.get('/custom-roles', ctrl.listCustomRoles);
router.post('/custom-roles/from-user/:userId', ctrl.createCustomRoleFromUser);
router.patch('/custom-roles/:id', ctrl.updateCustomRole);
router.delete('/custom-roles/:id', ctrl.deleteCustomRole);

// Which build is live in the App Store and in Google Play. Typed in by hand
// once a store approves one — see the controller for why it cannot be derived.
const appVersion = require('../controllers/appVersion.controller');
router.get('/app-version', appVersion.getVersions);
router.put('/app-version', appVersion.setVersions);

// SMTP diagnostics
router.get('/email-diagnostic', ctrl.emailDiagnostic);
router.post('/email-test', ctrl.emailTest);

// Pending "delete my account" requests — see dataDeletion.service for what
// completing one actually does.
router.get('/data-deletion', dataDeletion.adminList);
router.post('/data-deletion/:id/complete', dataDeletion.adminComplete);

module.exports = router;
