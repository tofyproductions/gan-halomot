const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/payroll.controller');

// All payroll routes require an authenticated user with at least branch_manager.
router.use(authMiddleware);

// Employees (payroll)
router.get('/employees',            c.listEmployees);
router.get('/employees/:id',        c.getEmployee);
router.post('/employees',           requireRole('system_admin', 'branch_manager'), c.createEmployee);
router.put('/employees/:id',        requireRole('system_admin', 'branch_manager'), c.updateEmployee);
router.delete('/employees/:id',     requireRole('system_admin', 'branch_manager'), c.removeEmployee);

// Attendance & hours
router.get('/attendance',                      c.attendanceByMonth);
router.get('/employees/:id/hours-report',      c.hoursReport);

module.exports = router;
