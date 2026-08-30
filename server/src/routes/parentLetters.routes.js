const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');
const c = require('../controllers/parentLetters.controller');

// Mounted below the global authMiddleware in routes/index.js.
// A branch manager issues confirmations for her own families; the controller
// scopes every call to her branches.
router.use(requireRole('system_admin', 'accountant', 'branch_manager'));

router.get('/', c.list);
// Static paths first — '/:id' would otherwise swallow them.
router.get('/context/:childId', c.getContext);
router.post('/preview', c.preview);
router.post('/', c.issue);
router.get('/:id/pdf', c.pdf);
router.delete('/:id', requireRole('system_admin', 'accountant'), c.remove);

module.exports = router;
