const router = require('express').Router();
const { requireTab } = require('../middleware/auth');
const c = require('../controllers/shifts.controller');

// The screen's roles; finer rules (her branches only, office edits by
// request) are enforced in the service, next to the writes.
const board = requireTab('shifts', 'system_admin', 'admin_viewer', 'branch_manager', 'accountant');
const mine = requireTab('my_shifts', 'teacher', 'assistant', 'class_leader', 'cook');

router.get('/board', board, c.board);
router.post('/weeks', board, c.createWeek);
router.put('/weeks/:id/entries', board, c.saveEntries);
router.post('/weeks/:id/closed-days', board, c.closedDay);
router.post('/weeks/:id/publish', board, c.publish);
router.post('/weeks/:id/edit-requests', board, c.createEditRequest);
router.post('/edit-requests/:id/decide', board, c.decideEditRequest);
router.post('/primary-class', board, c.primaryClass);
router.post('/classrooms/:id/close', board, c.closeClassroom);
router.post('/classrooms/:id/reopen', board, c.reopenClassroom);
router.put('/ratios/:branchId', board, c.ratios);
router.get('/my', mine, c.my);

module.exports = router;
