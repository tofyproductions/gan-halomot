const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/employeeDocuments.controller');

/**
 * A scan of a recommendation or a ת"ז arrives as a file, not as a base64
 * string inside JSON. Held in memory because it is forwarded straight to
 * object storage — Render's disk is ephemeral, so a temp file is a bug waiting
 * for a deploy. The limit here is the outer one; the controller applies the
 * real ceiling, which is lower when no bucket is configured.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: c.MAX_STORED_FILE_BYTES, files: 1 },
});

/** multer refuses before the controller runs, and does it in English. */
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
router.use(requireRole('system_admin', 'branch_manager', 'accountant'));

router.get('/', c.list);
router.post('/', upload.single('file'), uploadErrors, c.create);
router.get('/:id/file', c.getFile);
router.get('/:id/download', c.download);
router.put('/:id', c.update);
router.post('/:id/acknowledge', c.acknowledge);
router.delete('/:id', c.remove);

module.exports = router;
