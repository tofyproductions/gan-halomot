const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const c = require('../controllers/decisions.controller');

// Everything here is scoped to the caller's OWN requests, so there is no role
// gate: an accountant asking what was decided on her requests gets her
// requests, and there is nothing to be gained by asking for somebody else's.
router.use(authMiddleware);

router.get('/', c.myDecisions);
router.post('/seen', c.markSeen);

module.exports = router;
