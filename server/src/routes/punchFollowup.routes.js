const express = require('express');
const { authMiddleware } = require('../middleware/auth');
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

module.exports = router;
