const router = require('express').Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/employeeOnboarding.controller');

/**
 * רישומי עובדים — the queue a new hire's form waits in.
 *
 * A branch manager reads the registration for somebody she hired, chases a
 * missing certificate and can refuse one that is not the person she expected.
 * She does NOT see the bank details and she does not approve: creating an
 * employee card is a decision with a payroll on the other end of it, and the
 * controller enforces both.
 */
router.use(authMiddleware);
router.use(requireRole('system_admin', 'accountant', 'branch_manager'));

router.get('/', c.list);
router.get('/counts', c.counts);
router.get('/:id/file/:fileId', c.downloadFile);
router.post('/:id/approve', c.approve);
router.post('/:id/reject', c.reject);

module.exports = router;
