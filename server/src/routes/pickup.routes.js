const router = require('express').Router();
const ctrl = require('../controllers/pickup.controller');
const { requireTab, requireRole } = require('../middleware/auth');

/**
 * מורשי איסוף — who may collect a child.
 *
 * SEEING and DECIDING are separate grants, and the split matters more here
 * than anywhere else in this system. The person at the door needs the roll —
 * a teacher, an assistant, whoever is closing the room — and refusing them
 * that means the list is useless at the only moment it is used. Granting
 * somebody the right to walk out with a child is a manager's decision.
 */
const allow = requireTab('pickup', 'system_admin', 'branch_manager', 'class_leader', 'teacher', 'assistant');
const decider = requireRole('system_admin', 'branch_manager');

router.get('/', allow, ctrl.list);
router.post('/:id/decide', allow, decider, ctrl.decide);
router.post('/:id/revoke', allow, decider, ctrl.revoke);

module.exports = router;
