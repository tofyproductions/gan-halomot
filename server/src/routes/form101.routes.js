const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/form101.controller');

router.use(authMiddleware);

// The roster view and filing a form for someone are branch-manager work; the
// scan's switches and the mailbox test are not.
const MANAGE = requireRole('system_admin', 'branch_manager', 'accountant');
const ADMIN = requireRole('system_admin', 'accountant');

router.get('/overview', MANAGE, c.overview);
router.post('/employees/:employeeId', MANAGE, c.uploadForEmployee);

router.get('/inbox', MANAGE, c.listInbox);
router.get('/inbox/:id/file', MANAGE, c.inboxFile);
router.post('/inbox/:id/assign', MANAGE, c.assignInbox);
router.post('/inbox/:id/discard', MANAGE, c.discardInbox);

router.get('/config', ADMIN, c.getConfig);
router.put('/config', ADMIN, c.updateConfig);
router.post('/scan', ADMIN, c.scanNow);
router.get('/mail-test', ADMIN, c.testMailbox);

module.exports = router;
