const express = require('express');
const router = express.Router();
const contractsController = require('../controllers/contracts.controller');

// GET /api/contracts/:registrationId/preview
router.get('/:registrationId/preview', contractsController.preview);

// POST /api/contracts/:registrationId/generate
router.post('/:registrationId/generate', contractsController.generate);

// GET /api/contracts/:registrationId/download
router.get('/:registrationId/download', contractsController.download);

// --- Contract document management ---
// GET /api/contracts?registration_id=X or ?employee_id=X or ?employee_id=me
router.get('/', contractsController.listContracts);

// POST /api/contracts/upload
router.post('/upload', contractsController.uploadContract);

// GET /api/contracts/doc/:id/file
router.get('/doc/:id/file', contractsController.getContractFile);

// DELETE /api/contracts/doc/:id
router.delete('/doc/:id', contractsController.deleteContract);

module.exports = router;
