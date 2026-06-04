const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/employeeRequests.controller');

router.use(authMiddleware);

// Employee self-service
router.get('/my', c.getMyRequests);
router.post('/', c.createRequest);

// Manager / accountant endpoints
router.get('/', requireRole('system_admin', 'branch_manager', 'accountant'), c.getAllRequests);
router.post('/admin', requireRole('system_admin', 'branch_manager', 'accountant'), c.createAdminRequest);
router.post('/sync-sick', requireRole('system_admin', 'branch_manager', 'accountant'), c.syncSickDays);
router.get('/vacation-for-month', requireRole('system_admin', 'branch_manager', 'accountant'), c.listVacationForMonth);
router.get('/sick-for-month', requireRole('system_admin', 'branch_manager', 'accountant'), c.listSickForMonth);
router.get('/pending-for-employee', requireRole('system_admin', 'branch_manager', 'accountant'), c.listPendingForEmployee);
router.get('/:id/medical-file', requireRole('system_admin', 'branch_manager', 'accountant'), c.getMedicalFile);
router.put('/:id/status', requireRole('system_admin', 'branch_manager', 'accountant'), c.updateRequestStatus);
router.put('/:id/admin', requireRole('system_admin', 'branch_manager', 'accountant'), c.editAdminRequest);
router.delete('/:id', requireRole('system_admin', 'branch_manager', 'accountant'), c.deleteRequest);

module.exports = router;
