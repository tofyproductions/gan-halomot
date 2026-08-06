const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/cibusSync.controller');

router.use(authMiddleware);
// Reading a mailbox and writing money into a payroll month — accounting and
// admin only, never a branch manager.
router.use(requireRole('system_admin', 'accountant'));

router.get('/', c.get);
router.put('/', c.update);
router.post('/test', c.test);
router.post('/scan', c.scan);
router.post('/run', c.run);

module.exports = router;
