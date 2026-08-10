const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');

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
// טופס 101 — the roster view, the mail scan and its review queue
router.use('/form-101', require('./form101.routes'));
// Class tracking (מעקב חוגים) — providers, programs, sessions + occurrence popup
router.use('/classes', require('./classes.routes'));
// Maintenance (אחזקה) — assets per branch with service cycles + fault reports
router.use('/maintenance', require('./maintenance.routes'));
// Gan events (אירועים) — manager builds a bring-list, parents claim items via a
// public link. Manager side here; the parent-facing side lives under /public.
router.use('/gan-events', require('./ganEvents.routes'));
// Leads (פניות הורים) — manager side; the public inquiry form lives under /public.
router.use('/leads', require('./leads.routes'));

// Everything below requires a logged-in user.
//
// This was `optionalAuth` — "backward compatible, works without login too" —
// which in practice meant the whole application was readable AND writable by
// anyone with the URL: an unauthenticated GET /api/collections returned every
// child's name, their parent's name and the family's fees. The only genuinely
// anonymous surfaces are /api/public (parent + employee token links),
// /api/auth, /api/utils and /api/agent (Pi agents, own shared-secret header),
// and all four are mounted ABOVE this line.
router.use(authMiddleware);
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
router.use('/employee-letters', require('./employeeLetters.routes'));
router.use('/employment-contracts', require('./employmentContracts.routes'));
router.use('/cibus-sync', require('./cibusSync.routes'));
router.use('/stock', require('./stock.routes'));

// Sync endpoint
const syncController = require('../controllers/sync.controller');
router.post('/sync', syncController.syncFromSheets);
router.post('/sync/check', syncController.syncCheck);

module.exports = router;
