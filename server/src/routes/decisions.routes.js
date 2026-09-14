const express = require('express');
const router = express.Router();
const { authMiddleware, allowSelfWrite } = require('../middleware/auth');
const c = require('../controllers/decisions.controller');

// Everything here is scoped to the caller's OWN requests, so there is no role
// gate: an accountant asking what was decided on her requests gets her
// requests, and there is nothing to be gained by asking for somebody else's.
router.use(authMiddleware);

router.get('/', c.myDecisions);
// A read receipt on the caller's own row, which is why it is signed for: a
// viewer's unsigned write becomes a proposal, and "אלעד has read his
// notices" is not something the office can approve or refuse.
router.post('/seen', allowSelfWrite('decisions-seen'), c.markSeen);

module.exports = router;
