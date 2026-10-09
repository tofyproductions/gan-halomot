const express = require('express');
const multer = require('multer');
const router = express.Router();
const documentsController = require('../controllers/documents.controller');
const { requireBranchScope } = require('../middleware/auth');

// Accept the document types a registration actually carries — PDFs, images and
// office files — and cap the size at the multer layer so an oversized or
// mislabeled upload is refused before it reaches the controller.
const ALLOWED_DOC_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_DOC_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error('סוג קובץ לא נתמך'));
  },
});

// GET /api/documents/:registrationId
// Parent ID photos and payment proofs — a management read (M3).
router.get('/:registrationId', requireBranchScope, documentsController.getByRegistration);

// POST /api/documents/upload
router.post('/upload', requireBranchScope, upload.single('file'), documentsController.upload);

// GET /api/documents/:id/download
router.get('/:id/download', requireBranchScope, documentsController.download);

module.exports = router;
