const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/payroll.controller');
const audit = require('../controllers/payslipAudit.controller');
const direct = require('../controllers/directPayslips.controller');

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
// One press: capture the finger (if we don't hold it yet) and mirror it to every
// branch the employee works at, so a cross-branch worker can punch anywhere.
router.post('/employees/:id/sync-fingerprint', requireRole('system_admin', 'branch_manager', 'accountant'), c.syncEmployeeFingerprint);
router.get('/employees/:id/fingerprint-status', requireRole('system_admin', 'branch_manager', 'accountant'), c.employeeFingerprintStatus);
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

// Fixed hours (שעות קבועות) — employees paid on a standing weekly schedule
// instead of clocking in. Managers may view/set for their own branches.
router.get('/fixed-schedules',                                 requireRole('system_admin', 'accountant', 'branch_manager'), c.listFixedSchedules);
router.put('/fixed-schedules',                                 requireRole('system_admin', 'accountant'), c.setFixedSchedules);
router.post('/fixed-schedules/materialize',                    requireRole('system_admin', 'accountant'), c.materializeFixedSchedules);
router.delete('/fixed-schedules/:employeeId',                  requireRole('system_admin', 'accountant'), c.clearFixedSchedule);
router.post('/fixed-schedules/:employeeId/exception',          requireRole('system_admin', 'accountant', 'branch_manager'), c.setFixedScheduleException);
router.delete('/fixed-schedules/:employeeId/exception/:date',  requireRole('system_admin', 'accountant', 'branch_manager'), c.removeFixedScheduleException);

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
router.get('/my-payslips/:ym/file',            c.myPayslipFile);
// טופס 101 — filed by the employee, and readable by them for as long as it is
// on file. Every route resolves the employee from the token, so there is no id
// to tamper with.
router.get('/my-form-101',                     c.myForm101);
router.post('/my-form-101',                    c.uploadMyForm101);
router.get('/my-form-101/:id/file',            c.myForm101File);

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
router.post(
  '/payslip-audit/email/preview',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.previewAuditEmail,
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

// Notes already sent to the accountant this month — surfaced while reviewing.
router.get(
  '/payslip-audit/prior-notes',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.getPriorNotes,
);

// ── Correction rounds — the accountant's corrected payslips, graded note by
// note against what we asked for. Same per-branch upload shape as run-multi.
const fixRoundFields = Array.from({ length: 10 }, (_, i) => ({ name: `payslip_file_${i}`, maxCount: 1 }));
router.post(
  '/payslip-audit/history/:id/fix-round',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  auditUpload.fields(fixRoundFields),
  audit.createFixRound,
);
router.get(
  '/payslip-audit/history/:id/fix-rounds',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.listFixRounds,
);
router.patch(
  '/payslip-audit/history/:id/fix-rounds/:roundNo/verdict',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.setFixVerdict,
);
router.post(
  '/payslip-audit/history/:id/notes',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.addAuditNote,
);
router.post(
  '/payslip-audit/history/:id/fix-rounds/:roundNo/approve',
  requireRole('system_admin', 'accountant'),
  audit.approveFixRound,
);
router.get(
  '/payslip-audit/history/:id/fix-rounds/:roundNo/page',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  audit.getFixRoundPage,
);
// The accountant's own upload link — minting it is an admin action.
router.post(
  '/payslip-audit/history/:id/fix-token',
  requireRole('system_admin', 'accountant'),
  audit.createFixToken,
);
router.delete(
  '/payslip-audit/history/:id/fix-token',
  requireRole('system_admin', 'accountant'),
  audit.revokeFixToken,
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

// ── Direct payslip distribution — a final file sent without an audit ────────
// Same delivery as the audit path (mail + archive + mark paid); what it skips
// is the comparison, which a verified file or a single forgotten page has
// nothing to gain from. Accountant/admin only: this sends real payslips with
// no round to approve first.
const DIRECT = requireRole('system_admin', 'accountant');
router.post('/direct-payslips', DIRECT, auditUpload.single('payslip_file'), direct.upload);
router.get('/direct-payslips', DIRECT, direct.list);
router.get('/direct-payslips/:id', DIRECT, direct.get);
router.get('/direct-payslips/:id/page/:page', DIRECT, direct.pagePreview);
router.put('/direct-payslips/:id/pages/:page', DIRECT, direct.assignPage);
router.post('/direct-payslips/:id/send', DIRECT, direct.send);
router.delete('/direct-payslips/:id', DIRECT, direct.remove);

module.exports = router;
