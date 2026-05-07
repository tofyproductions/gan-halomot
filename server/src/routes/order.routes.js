const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/order.controller');

const RECEIVE_ROLES = ['system_admin', 'branch_manager', 'class_leader', 'cook'];

router.get('/', c.getAll);
router.get('/:id', c.getById);
router.post('/', c.create);
router.put('/:id', c.update);
router.post('/:id/approve', c.approve);
router.post('/:id/mark-arrived', authMiddleware, requireRole(...RECEIVE_ROLES), c.markArrived);
router.post('/:id/receive', authMiddleware, requireRole(...RECEIVE_ROLES), c.receive);
router.delete('/:id', c.remove);

module.exports = router;
