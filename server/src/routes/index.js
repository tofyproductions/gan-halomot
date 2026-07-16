const router = require('express').Router();
const { optionalAuth } = require('../middleware/auth');

// Public routes (no auth required)
router.use('/auth', require('./auth.routes'));
router.use('/public', require('./public.routes'));
router.use('/utils', require('./utils.routes'));

// Pi agent routes — authenticated with per-branch X-Agent-Secret header,
// NOT with the normal JWT flow used by the web client.
router.use('/agent', require('./agent.routes'));

// Protected routes that require auth for employees/salary
router.use('/employees', require('./employee.routes'));
router.use('/salary-requests', require('./salary.routes'));
// Payroll (TIMEDOX replacement) — CRUD for Employee model + attendance
router.use('/payroll', require('./payroll.routes'));
// Monthly payroll table — per-amuta breakdown + manual fields (sick, vacation, etc.)
router.use('/payroll-month', require('./payrollMonth.routes'));
// Employee requests (vacation, sick leave)
router.use('/employee-requests', require('./employeeRequests.routes'));
// Employee documents — files attached to an employee from the salary table
router.use('/employee-documents', require('./employeeDocuments.routes'));
// Class tracking (מעקב חוגים) — providers, programs, sessions + occurrence popup
router.use('/classes', require('./classes.routes'));
// Maintenance (אחזקה) — assets per branch with service cycles + fault reports
router.use('/maintenance', require('./maintenance.routes'));

// All other routes use optional auth (backward compatible - works without login too)
router.use(optionalAuth);
router.use('/branches', require('./branch.routes'));
router.use('/dashboard', require('./dashboard.routes'));
router.use('/children', require('./children.routes'));
router.use('/registrations', require('./registration.routes'));
router.use('/contracts', require('./contracts.routes'));
router.use('/collections', require('./collections.routes'));
router.use('/archives', require('./archive.routes'));
router.use('/contacts', require('./contacts.routes'));
router.use('/classrooms', require('./classroom.routes'));
router.use('/documents', require('./documents.routes'));
router.use('/holidays', require('./holiday.routes'));
router.use('/activities', require('./activity.routes'));
router.use('/gantt', require('./gantt.routes'));
router.use('/suppliers', require('./supplier.routes'));
router.use('/products', require('./product.routes'));
router.use('/orders', require('./order.routes'));
router.use('/discounts', require('./discount.routes'));
router.use('/branch-pricing', require('./branchPricing.routes'));
router.use('/admin', require('./admin.routes'));
router.use('/stock', require('./stock.routes'));

// Sync endpoint
const syncController = require('../controllers/sync.controller');
router.post('/sync', syncController.syncFromSheets);
router.post('/sync/check', syncController.syncCheck);

module.exports = router;
