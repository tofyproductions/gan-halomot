const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/employeeLetters.controller');

router.use(authMiddleware);
// A branch manager issues her own staff's letters — she is the one who runs
// the hearing and signs it. The controller scopes every call to her branches.
router.use(requireRole('system_admin', 'accountant', 'branch_manager'));

router.get('/', c.list);
// Static paths first — '/:id' would otherwise swallow them.
router.get('/context/:employeeId', c.getContext);
router.post('/preview', c.preview);
router.post('/', c.issue);
router.get('/:id', c.getOne);
router.get('/:id/pdf', c.pdf);
router.delete('/:id', c.remove);

module.exports = router;
