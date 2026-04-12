const express = require('express');
const router = express.Router();
const childrenController = require('../controllers/children.controller');

// GET /api/children
router.get('/', childrenController.getAll);

// GET /api/children/:id
router.get('/:id', childrenController.getById);

// PUT /api/children/:id
router.put('/:id', childrenController.update);

// PUT /api/children/:id/classroom
router.put('/:id/classroom', childrenController.updateClassroom);

// DELETE /api/children/:id
router.delete('/:id', childrenController.remove);

module.exports = router;
