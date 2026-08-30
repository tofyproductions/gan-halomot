const express = require('express');
const router = express.Router();
const classroomController = require('../controllers/classroom.controller');
const { requireRole } = require('../middleware/auth');

// GET /api/classroom?year=2026
router.get('/', classroomController.getAll);

// Reading the room list is everyone's (the gantt, the boards); changing the
// rooms themselves is management's. Until now every write here was open to
// any logged-in user.
const manage = requireRole('system_admin', 'branch_manager', 'accountant');

// POST /api/classroom
router.post('/', manage, classroomController.create);

// PUT /api/classroom/:id
router.put('/:id', manage, classroomController.update);

// DELETE /api/classroom/:id
router.delete('/:id', manage, classroomController.remove);

// Opening a year across branches. Preview first — this writes dozens of rows
// and "are you sure" is not an answer to "sure about what".
router.post('/bulk/preview', manage, classroomController.bulkPreview);
router.post('/bulk', manage, classroomController.bulkCreate);

// POST /api/classrooms/cleanup-garbled — deactivate classrooms with corrupted names
router.post('/cleanup-garbled', manage, classroomController.cleanupGarbled);

module.exports = router;
