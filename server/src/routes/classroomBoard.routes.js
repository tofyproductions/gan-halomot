const router = require('express').Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/classroomBoard.controller');

/**
 * לוחות כיתה — creating the tablet accounts, and setting their passwords.
 *
 * Admins and branch managers. A manager sets up the tablets in her own gan,
 * which is where they physically are and who notices when one stops being
 * filled in; the controller scopes every call to her branches.
 *
 * Deliberately NOT open to the board accounts themselves. A board cannot
 * create another board, cannot change its own password and cannot see that
 * any other board exists.
 */
router.use(authMiddleware);
router.use(requireRole('system_admin', 'branch_manager'));

router.get('/', c.list);
router.post('/', c.create);
router.post('/:id/password', c.setPassword);
router.post('/:id/revoke', c.revoke);
router.patch('/:id', c.update);

module.exports = router;
