const router = require('express').Router();
const ctrl = require('../controllers/recruitment.controller');

/**
 * גיוס עובדים.
 *
 * No role gate on the router: a branch manager acting on her own candidates is
 * the entire point of the screen. What she may see and touch is decided per
 * row, in the controller, from her record in the database — see scopeFilter
 * and loadScoped there.
 */

router.get('/counts', ctrl.counts);
router.get('/', ctrl.list);

router.post('/pull', ctrl.pull);

router.post('/:id/interview', ctrl.scheduleInterview);
router.post('/:id/not-relevant', ctrl.markNotRelevant);
router.post('/:id/no-answer', ctrl.markNoAnswer);

module.exports = router;
