const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/order.controller');

const RECEIVE_ROLES = ['system_admin', 'branch_manager', 'class_leader', 'cook'];
// Who may place, change or approve a supply order — the ordering roles plus
// accounting. Teachers/assistants read but do not write.
const ORDER_ROLES = ['system_admin', 'branch_manager', 'accountant', 'class_leader', 'cook'];
const canOrder = requireRole(...ORDER_ROLES);

router.get('/', c.getAll);
router.get('/:id', c.getById);
router.post('/', canOrder, c.create);
router.put('/:id', canOrder, c.update);
router.post('/:id/approve', canOrder, c.approve);
router.post('/:id/resend-email', authMiddleware, canOrder, c.resendEmail);
router.post('/:id/mark-arrived', authMiddleware, requireRole(...RECEIVE_ROLES), c.markArrived);
router.post('/:id/receive', authMiddleware, requireRole(...RECEIVE_ROLES), c.receive);
router.delete('/:id', canOrder, c.remove);

module.exports = router;
