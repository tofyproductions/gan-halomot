const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authMiddleware, requireRole, requireBranchScope } = require('../middleware/auth');
const c = require('../controllers/payrollMonth.controller');

// In-memory upload for Cibus xlsx/csv imports. 10MB cap covers a typical month.
const cibusUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

router.use(authMiddleware);

// Monthly payroll table — branch_manager has READ access only.
// Edits go through pending change-request flow (see /change-requests below).
router.get('/',                               c.getMonth);

// The same month, one row per unit reporting to the viewer instead of one row
// per employee. Declared before the /:param routes below, and separate from
// getMonth on purpose: a network director and a branch manager are asking two
// different questions, and answering the director's with the branch manager's
// query is what takes thirty seconds at four hundred branches.
router.get('/rollup',                         require('../controllers/payrollRollup.controller').rollup);

// Accountant contact list (recipients of the monthly send) + office copy address.
// Literal paths — declared before the /:param routes below.
router.get('/accountant-contacts',            requireRole('system_admin', 'accountant'), c.getAccountantContacts);
router.put('/accountant-contacts',            requireRole('system_admin', 'accountant'), c.setAccountantContacts);
// Standing "fill in your branch's missing punches" assignments. `mine` is what
// the branch manager's login gate polls; completing is theirs to do.
router.get('/punch-entry-tasks/mine',         c.myPunchEntryTasks);
router.post('/punch-entry-tasks/:id/done',    requireRole('system_admin', 'accountant', 'branch_manager'), c.completePunchEntryTask);
// A branch manager labels her own branches' >2-punch days; the controller
// stores hers as `pending` until accounting confirms (models/PunchResolution).
router.post('/punch-resolutions',              requireRole('system_admin', 'accountant', 'branch_manager'), c.resolvePunchDay);
router.delete('/punch-resolutions',            requireRole('system_admin', 'accountant'), c.unresolvePunchDay);
// בונוס אוגוסט — the edit dialog's per-day candidate list. Literal path,
// before the /:param routes.
router.get('/closure-candidates/:employeeId', requireRole('system_admin', 'accountant'), c.getClosureCandidates);
// ימים מיוחדים — employer-declared closures. Literal paths, before /:param.
router.get('/special-days',                   c.listSpecialDays);
router.post('/special-days',                  requireRole('system_admin', 'accountant'), c.createSpecialDay);
router.patch('/special-days/:id',             requireRole('system_admin', 'accountant'), c.updateSpecialDay);
router.delete('/special-days/:id',            requireRole('system_admin', 'accountant'), c.deleteSpecialDay);
router.get('/pregnancy-settings',             requireRole('system_admin', 'accountant', 'branch_manager'), c.getPregnancySettings);
router.put('/pregnancy-settings',             requireRole('system_admin', 'accountant'), c.setPregnancySettings);

// The branch manager's own area: her staff and the updates she may file, with
// none of the salary table around it.
router.get('/my-updates',                     requireBranchScope, c.myPayrollUpdates);
// Loaded on demand — it recomputes the month, which is the expensive part.
router.get('/my-updates/absences',            requireBranchScope, c.myUpdateAbsences);
// The employee's clock days, with the problems marked — this is what replaced
// "תיקון דיווח שעות" as a thing a manager types.
router.get('/my-updates/punches',             requireBranchScope, c.myUpdatePunches);

// Change-request workflow: branch managers stage edits → accountant approves.
router.post('/change-requests',               requireBranchScope, c.createChangeRequest);
router.get('/change-requests',                requireBranchScope, c.listChangeRequests);
router.post('/change-requests/:id/decide',    requireRole('system_admin', 'accountant'), c.decideChangeRequest);

// accountant/admin edit any field; branch_manager may set ONLY the manager
// supplement-approval flag for their own branches (enforced in the controller).
router.patch('/:employeeId',                  requireRole('system_admin', 'accountant', 'branch_manager'), c.upsertEntry);
router.get('/:month/punch-issues',            requireRole('system_admin', 'accountant', 'branch_manager'), c.punchReviewStatus);
router.get('/:month/punch-review-status',     requireRole('system_admin', 'accountant', 'branch_manager'), c.punchReviewStatus);
// Nudge a branch's manager(s) to complete their staff's missing punches.
router.post('/:month/punch-issues/remind',    requireRole('system_admin', 'accountant'), c.remindBranchManager);
// Same nudge, but it leaves a task the manager must face on their next login.
router.post('/:month/punch-issues/assign',    requireRole('system_admin', 'accountant'), c.assignPunchEntry);
// Decide a day where a fixed-hours employee also clocked in.
router.post('/:month/punch-issues/fixed-conflict', requireRole('system_admin', 'accountant'), c.resolveFixedConflict);
// Split a day she opened at one branch and closed at another. Branch managers
// may propose it; the controller stores theirs as pending (models/PunchResolution).
router.post('/:month/punch-issues/split-branch', requireRole('system_admin', 'accountant', 'branch_manager'), c.splitCrossBranchDay);
router.post('/:month/finalize',               requireRole('system_admin', 'accountant'), c.finalizeMonth);
// Preview the accountant PDF (no send) — drives the preview dialog.
router.get('/:month/accountant-preview',      requireRole('system_admin', 'accountant'), c.previewAccountant);
// Email the month's salary table + supporting files to the accountant.
router.post('/:month/send-accountant',        requireRole('system_admin', 'accountant'), c.sendToAccountant);
router.post('/:month/reopen',                 requireRole('system_admin', 'accountant'), c.reopenMonth);

// Preset options for the dropdown-style fields (advance_deduction etc.)
router.get('/presets',                        c.listPresets);
router.post('/presets',                       requireRole('system_admin', 'accountant'), c.createPreset);
router.patch('/presets/:id',                  requireRole('system_admin', 'accountant'), c.updatePreset);
router.delete('/presets/:id',                 requireRole('system_admin', 'accountant'), c.deletePreset);

// Amuta admin (legal entities + branch mapping)
router.get('/amutot',                         c.listAmutot);
router.put('/amutot/:id',                     requireRole('system_admin'), c.upsertAmuta);
router.put('/branches/:branchId/amuta',       requireRole('system_admin'), c.setBranchAmuta);

// Custom columns — admin-added per-month columns (text / number / number_or_text)
router.get('/custom-columns',                 c.listCustomColumns);
router.post('/custom-columns',                requireRole('system_admin', 'accountant'), c.createCustomColumn);
router.patch('/custom-columns/:id',           requireRole('system_admin', 'accountant'), c.updateCustomColumn);
router.delete('/custom-columns/:id',          requireRole('system_admin', 'accountant'), c.deleteCustomColumn);

// Salary adjustments — credits/debits/hour corrections.
//
// A branch manager may ADD (the controller files hers as `pending`, scoped to
// her own branches, and only `approved` rows reach a salary). She may not edit
// or delete: a filed request is a record, and withdrawing it is the
// accountant's rejection rather than the manager's eraser.
router.get('/adjustments',                    c.listAdjustments);
router.post('/adjustments',                   requireBranchScope, c.createAdjustment);
router.post('/adjustments/decide-bulk',       requireRole('system_admin', 'accountant'), c.decideAdjustmentsBulk);
router.post('/adjustments/:id/decide',        requireRole('system_admin', 'accountant'), c.decideAdjustment);
router.patch('/adjustments/:id',              requireRole('system_admin', 'accountant'), c.updateAdjustment);
router.delete('/adjustments/:id',             requireRole('system_admin', 'accountant'), c.deleteAdjustment);

// Cibus import — uploads a monthly Pluxee report and writes each employee's
// total into PayrollMonth.manual.cibus.
router.post('/import-cibus',
  requireRole('system_admin', 'accountant'),
  cibusUpload.single('cibus_file'),
  c.importCibus,
);

// Bulk apply: auto-fill דמי חגים for every eligible hourly employee in scope.
router.post('/:month/apply-auto-holidays',
  requireRole('system_admin', 'accountant'),
  c.applyAutoHolidays,
);

// Bulk apply: re-sync approved vacation requests into manual.vacation_days.
router.post('/:month/apply-vacation-requests',
  requireRole('system_admin', 'accountant'),
  c.applyVacationRequests,
);

// Bulk apply: fill vacation_days from kindergarten holiday calendar.
router.post('/:month/apply-kindergarten-vacation',
  requireRole('system_admin', 'accountant'),
  c.applyKindergartenVacationDays,
);

module.exports = router;
