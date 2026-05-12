const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/payrollMonth.controller');

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

module.exports = router;
