const express = require('express');
const router = express.Router();
const childrenController = require('../controllers/children.controller');

const { requireRole } = require('../middleware/auth');
const manage = requireRole('system_admin', 'branch_manager', 'accountant');

// GET /api/children
router.get('/', childrenController.getAll);

// מעברי כיתה ממתינים — what a תינוקייה board asked for, decided by the
// branch manager because the room decides the fee. Before /:id for the same
// reason as 'hidden' below. Accountants may read; only managers and admins
// decide (enforced in the controller).
router.get('/move-requests', manage, childrenController.listMoveRequests);
router.post('/move-requests/:id/approve', manage, childrenController.approveMoveRequest);
router.post('/move-requests/:id/reject', manage, childrenController.rejectMoveRequest);

// הסרה זמנית — declared before /:id so 'hidden' is not read as an id.
router.get('/hidden', manage, childrenController.listHidden);
router.post('/:id/hide', manage, childrenController.hide);
router.post('/:id/unhide', manage, childrenController.unhide);

// GET /api/children/:id
router.get('/:id', childrenController.getById);

// PUT /api/children/:id — editing a child record is a management action.
router.put('/:id', manage, childrenController.update);

// PUT /api/children/:id/classroom
router.put('/:id/classroom', manage, childrenController.updateClassroom);

// DELETE /api/children/:id
router.delete('/:id', manage, childrenController.remove);

module.exports = router;
