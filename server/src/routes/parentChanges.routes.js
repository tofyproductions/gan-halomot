const router = require('express').Router();
const ctrl = require('../controllers/parentChanges.controller');
const { requireTab } = require('../middleware/auth');

/**
 * עדכונים מהורים — what parents changed about their own children.
 *
 * Open to the people who act on it. A branch manager needs to know an address
 * moved; a class leader needs to know an allergy did, and gating that on
 * management would mean the person who feeds the child is the last to hear.
 * The controller narrows each of them to their own branches.
 *
 * Read and acknowledge are the same grant on purpose. Somebody who can see an
 * unread allergy and cannot mark it read will leave it unread for the next
 * person, and the list stops meaning anything.
 */
const allow = requireTab('parent_changes', 'system_admin', 'branch_manager', 'accountant', 'class_leader');

router.get('/', allow, ctrl.list);
router.get('/unseen-count', allow, ctrl.unseenCount);
router.post('/:id/seen', allow, ctrl.markSeen);

module.exports = router;
