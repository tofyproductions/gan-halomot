const express = require('express');
const multer = require('multer');
const router = express.Router();
const publicController = require('../controllers/public.controller');

const upload = multer({ storage: multer.memoryStorage() });

// GET /api/public/register/:token
router.get('/register/:token', publicController.getRegistrationForm);

// POST /api/public/register/:token/sign
router.post('/register/:token/sign', publicController.submitSignature);

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

module.exports = router;
