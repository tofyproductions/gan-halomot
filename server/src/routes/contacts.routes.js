const express = require('express');
const router = express.Router();
const contactsController = require('../controllers/contacts.controller');

// GET /api/contacts/pdf?classroom=aleph
router.get('/pdf', contactsController.generatePdf);

module.exports = router;
