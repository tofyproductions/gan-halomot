const express = require('express');
const router = express.Router();
const collectionsController = require('../controllers/collections.controller');

// GET /api/collections?year=2026
router.get('/', collectionsController.getAll);

// GET /api/collections/history
router.get('/history', collectionsController.getHistory);

// GET /api/collections/:registrationId
router.get('/:registrationId', collectionsController.getByRegistration);

// PUT /api/collections/:registrationId/month/:monthIndex
router.put('/:registrationId/month/:monthIndex', collectionsController.updateMonth);

// POST /api/collections/:registrationId/recalculate
router.post('/:registrationId/recalculate', collectionsController.recalculate);

// PUT /api/collections/:registrationId/exit-month
router.put('/:registrationId/exit-month', collectionsController.updateExitMonth);

// POST /api/collections/backup
router.post('/backup', collectionsController.backup);

module.exports = router;
