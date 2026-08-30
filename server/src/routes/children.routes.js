const express = require('express');
const router = express.Router();
const childrenController = require('../controllers/children.controller');

const { requireRole } = require('../middleware/auth');
const manage = requireRole('system_admin', 'branch_manager', 'accountant');

// GET /api/children
router.get('/', childrenController.getAll);

// הסרה זמנית — declared before /:id so 'hidden' is not read as an id.
router.get('/hidden', manage, childrenController.listHidden);
router.post('/:id/hide', manage, childrenController.hide);
router.post('/:id/unhide', manage, childrenController.unhide);

// GET /api/children/:id
router.get('/:id', childrenController.getById);

// PUT /api/children/:id
router.put('/:id', childrenController.update);

// PUT /api/children/:id/classroom
router.put('/:id/classroom', childrenController.updateClassroom);

// DELETE /api/children/:id
router.delete('/:id', childrenController.remove);

module.exports = router;
