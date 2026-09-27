const express = require('express');
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/punchFollowup.controller');

/**
 * Punch follow-up — docs/superpowers/specs/2026-09-27-punch-followup-design.md.
 * Any logged-in staff member: the controller resolves HER employee record and
 * only ever touches her own issues, so no role gate belongs here.
 */
const router = express.Router();
router.use(authMiddleware);
router.get('/mine', c.mine);
router.post('/fix', c.fixIssue);

// The manager's side — scoped in the controller to her own branches.
const MANAGERS = requireRole('branch_manager', 'admin_viewer', 'system_admin', 'accountant');
router.get('/manager', MANAGERS, c.managerList);
router.post('/decide', MANAGERS, c.decide);
router.post('/fix-as-manager', MANAGERS, c.fixAsManager);
router.post('/remind', MANAGERS, c.remind);

module.exports = router;
