const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/order.controller');

const RECEIVE_ROLES = ['system_admin', 'branch_manager', 'class_leader', 'cook'];

/**
 * Who may BUILD an order. Not who may send one — see canApprove.
 *
 * `teacher` is on the list because of the אב בית, who is carried in the
 * system as one: the person who walks the building and notices the light
 * bulbs ran out could not open an order at all, which is the wrong way round.
 * Letting him build one is safe now that building and sending are different
 * acts — before the approval step existed, this list was also the list of
 * people who could email a supplier, and that is why it was short.
 */
const ORDER_ROLES = ['system_admin', 'branch_manager', 'accountant', 'class_leader', 'cook', 'teacher'];
const canOrder = requireRole(...ORDER_ROLES);

/**
 * Who may APPROVE — which is to say, who may spend the gan's money.
 *
 * The office, and only the office. A branch manager builds an order like
 * anyone else and waits, deliberately: an order is a bill, and the gan wants
 * one pair of eyes on every bill before it is incurred.
 *
 * `admin_viewer` is on the list by the gan's explicit decision, and it is a
 * real exception — that role exists to be unable to write, and the database
 * itself refuses its writes unless a gate claims the request
 * (utils/viewerWriteGuard). requireRole claims it, so naming the role here is
 * the whole mechanism; approving through it writes for real rather than
 * quietly becoming a proposal.
 */
const canApprove = requireRole('system_admin', 'admin_viewer');

router.get('/', c.getAll);
router.get('/:id/group', c.group);
router.get('/:id/invitable-branches', canOrder, c.invitableBranches);
router.post('/:id/invite', canOrder, c.invite);
router.get('/:id', c.getById);
router.post('/', canOrder, c.create);
router.put('/:id', canOrder, c.update);
// Submit for approval. Kept at /send because that is what the client calls
// and what the person pressing it is doing; what changed is where it goes.
router.post('/:id/send', canOrder, c.send);
// And this is the one that reaches the supplier.
router.post('/:id/approve', canApprove, c.approve);
router.post('/:id/resend-email', authMiddleware, canApprove, c.resendEmail);
router.post('/:id/mark-arrived', authMiddleware, requireRole(...RECEIVE_ROLES), c.markArrived);
router.post('/:id/receive', authMiddleware, requireRole(...RECEIVE_ROLES), c.receive);
router.delete('/:id', canOrder, c.remove);

module.exports = router;
