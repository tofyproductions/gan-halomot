const express = require('express');
const router = express.Router();
const contractsController = require('../controllers/contracts.controller');

// GET /api/contracts/:registrationId/preview
router.get('/:registrationId/preview', contractsController.preview);

// POST /api/contracts/:registrationId/generate
router.post('/:registrationId/generate', contractsController.generate);

// GET /api/contracts/:registrationId/download
router.get('/:registrationId/download', contractsController.download);

module.exports = router;
