const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/employeeRequests.controller');

router.use(authMiddleware);

// Employee self-service
router.get('/my', c.getMyRequests);
router.post('/', c.createRequest);

// Manager endpoints
router.get('/', requireRole('system_admin', 'branch_manager'), c.getAllRequests);
router.put('/:id/status', requireRole('system_admin', 'branch_manager'), c.updateRequestStatus);

module.exports = router;
