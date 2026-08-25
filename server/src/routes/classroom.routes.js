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

// Opening a year across branches. Preview first — this writes dozens of rows
// and "are you sure" is not an answer to "sure about what".
router.post('/bulk/preview', classroomController.bulkPreview);
router.post('/bulk', classroomController.bulkCreate);

// POST /api/classrooms/cleanup-garbled — deactivate classrooms with corrupted names
router.post('/cleanup-garbled', classroomController.cleanupGarbled);

module.exports = router;
