const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/payroll.controller');
const audit = require('../controllers/payslipAudit.controller');

// In-memory uploads — audit files are transient and not persisted.
const auditUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// All payroll routes require an authenticated user with at least branch_manager.
router.use(authMiddleware);

// Employees (payroll)
router.get('/employees',            c.listEmployees);
router.get('/employees/:id',        c.getEmployee);
router.post('/employees',           requireRole('system_admin', 'branch_manager', 'accountant'), c.createEmployee);
router.put('/employees/:id',        requireRole('system_admin', 'branch_manager', 'accountant'), c.updateEmployee);
router.delete('/employees/:id',     requireRole('system_admin', 'branch_manager', 'accountant'), c.removeEmployee);

// Attendance & hours
router.get('/attendance',                      c.attendanceByMonth);
router.get('/employees/:id/hours-report',      c.hoursReport);
router.get('/hours-report-bulk',               c.hoursReportBulk);
router.post('/hours-report/send-managers',     c.sendHoursReportsToManagers);
// Rich monthly hours-report distribution (employees / managers / office / specific email)
router.get('/hours-distribution/preview',           requireRole('system_admin', 'accountant'), audit.hoursDistributionPreview);
router.get('/hours-distribution/preview-html',      requireRole('system_admin', 'accountant'), audit.hoursDistributionPreviewHtml);
router.post('/hours-distribution/send-employees',   requireRole('system_admin', 'accountant'), audit.sendHoursToEmployees);
router.post('/hours-distribution/send-managers',    requireRole('system_admin', 'accountant'), audit.sendHoursToManagers);

// Clock users (matching UI)
router.get('/clock-users',                     c.listClockUsers);
router.post('/clock-users/assign',             requireRole('system_admin', 'branch_manager'), c.assignIsraeliIds);
router.post('/employees/:id/enroll-clock',     requireRole('system_admin', 'branch_manager'), c.enrollEmployeeToClock);
// Cross-branch fingerprint copy — stage 1: READ-ONLY export from the source clock.
router.post('/employees/:id/export-template',  requireRole('system_admin', 'branch_manager'), c.exportEmployeeTemplate);
router.post('/employees/:id/import-template',  requireRole('system_admin', 'branch_manager'), c.importEmployeeTemplate);
// Employee-card edits filed by branch managers, awaiting accountant approval
router.get('/employee-change-requests',        requireRole('system_admin', 'accountant', 'branch_manager'), c.listEmployeeChangeRequests);
router.post('/employee-change-requests/:id/decide', requireRole('system_admin', 'accountant'), c.decideEmployeeChangeRequest);
router.get('/clock-commands/:id',              requireRole('system_admin', 'branch_manager'), c.getClockCommand);

// Salary calculation
router.get('/employees/:id/salary',            c.salaryForEmployee);
router.get('/salary-summary',                  c.salarySummary);

// Manual punch entry / deletion (for corrections)
router.post('/manual-punches',                 requireRole('system_admin', 'branch_manager', 'accountant'), c.createManualPunches);
router.delete('/punches/:id',                  requireRole('system_admin', 'branch_manager', 'accountant'), c.deletePunch);

// Employee commitments (weekly schedules)
const commitments = require('../controllers/commitments.controller');
router.get('/commitments',                     commitments.list);
router.put('/commitments',                     requireRole('system_admin', 'branch_manager', 'accountant'), commitments.upsert);
router.delete('/commitments/:id',              requireRole('system_admin', 'branch_manager', 'accountant'), commitments.remove);
router.post('/commitments/import',             requireRole('system_admin', 'accountant'), commitments.importCsv);
router.post('/commitments/link',               requireRole('system_admin', 'branch_manager', 'accountant'), commitments.linkUnmatched);

// Manual-punch approval workflow
router.post('/punch-requests',                 c.createPunchRequest);
router.get('/punches/pending',                 requireRole('system_admin', 'branch_manager', 'accountant'), c.listPendingPunches);
router.get('/punches/day',                     requireRole('system_admin', 'branch_manager', 'accountant'), c.listPunchesForDay);
router.patch('/punches/:id/approve',           requireRole('system_admin', 'branch_manager', 'accountant'), c.approvePunch);
router.patch('/punches/:id/reject',            requireRole('system_admin', 'branch_manager', 'accountant'), c.rejectPunch);
router.patch('/punches/:id',                   requireRole('system_admin', 'branch_manager', 'accountant'), c.editPunch);

// Employee self-service (any authenticated user)
router.get('/my-salary-preview',               c.mySalaryPreview);
router.get('/my-punches',                      c.myPunches);
router.get('/my-payslips',                     c.myPayslips);

// ── Payslip audit (admin only) — upload xlsx + PDF, get a comparison report ──
router.post(
  '/payslip-audit/parse-table',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  auditUpload.single('file'),
  audit.parseTable,
);
router.post(
  '/payslip-audit/parse-payslips',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  auditUpload.single('file'),
  audit.parsePayslips,
);
router.post(
  '/payslip-audit/run',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  auditUpload.fields([
    { name: 'table_file', maxCount: 1 },
    { name: 'payslip_file', maxCount: 1 },
  ]),
  audit.runAudit,
);
router.post(
  '/payslip-audit/list-branches',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  auditUpload.single('file'),
  audit.listBranches,
);
router.post(
  '/payslip-audit/run-multi',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  // Allow up to 1 table_file + 10 payslip_file_<i> entries (4 expected, 10 cap is safe)
  // + optional cibus_file (Cibus/Pluxee monthly report).
  auditUpload.fields([
    { name: 'table_file', maxCount: 1 },
    { name: 'cibus_file', maxCount: 1 },
    { name: 'payslip_file_0', maxCount: 1 },
    { name: 'payslip_file_1', maxCount: 1 },
    { name: 'payslip_file_2', maxCount: 1 },
    { name: 'payslip_file_3', maxCount: 1 },
    { name: 'payslip_file_4', maxCount: 1 },
    { name: 'payslip_file_5', maxCount: 1 },
    { name: 'payslip_file_6', maxCount: 1 },
    { name: 'payslip_file_7', maxCount: 1 },
    { name: 'payslip_file_8', maxCount: 1 },
    { name: 'payslip_file_9', maxCount: 1 },
  ]),
  audit.runAuditMulti,
);
router.post(
  '/payslip-audit/run-system',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  // Payslips-only: compared against the in-system salary table for the month.
  auditUpload.fields([
    { name: 'cibus_file', maxCount: 1 },
    { name: 'payslip_file_0', maxCount: 1 },
    { name: 'payslip_file_1', maxCount: 1 },
    { name: 'payslip_file_2', maxCount: 1 },
    { name: 'payslip_file_3', maxCount: 1 },
    { name: 'payslip_file_4', maxCount: 1 },
    { name: 'payslip_file_5', maxCount: 1 },
    { name: 'payslip_file_6', maxCount: 1 },
    { name: 'payslip_file_7', maxCount: 1 },
    { name: 'payslip_file_8', maxCount: 1 },
    { name: 'payslip_file_9', maxCount: 1 },
  ]),
  audit.runAuditSystem,
);
router.post(
  '/payslip-audit/email',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.emailAudit,
);
router.get(
  '/payslip-audit/email/defaults',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.getDefaultRecipients,
);

// Audit history (saved runs)
router.get(
  '/payslip-audit/history',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.listAuditHistory,
);
router.get(
  '/payslip-audit/history/:id',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.getAuditFromHistory,
);
router.delete(
  '/payslip-audit/history/:id',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.deleteAuditFromHistory,
);
router.patch(
  '/payslip-audit/history/:id/edits',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.saveAuditEdits,
);
router.get(
  '/payslip-audit/history/:id/payslip-page',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.getPayslipPage,
);
router.get(
  '/payslip-audit/employee-history',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.getEmployeeHistory,
);
router.get(
  '/payslip-audit/cycle-progression',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.getCycleProgression,
);
// Approval workflow — accepts up to 10 corrected payslip PDFs
router.patch(
  '/payslip-audit/history/:id/approve',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  auditUpload.fields([
    { name: 'approved_payslip_0', maxCount: 1 },
    { name: 'approved_payslip_1', maxCount: 1 },
    { name: 'approved_payslip_2', maxCount: 1 },
    { name: 'approved_payslip_3', maxCount: 1 },
    { name: 'approved_payslip_4', maxCount: 1 },
    { name: 'approved_payslip_5', maxCount: 1 },
    { name: 'approved_payslip_6', maxCount: 1 },
    { name: 'approved_payslip_7', maxCount: 1 },
    { name: 'approved_payslip_8', maxCount: 1 },
    { name: 'approved_payslip_9', maxCount: 1 },
  ]),
  audit.approveAudit,
);
// Payslip distribution — email each employee their payslip + hours report,
// and a consolidated bundle to each branch manager.
router.get(
  '/payslip-audit/branch-manager-emails',
  requireRole('system_admin', 'accountant'),
  audit.getBranchManagerEmails,
);
router.put(
  '/payslip-audit/branch-manager-emails',
  requireRole('system_admin', 'accountant'),
  audit.setBranchManagerEmails,
);
router.get(
  '/payslip-audit/history/:id/distribution-preview',
  requireRole('system_admin', 'accountant'),
  audit.distributionPreview,
);
router.put(
  '/payslip-audit/employees/emails',
  requireRole('system_admin', 'accountant'),
  audit.updateEmployeeEmails,
);
router.post(
  '/payslip-audit/history/:id/send-employees',
  requireRole('system_admin', 'accountant'),
  audit.sendPayslipsToEmployees,
);
router.patch(
  '/payslip-audit/history/:id/month',
  requireRole('system_admin', 'accountant'),
  audit.updateAuditMonth,
);
router.get(
  '/payslip-audit/history/:id/manager-preview',
  requireRole('system_admin', 'accountant'),
  audit.managerDistributionPreview,
);
router.get(
  '/payslip-audit/history/:id/hours-preview',
  requireRole('system_admin', 'accountant'),
  audit.hoursReportPreview,
);
router.get(
  '/payslip-audit/history/:id/branch-pdf',
  requireRole('system_admin', 'accountant'),
  audit.branchPdfPreview,
);
router.post(
  '/payslip-audit/history/:id/send-managers',
  requireRole('system_admin', 'accountant'),
  audit.sendPayslipsToManagers,
);
// Saved (archived) payslips per employee — produced when payslips are sent to
// employees. List / download one / export several merged.
router.get(
  '/employees/:id/saved-payslips',
  requireRole('system_admin', 'accountant', 'branch_manager'),
  audit.listSavedPayslips,
);
router.get(
  '/employees/:id/saved-payslips/:ym/pdf',
  requireRole('system_admin', 'accountant', 'branch_manager'),
  audit.downloadSavedPayslip,
);
router.post(
  '/employees/:id/saved-payslips/export',
  requireRole('system_admin', 'accountant', 'branch_manager'),
  audit.exportSavedPayslips,
);
router.patch(
  '/payslip-audit/history/:id/unapprove',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.unapproveAudit,
);

module.exports = router;
