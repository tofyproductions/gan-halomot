const express = require('express');
const router = express.Router();
const { agentAuth } = require('../middleware/agentAuth');
const c = require('../controllers/agent.controller');

/**
 * Routes used by the Pi agents running at each branch. All routes are
 * authenticated with X-Agent-Secret (per-branch shared secret) and NOT
 * with the normal JWT auth that the rest of the API uses.
 *
 * Mounted under /api/agent — see routes/index.js
 */
router.use('/:branchId', agentAuth);

router.post('/:branchId/punches', c.uploadPunches);
router.post('/:branchId/heartbeat', c.heartbeat);
router.get('/:branchId/pending-commands', c.pendingCommands);
router.post('/:branchId/command-result', c.commandResult);

module.exports = router;
