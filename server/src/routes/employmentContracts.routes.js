const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/employmentContracts.controller');
const multer = require('multer');

/**
 * A scanned contract arrives as a file, not as a base64 string inside JSON.
 *
 * Held in memory because it is forwarded straight to object storage — Render's
 * disk is ephemeral, so a temp file is a bug waiting for a deploy. The limit
 * here is the outer one; the controller applies the real ceiling, which is
 * lower when no bucket is configured and the file has to live in the document.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: c.MAX_STORED_FILE_BYTES, files: 1 },
});

/** multer rejects before the controller runs, and does it in English. */
function uploadErrors(err, _req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: `הקובץ גדול מדי. המקסימום הוא ${(c.MAX_STORED_FILE_BYTES / 1024 / 1024).toFixed(0)}MB.`,
    });
  }
  if (err) return res.status(400).json({ error: err.message });
  next();
}

router.use(authMiddleware);
// A branch manager sets up her own hires; only accounting/admin confirm.
router.use(requireRole('system_admin', 'accountant', 'branch_manager'));

router.get('/', c.list);
// Static paths before '/:id/...' so they aren't read as ids.
router.get('/status', c.statusMap);
router.get('/annexes', c.listAnnexes);
router.post('/annexes', c.uploadAnnex);
router.get('/annexes/:id/file', c.annexFile);
router.get('/context/:employeeId', c.getContext);
// תנאי העסקה — accountant/admin only, enforced in the controller (this router
// deliberately admits branch managers so they can file their own hires).
router.get('/terms/:employeeId', c.termsHistory);
router.post('/terms/preview', c.previewTerms);
router.post('/terms', c.saveTerms);
router.post('/preview', c.preview);
router.post('/waive', c.waive);
router.post('/upload', upload.single('file'), uploadErrors, c.upload);
router.post('/', c.create);
router.post('/:id/send', c.send);
router.post('/:id/approve', c.approve);
router.get('/:id/file', c.file);

module.exports = router;
