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
// Employee requests (vacation, sick leave)
router.use('/employee-requests', require('./employeeRequests.routes'));

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

// Sync endpoint
const syncController = require('../controllers/sync.controller');
router.post('/sync', syncController.syncFromSheets);

module.exports = router;
