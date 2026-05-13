const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/payrollMonth.controller');

// In-memory upload for Cibus xlsx/csv imports. 10MB cap covers a typical month.
const cibusUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

router.use(authMiddleware);

// Monthly payroll table
router.get('/',                               c.getMonth);
router.patch('/:employeeId',                  requireRole('system_admin', 'accountant', 'branch_manager'), c.upsertEntry);
router.post('/:month/finalize',               requireRole('system_admin', 'accountant'), c.finalizeMonth);
router.post('/:month/reopen',                 requireRole('system_admin', 'accountant'), c.reopenMonth);

// Preset options for the dropdown-style fields (advance_deduction etc.)
router.get('/presets',                        c.listPresets);
router.post('/presets',                       requireRole('system_admin', 'accountant', 'branch_manager'), c.createPreset);
router.patch('/presets/:id',                  requireRole('system_admin', 'accountant'), c.updatePreset);
router.delete('/presets/:id',                 requireRole('system_admin', 'accountant'), c.deletePreset);

// Amuta admin (legal entities + branch mapping)
router.get('/amutot',                         c.listAmutot);
router.put('/amutot/:id',                     requireRole('system_admin'), c.upsertAmuta);
router.put('/branches/:branchId/amuta',       requireRole('system_admin'), c.setBranchAmuta);

// Custom columns — admin-added per-month columns (text / number / number_or_text)
router.get('/custom-columns',                 c.listCustomColumns);
router.post('/custom-columns',                requireRole('system_admin', 'accountant', 'branch_manager'), c.createCustomColumn);
router.patch('/custom-columns/:id',           requireRole('system_admin', 'accountant'), c.updateCustomColumn);
router.delete('/custom-columns/:id',          requireRole('system_admin', 'accountant'), c.deleteCustomColumn);

// Salary adjustments — branch-manager-level credits/debits/hour corrections
router.get('/adjustments',                    c.listAdjustments);
router.post('/adjustments',                   requireRole('system_admin', 'accountant', 'branch_manager'), c.createAdjustment);
router.patch('/adjustments/:id',              requireRole('system_admin', 'accountant', 'branch_manager'), c.updateAdjustment);
router.delete('/adjustments/:id',             requireRole('system_admin', 'accountant', 'branch_manager'), c.deleteAdjustment);

// Cibus import — uploads a monthly Pluxee report and writes each employee's
// total into PayrollMonth.manual.cibus.
router.post('/import-cibus',
  requireRole('system_admin', 'accountant', 'branch_manager'),
  cibusUpload.single('cibus_file'),
  c.importCibus,
);

// Bulk apply: auto-fill דמי חגים for every eligible hourly employee in scope.
router.post('/:month/apply-auto-holidays',
  requireRole('system_admin', 'accountant', 'branch_manager'),
  c.applyAutoHolidays,
);

// Bulk apply: re-sync approved vacation requests into manual.vacation_days.
router.post('/:month/apply-vacation-requests',
  requireRole('system_admin', 'accountant', 'branch_manager'),
  c.applyVacationRequests,
);

// Bulk apply: fill vacation_days from kindergarten holiday calendar.
router.post('/:month/apply-kindergarten-vacation',
  requireRole('system_admin', 'accountant', 'branch_manager'),
  c.applyKindergartenVacationDays,
);

module.exports = router;
