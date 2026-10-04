const router = require('express').Router();
const { requireTab } = require('../middleware/auth');
const c = require('../controllers/shifts.controller');
const multer = require('multer');

// The screen's roles; finer rules (her branches only, office edits by
// request) are enforced in the service, next to the writes.
const board = requireTab('shifts', 'system_admin', 'admin_viewer', 'branch_manager', 'accountant');
const mine = requireTab('my_shifts', 'teacher', 'assistant', 'class_leader', 'cook');

// Attachments for a constraint: in memory (Render's disk is ephemeral), the
// service applies type and size rules and says so in Hebrew.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 3 } });
function uploadErrors(err, _req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'קובץ גדול מ-10MB' });
  if (err && err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: 'אפשר לצרף עד 3 קבצים' });
  if (err) return res.status(400).json({ error: 'העלאת הקבצים נכשלה' });
  next();
}
// The attachment is the employee's and her managers' — the service decides which.
const anyone = requireTab('my_shifts', 'teacher', 'assistant', 'class_leader', 'cook', 'system_admin', 'admin_viewer', 'branch_manager', 'accountant');

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

router.post('/constraints', mine, upload.array('files', 3), uploadErrors, c.createConstraint);
router.get('/constraints/mine', mine, c.myConstraints);
router.get('/constraints/colleagues', mine, c.colleagues);
router.get('/constraints/future', board, c.futureConstraints);
router.post('/constraints/:id/cancel', mine, c.cancelConstraint);
router.post('/constraints/:id/colleague-response', mine, c.colleagueResponse);
router.post('/constraints/:id/volunteer', mine, c.volunteer);
router.post('/constraints/:id/decide', board, c.decideConstraint);
router.post('/constraints/:id/approve-broadcast', board, c.approveBroadcast);
router.post('/constraints/:id/pick', board, c.pickVolunteer);
router.get('/constraints/:id/files/:index', anyone, c.constraintFile);

router.post('/rate-requests', board, c.createRateRequest);
router.get('/rate-requests', board, c.rateRequests);
router.post('/rate-requests/:id/decide', board, c.decideRateRequest);
router.post('/weeks/:id/cross/:entryId/decide', board, c.decideCross);
router.post('/arrangements/:id/confirm', board, c.confirmArrangement);
router.post('/arrangements/:id/cancel', board, c.cancelArrangement);
router.get('/report', board, c.attendanceReport);

module.exports = router;
