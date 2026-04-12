const express = require('express');
const multer = require('multer');
const router = express.Router();
const documentsController = require('../controllers/documents.controller');

const upload = multer({ storage: multer.memoryStorage() });

// GET /api/documents/:registrationId
router.get('/:registrationId', documentsController.getByRegistration);

// POST /api/documents/upload
router.post('/upload', upload.single('file'), documentsController.upload);

// GET /api/documents/:id/download
router.get('/:id/download', documentsController.download);

module.exports = router;
