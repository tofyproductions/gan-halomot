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

// Clock users (matching UI)
router.get('/clock-users',                     c.listClockUsers);
router.post('/clock-users/assign',             requireRole('system_admin', 'branch_manager'), c.assignIsraeliIds);

// Salary calculation
router.get('/employees/:id/salary',            c.salaryForEmployee);
router.get('/salary-summary',                  c.salarySummary);

// Manual punch entry / deletion (for corrections)
router.post('/manual-punches',                 requireRole('system_admin', 'branch_manager'), c.createManualPunches);
router.delete('/punches/:id',                  requireRole('system_admin', 'branch_manager'), c.deletePunch);

// Employee self-service (any authenticated user)
router.get('/my-salary-preview',               c.mySalaryPreview);
router.get('/my-punches',                      c.myPunches);
router.get('/my-payslips',                     c.myPayslips);

module.exports = router;
