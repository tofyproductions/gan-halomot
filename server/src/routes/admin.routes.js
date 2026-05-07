const router = require('express').Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/admin.controller');

router.use(authMiddleware, requireRole('system_admin'));

router.get('/users', ctrl.listUsers);
router.patch('/users/:id/tabs', ctrl.updateUserTabs);

module.exports = router;
