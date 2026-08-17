const router = require('express').Router();
const ctrl = require('../controllers/announcements.controller');
const { requireTab, requireRole } = require('../middleware/auth');

/**
 * הודעות לגן — what the gan tells the families.
 *
 * Open to the people who have something to say: a teacher and a class leader
 * know what happened in the room, and gating writing on management would mean
 * the announcement is written by whoever is furthest from it.
 *
 * DECIDING IS A NARROWER GRANT THAN WRITING, and the two gates below are the
 * whole shape of this feature. Everything a teacher touches leaves the
 * announcement pending; publishing it, taking it to WhatsApp, and spending
 * money on it are the branch manager's, because she is accountable for what
 * two hundred families are told and for the account it is sent from.
 *
 * The controller narrows every one of these to the caller's own branches
 * through resolveBranchScope, which reads the database rather than the token —
 * so a manager granted a second gan this morning can act on it this morning.
 */
const allow = requireTab('announcements', 'system_admin', 'branch_manager', 'class_leader', 'teacher');
const decider = requireRole('system_admin', 'branch_manager');

// ABOVE the /:id routes. Express matches in order, and a literal that lives
// below a parameter is a literal that works until somebody adds GET /:id.
//
// The monthly allowance. Anyone who can write may see it — a teacher drafting
// an urgent notice should know before she writes it whether it can be sent.
router.get('/budget', allow, ctrl.budget);
// Raising it is a person's decision, deliberately, and only one person's.
router.post('/budget/grant', allow, requireRole('system_admin'), ctrl.grantBudget);

// Reading and writing. A teacher's create lands as `pending` — the controller
// decides that from the role rather than from the body, so a client asking for
// 'published' is asking for nothing.
router.get('/', allow, ctrl.list);
router.post('/', allow, ctrl.create);
router.patch('/:id', allow, ctrl.update);
router.delete('/:id', allow, ctrl.remove);

// Who it reaches and what an SMS would cost — read before deciding, so it sits
// with the wider grant. Nothing here sends anything.
router.get('/:id/audience', allow, ctrl.audience);

// The manager's own: publish or reject with a reason, hand the text to
// WhatsApp, and the one call that spends money.
router.post('/:id/decide', allow, decider, ctrl.decide);
router.post('/:id/whatsapp', allow, decider, ctrl.whatsappCopy);
router.post('/:id/sms', allow, decider, ctrl.sendUrgentSms);

module.exports = router;
