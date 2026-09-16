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

// PUT /api/collections/camp-enrollment/bulk — mark a whole branch at once.
// MUST stay above '/:registrationId', which would swallow it.
router.put('/camp-enrollment/bulk', requireRole('system_admin', 'accountant', 'branch_manager'), collectionsController.bulkCampEnrollment);

// Writing money — the family's monthly billing — belongs to the roles that set
// prices, not to anyone merely logged in. Same set as the summer-camp guard.
const billingRoles = requireRole('system_admin', 'accountant', 'branch_manager');

// GET /api/collections/:registrationId
router.get('/:registrationId', collectionsController.getByRegistration);

// PUT /api/collections/:registrationId/month/:monthIndex
router.put('/:registrationId/month/:monthIndex', billingRoles, collectionsController.updateMonth);

// POST /api/collections/:registrationId/recalculate
router.post('/:registrationId/recalculate', billingRoles, collectionsController.recalculate);

// PUT /api/collections/:registrationId/camp-enrollment — is this child in the
// camp. Per child, because siblings attend separately.
router.put('/:registrationId/camp-enrollment', billingRoles, collectionsController.updateCampEnrollment);

// PUT /api/collections/:registrationId/exit-month
router.put('/:registrationId/exit-month', billingRoles, collectionsController.updateExitMonth);

// The standing note about a family — same writers as every other billing edit.
router.put('/:registrationId/notes', billingRoles, collectionsController.updateNotes);

// PUT /api/collections/:registrationId/registration-fee
router.put('/:registrationId/registration-fee', billingRoles, collectionsController.updateRegistrationFee);

// POST /api/collections/backup
router.post('/backup', billingRoles, collectionsController.backup);

module.exports = router;
