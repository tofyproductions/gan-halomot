const router = require('express').Router();
const ctrl = require('../controllers/gifts.controller');
const { requireTab, requireRole } = require('../middleware/auth');

/**
 * מבצעי מתנות.
 *
 * Reading and finalising are open to whoever works with the children — the
 * person who knows which photograph actually looks like the child is the one
 * in the room, not the one in the office.
 *
 * OPENING a round is not. It sets dates and products for every branch at once,
 * and a second round created by mistake would show every parent two competing
 * deadlines.
 */
const allow = requireTab('gifts', 'system_admin', 'branch_manager', 'class_leader', 'accountant');
const allowManage = requireRole('system_admin', 'branch_manager');

router.get('/', allow, ctrl.listCampaigns);
router.post('/', allow, allowManage, ctrl.createCampaign);
router.patch('/:id', allow, allowManage, ctrl.updateCampaign);
router.get('/:id/progress', allow, ctrl.progress);
router.post('/:id/children/:childId/final', allow, ctrl.setFinal);
router.get('/:id/export', allow, ctrl.exportCampaign);

module.exports = router;
