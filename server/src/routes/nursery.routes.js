const router = require('express').Router();
const ctrl = require('../controllers/nursery.controller');
const { requireTab, requireRole } = require('../middleware/auth');

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
/**
 * `classroom_board` is on this list because the board IS what it is for. The
 * controller narrows it to its own room, so admitting it here grants one
 * screen for one classroom rather than the nursery tab across a branch.
 */
const allow = requireTab('nursery', 'system_admin', 'branch_manager', 'class_leader', 'teacher', 'assistant', 'classroom_board');

router.get('/board', allow, ctrl.board);
// A child carried on this board from another room — the פעוט whose family
// still gets the bottle log. Same permission as the board: whoever fills it
// decides who is on it. The move itself is only ASKED for here; the branch
// manager answers under /api/children/move-requests.
router.get('/board/candidates', allow, ctrl.boardCandidates);
router.post('/board/extend', allow, ctrl.extendOnBoard);
router.post('/board/release', allow, ctrl.releaseFromBoard);
router.post('/board/move-request', allow, ctrl.requestMove);
router.patch('/log/:childId', allow, ctrl.updateLog);
// The older rooms' whole day: one line for the class. Same permission as the
// per-child log — whoever fills the board fills this.
router.put('/classroom-day', allow, ctrl.setClassroomDay);
router.put('/menu', allow, ctrl.setMenu);

// The lists and the menu behind the board. Reading them is part of using the
// screen; CHANGING them is not — one edit reshapes the board for every branch
// at once, so it stays with the people who answer for that.
const allowEdit = requireRole('system_admin', 'branch_manager');
router.get('/settings', allow, ctrl.settings);
router.put('/settings/options', allow, allowEdit, ctrl.saveOptions);
router.put('/settings/menu', allow, allowEdit, ctrl.saveMenu);

module.exports = router;
