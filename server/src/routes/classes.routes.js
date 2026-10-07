const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole, attachBranchScope } = require('../middleware/auth');
const c = require('../controllers/classes.controller');

router.use(authMiddleware);
/**
 * The branch boundary, decided on the server.
 *
 * It was missing here, and it cost in both directions. getBranchFilter FAILS
 * CLOSED when this middleware has not run — `req.branchScope` is undefined, so
 * it builds `{ branch_id: { $in: [] } }` — which means the payment summary has
 * been answering "nothing is owed to anybody" to every caller, including a
 * system admin, for as long as it has existed. And in the other direction,
 * listPrograms read `?branch` straight off the query with nothing clamping it,
 * so a teacher at one branch could list another's classes by changing a
 * number in the URL.
 *
 * One line fixes both: the scope is resolved from the caller's role and
 * managed branches, and a `?branch` outside it is refused here rather than
 * trusted downstream.
 */
router.use(attachBranchScope);

const MANAGER = requireRole('system_admin', 'branch_manager', 'accountant');

// Providers (ספקי גנים)
router.get('/providers', c.listProviders);
router.post('/providers', MANAGER, c.createProvider);
router.put('/providers/:id', MANAGER, c.updateProvider);
router.delete('/providers/:id', MANAGER, c.deleteProvider);
// One provider's whole arrangement — which branches, which groups, which days,
// which rates — read and written in a single call. See the controller.
router.get('/providers/:id/schedule', c.getProviderSchedule);
router.put('/providers/:id/schedule', MANAGER, c.setProviderSchedule);

// Programs (חוגים)
router.get('/programs', c.listPrograms);
router.post('/programs', MANAGER, c.createProgram);
router.put('/programs/:id', MANAGER, c.updateProgram);
router.delete('/programs/:id', MANAGER, c.deleteProgram);

// Sessions — the occurrence popup poll + answer are open to any authenticated
// user (the controller checks manager-role OR class-lead ownership per session).
router.get('/sessions/due', c.dueSessions);
router.get('/sessions', c.listSessions);
router.post('/sessions', MANAGER, c.createSession);
router.post('/sessions/generate', MANAGER, c.generateSessions);
// Write a whole month from each class's fixed day. Idempotent — a date that
// already has a session is untouched.
router.post('/sessions/fill-month', MANAGER, c.fillMonth);
router.post('/sessions/:id/answer', c.answerSession);
// A whole visit — one instructor, one branch, one morning, every group ticked
// at once. Permission is still checked per session inside.
router.post('/sessions/answer-visit', c.answerVisit);
router.put('/sessions/:id', MANAGER, c.updateSession);
router.delete('/sessions/:id', MANAGER, c.deleteSession);

// Payment summary (occurred × rate)
router.get('/payment-summary', MANAGER, c.paymentSummary);

module.exports = router;
