const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const ctrl = require('../controllers/recruitment.controller');

/**
 * גיוס עובדים.
 *
 * No role gate on the router: a branch manager acting on her own candidates is
 * the entire point of the screen. What she may see and touch is decided per
 * row, in the controller, from her record in the database — see scopeFilter
 * and loadScoped there.
 *
 * Auth is asserted HERE as well as by the mount point. The controller reads
 * everything it enforces off req.user, so an unauthenticated request does not
 * fail loudly — it computes a scope of no branches and returns an empty list,
 * which reads exactly like "there are no candidates". This router was mounted
 * above the global middleware for one deploy and did precisely that, while
 * leaving /pull open to anyone holding the URL. Two lines is cheap insurance
 * against a file that behaves plausibly when it is wired up wrong.
 */
router.use(authMiddleware);


router.get('/counts', ctrl.counts);
router.get('/', ctrl.list);

router.post('/pull', ctrl.pull);

router.post('/:id/interview', ctrl.scheduleInterview);
router.post('/:id/not-relevant', ctrl.markNotRelevant);
router.post('/:id/no-answer', ctrl.markNoAnswer);
router.post('/:id/reschedule', ctrl.reschedule);
router.post('/:id/outcome', ctrl.recordOutcome);

module.exports = router;
