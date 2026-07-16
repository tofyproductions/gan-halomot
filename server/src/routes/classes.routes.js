const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/classes.controller');

router.use(authMiddleware);

const MANAGER = requireRole('system_admin', 'branch_manager', 'accountant');

// Providers (ספקי גנים)
router.get('/providers', c.listProviders);
router.post('/providers', MANAGER, c.createProvider);
router.put('/providers/:id', MANAGER, c.updateProvider);
router.delete('/providers/:id', MANAGER, c.deleteProvider);

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
router.post('/sessions/:id/answer', c.answerSession);
router.put('/sessions/:id', MANAGER, c.updateSession);
router.delete('/sessions/:id', MANAGER, c.deleteSession);

// Payment summary (occurred × rate)
router.get('/payment-summary', MANAGER, c.paymentSummary);

module.exports = router;
