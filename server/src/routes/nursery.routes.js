const router = require('express').Router();
const ctrl = require('../controllers/nursery.controller');
const { requireTab } = require('../middleware/auth');

/**
 * The תינוקייה board. Mounted below the staff auth middleware, so everything
 * here already has a logged-in user.
 *
 * Gated by the `nursery` tab with the roles that work in the room as the
 * defaults — a teacher needs this screen more than anyone, and gating it on
 * management would mean the board is filled in by somebody who was not there.
 * Which classrooms each of them actually sees is narrowed again inside the
 * controller by branch scope.
 *
 * No requireTabWrite: reading this board and filling it in are the same act.
 * A teacher who can see the room's day and cannot record it has been given
 * nothing.
 */
const allow = requireTab('nursery', 'system_admin', 'branch_manager', 'class_leader', 'teacher', 'assistant');

router.get('/board', allow, ctrl.board);
router.patch('/log/:childId', allow, ctrl.updateLog);
router.put('/menu', allow, ctrl.setMenu);

module.exports = router;
