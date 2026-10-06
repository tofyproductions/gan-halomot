const express = require('express');
const router = express.Router();
const c = require('../controllers/gantt.controller');
const { requireTabWrite } = require('../middleware/auth');

// What parents may see, per week. Read before the gantt itself so the
// screen can show the switch beside the plan it publishes.
//
// The WRITE is gated and the read is not, because these two switches are the
// only thing in this router that speaks to people outside the gan: flipping
// one publishes a month's plan to every parent of a branch, or takes the menu
// off their screens. This router carries no guard of its own otherwise — it
// relies on the staff authMiddleware and decides per row from branch scope —
// and that was enough while everything here stayed between colleagues.
//
// requireTabWrite rather than requireRole, so a custom role the gan granted
// the גאנט tab to still passes. The matching branch check is in the controller:
// branch_id arrives in the body, and attachBranchScope only polices ?branch.
router.get('/visibility', c.getVisibility);
router.put('/visibility', requireTabWrite('gantt', 'system_admin', 'branch_manager'), c.setVisibility);

// The month as one PNG for the parents' WhatsApp group. POST because the
// document is the body, not an id.
router.post('/image', c.image);

router.get('/', c.get);
router.get('/archive', c.getArchive);
// Months worth copying FROM. Above '/:id/...' so it is never read as an id.
router.get('/sources', c.sources);
// Whose turn it is to be אבא / אמא של שבת, and a proposal for the month.
router.get('/shabbat-parents', c.shabbatParents);
router.post('/copy', c.copy);
router.post('/', c.save);
router.post('/:id/approve', c.approve);

module.exports = router;
