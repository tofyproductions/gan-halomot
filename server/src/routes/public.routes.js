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

// --- Gan events (parent bring-list, no auth) ---
// GET /api/public/event/:token?claimant_id=&phone=
router.get('/event/:token', publicController.getEvent);
// POST /api/public/event/:token/claim   { claimant_id, parent_name, parent_phone, item_name }
router.post('/event/:token/claim', publicController.claimItem);
// POST /api/public/event/:token/release { claimant_id, slot_id, parent_phone }
router.post('/event/:token/release', publicController.releaseItem);

module.exports = router;
