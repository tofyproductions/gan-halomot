const express = require('express');
const router = express.Router();
const collectionsController = require('../controllers/collections.controller');
const { requireRole } = require('../middleware/auth');

// GET /api/collections?year=2026
router.get('/', collectionsController.getAll);

// GET /api/collections/history
router.get('/history', collectionsController.getHistory);

// Summer camp (קייטנה) config — MUST stay above '/:registrationId', which
// would otherwise swallow this path as a registration id.
// GET /api/collections/summer-camp?year=
router.get('/summer-camp', collectionsController.getSummerCamps);
// PUT /api/collections/summer-camp — camp pricing is money; only the roles
// that set prices may write it, not merely anyone who is logged in.
router.put('/summer-camp', requireRole('system_admin', 'accountant', 'branch_manager'), collectionsController.upsertSummerCamp);

// GET /api/collections/:registrationId
router.get('/:registrationId', collectionsController.getByRegistration);

// PUT /api/collections/:registrationId/month/:monthIndex
router.put('/:registrationId/month/:monthIndex', collectionsController.updateMonth);

// POST /api/collections/:registrationId/recalculate
router.post('/:registrationId/recalculate', collectionsController.recalculate);

// PUT /api/collections/:registrationId/exit-month
router.put('/:registrationId/exit-month', collectionsController.updateExitMonth);

// PUT /api/collections/:registrationId/registration-fee
router.put('/:registrationId/registration-fee', collectionsController.updateRegistrationFee);

// POST /api/collections/backup
router.post('/backup', collectionsController.backup);

module.exports = router;
