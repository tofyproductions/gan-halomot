const express = require('express');
const router = express.Router();
const classroomController = require('../controllers/classroom.controller');

// GET /api/classroom?year=2026
router.get('/', classroomController.getAll);

// POST /api/classroom
router.post('/', classroomController.create);

// PUT /api/classroom/:id
router.put('/:id', classroomController.update);

// DELETE /api/classroom/:id
router.delete('/:id', classroomController.remove);

module.exports = router;
