const express = require('express');
const multer = require('multer');
const router = express.Router();
const registrationController = require('../controllers/registration.controller');

const upload = multer({ storage: multer.memoryStorage() });

// GET /api/registration
router.get('/', registrationController.getAll);

// POST /api/registration/fix-orphan-branch — assign null-branch regs to a branch
router.post('/fix-orphan-branch', registrationController.fixOrphanBranch);

// POST /api/registration/academic-year/bulk — move many registrations to another
// gan year at once. Declared before /:id so "academic-year" is not read as an id.
router.post('/academic-year/bulk', registrationController.bulkSetAcademicYear);

// GET /api/registration/:id
router.get('/:id', registrationController.getById);

// POST /api/registration
router.post('/', registrationController.create);

// PUT /api/registration/:id
router.put('/:id', registrationController.update);

// PUT /api/registration/:id/academic-year — move this registration to another
// gan year, taking its child record and its collection row with it.
router.put('/:id/academic-year', registrationController.setAcademicYear);

// POST /api/registration/:id/generate-link
router.post('/:id/generate-link', registrationController.generateLink);

// POST /api/registration/:id/renew — issue next year's contract for a family
// already in the gan. A registration covers ONE year; when the year turns the
// family needs a new one and a new signature.
router.post('/:id/renew', registrationController.renew);

// POST /api/registration/:id/activate
router.post('/:id/activate', registrationController.activate);

// POST /api/registration/:id/finalize-manual
router.post('/:id/finalize-manual', upload.single('contract_file'), registrationController.finalizeManual);

// GET /api/registration/:id/contract-download
router.get('/:id/contract-download', registrationController.downloadContract);

// GET /api/registration/:id/contract-versions
router.get('/:id/contract-versions', registrationController.listContractVersions);

// GET /api/registration/contract-versions/:versionId/download
router.get('/contract-versions/:versionId/download', registrationController.downloadContractVersion);

// DELETE /api/registration/:id
router.delete('/:id', registrationController.remove);

module.exports = router;
