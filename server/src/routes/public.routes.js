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
const { publicFormLimiter } = require('../middleware/rateLimit');
const leads = require('../controllers/leads.controller');
// GET /api/public/lead-branches — branch list for the general form dropdown
router.get('/lead-branches', leads.publicBranches);
// POST /api/public/lead — submit an inquiry
router.post('/lead', publicFormLimiter, leads.publicSubmit);

// --- דרושים (public hiring page, no auth) ---
//
// The form at the bottom of /careers. A paid campaign points at that page, so
// this is the one write endpoint in the system that strangers are actively
// invited to use — hence the limiter, and hence the CV going through its own
// multer instance with a hard ceiling rather than the unbounded one above.
const careers = require('../controllers/careers.controller');
const cvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: careers.MAX_CV_BYTES, files: 1 },
});
function cvUploadErrors(err, _req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'הקובץ גדול מדי — עד 8MB' });
  }
  if (err) return res.status(400).json({ error: 'שגיאה בצירוף הקובץ' });
  next();
}
router.get('/careers/branches', careers.publicBranches);
router.post('/careers/apply', publicFormLimiter, cvUpload.single('cv'), cvUploadErrors, careers.publicApply);

// --- רישום עובד/ת חדש/ה (public, no auth) ---
//
// The link is permanent and pasted into WhatsApp, so it WILL be forwarded.
// Nothing here creates an employee: a submission is a row waiting for a human
// (see the controller), and the rate limit is the same one the other two
// public forms share.
const onboarding = require('../controllers/employeeOnboarding.controller');
const onboardingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: onboarding.MAX_FILE_BYTES, files: onboarding.MAX_FILES },
});
function onboardingUploadErrors(err, _req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'קובץ גדול מדי — עד 8MB למסמך' });
  }
  if (err && err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: `אפשר לצרף עד ${onboarding.MAX_FILES} מסמכים` });
  }
  if (err) return res.status(400).json({ error: 'שגיאה בצירוף המסמכים' });
  next();
}
router.get('/employee-registration/branches', onboarding.publicBranches);
router.post(
  '/employee-registration',
  publicFormLimiter,
  onboardingUpload.any(),
  onboardingUploadErrors,
  onboarding.publicSubmit,
);

module.exports = router;
