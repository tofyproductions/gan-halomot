const express = require('express');
const multer = require('multer');
const router = express.Router();
const publicController = require('../controllers/public.controller');

const upload = multer({ storage: multer.memoryStorage() });

// GET /api/public/register/:token
router.get('/register/:token', publicController.getRegistrationForm);

// POST /api/public/register/:token/sign
router.post('/register/:token/sign', publicController.submitSignature);

// POST /api/public/register/:token/contract-pdf — real signed PDF from the
// parent's browser (html2pdf): stored in R2 and emailed.
router.post('/register/:token/contract-pdf', publicController.storeSignedContract);

// POST /api/public/register/:token/upload
router.post(
  '/register/:token/upload',
  upload.fields([
    { name: 'parentIdFile', maxCount: 1 },
    { name: 'paymentProof', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ]),
  publicController.uploadDocument
);

// --- Accountant's corrected-payslip upload (token only, no account) ---
// The page shows the month and the notes we already emailed him, and accepts
// the corrected PDFs straight into a new correction round.
const payslipAudit = require('../controllers/payslipAudit.controller');
router.get('/payslip-fix/:token', payslipAudit.publicFixInfo);
router.post(
  '/payslip-fix/:token/upload',
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })
    .fields(Array.from({ length: 10 }, (_, i) => ({ name: `payslip_file_${i}`, maxCount: 1 }))),
  payslipAudit.publicFixUpload
);

// --- Employment contract signing (employee's phone, token only) ---
// GET /api/public/contract/:token
router.get('/contract/:token', require('../controllers/employmentContracts.controller').publicGet);
// GET /api/public/contract-annex/:id — נספח ג' as read by the employee before
// signing. It is the same safety manual for everyone, so it is not secret.
router.get('/contract-annex/:id', require('../controllers/employmentContracts.controller').annexFile);
// POST /api/public/contract/:token/sign
router.post('/contract/:token/sign', require('../controllers/employmentContracts.controller').publicSign);

// --- Gan events (parent bring-list, no auth) ---
// GET /api/public/event/:token?claimant_id=&phone=
router.get('/event/:token', publicController.getEvent);
// POST /api/public/event/:token/claim   { claimant_id, parent_name, parent_phone, item_name }
router.post('/event/:token/claim', publicController.claimItem);
// POST /api/public/event/:token/release { claimant_id, slot_id, parent_phone }
router.post('/event/:token/release', publicController.releaseItem);

// --- New-parent leads (public inquiry form, no auth) ---
const leads = require('../controllers/leads.controller');
// GET /api/public/lead-branches — branch list for the general form dropdown
router.get('/lead-branches', leads.publicBranches);
// POST /api/public/lead — submit an inquiry
router.post('/lead', leads.publicSubmit);

module.exports = router;
