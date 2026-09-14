const express = require('express');
const router = express.Router();
const contractsController = require('../controllers/contracts.controller');
const { requireRole } = require('../middleware/auth');
const manage = requireRole('system_admin', 'branch_manager', 'accountant');

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
router.post('/upload', manage, contractsController.uploadContract);

// GET /api/contracts/doc/:id/file
router.get('/doc/:id/file', contractsController.getContractFile);

// DELETE /api/contracts/doc/:id
router.delete('/doc/:id', manage, contractsController.deleteContract);

module.exports = router;
