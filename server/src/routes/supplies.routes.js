const router = require('express').Router();
const ctrl = require('../controllers/supplies.controller');
const { requireTab } = require('../middleware/auth');

/**
 * מה חסר לילדי הגן.
 *
 * Same gate as the תינוקייה board and for the same reason: the person who
 * notices the wipes ran out is the one in the room, not the one in the office.
 * Reading the list and ticking an item are the same act, so there is no
 * separate write permission — a teacher who can see that a child is short of
 * nappies but cannot say so has been given nothing.
 */
const allow = requireTab('nursery', 'system_admin', 'branch_manager', 'class_leader', 'teacher', 'assistant');

router.get('/', allow, ctrl.roster);
router.put('/:childId', allow, ctrl.setForChild);

module.exports = router;
