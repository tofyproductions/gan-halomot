const express = require('express');
const router = express.Router();
const archiveController = require('../controllers/archive.controller');

// GET /api/archive?type=children&year=2026
router.get('/', archiveController.getAll);

// POST /api/archive
router.post('/', archiveController.archive);

// POST /api/archive/:id/restore
router.post('/:id/restore', archiveController.restore);

// DELETE /api/archive/:id
router.delete('/:id', archiveController.remove);

module.exports = router;
