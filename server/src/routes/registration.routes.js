const express = require('express');
const multer = require('multer');
const router = express.Router();
const mongoose = require('mongoose');
const registrationController = require('../controllers/registration.controller');
const { requireRole, requireBranchScope } = require('../middleware/auth');
const { canAccessRegistration } = require('../utils/branch-scope');
const { Registration } = require('../models');

// Network-wide, cross-branch data operations — accounting/admin only.
const dataOps = requireRole('system_admin', 'accountant');

/**
 * The registration file is a management screen — a carer's token opens none
 * of it — and every id in a URL is checked against the caller's branches
 * before any handler runs. Without this, ANY staff token could read any
 * family's full record network-wide, including its public access_token: the
 * credential of the anonymous /api/public/register surface. getById accepts
 * a unique_id as well as an ObjectId, so the guard resolves both spellings.
 */
async function scopedRegistration(req, res, next) {
  try {
    let id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      const reg = await Registration.findOne({ unique_id: id }).select('_id').lean();
      if (!reg) return res.status(404).json({ error: 'רישום לא נמצא' });
      id = reg._id;
      req.params.id = String(id);
    }
    if (!(await canAccessRegistration(req, id))) {
      return res.status(403).json({ error: 'הרישום שייך לסניף שאינו בהרשאותיך' });
    }
    next();
  } catch (e) { next(e); }
}

const upload = multer({ storage: multer.memoryStorage() });

router.use(requireBranchScope);

// GET /api/registration
router.get('/', registrationController.getAll);

// POST /api/registration/fix-orphan-branch — assign null-branch regs to a branch
router.post('/fix-orphan-branch', dataOps, registrationController.fixOrphanBranch);

// POST /api/registration/academic-year/bulk — move many registrations to another
// gan year at once. Declared before /:id so "academic-year" is not read as an id.
router.post('/academic-year/bulk', dataOps, registrationController.bulkSetAcademicYear);

// GET /api/registration/:id
router.get('/:id', scopedRegistration, registrationController.getById);

// POST /api/registration
router.post('/', registrationController.create);

// PUT /api/registration/:id
router.put('/:id', scopedRegistration, registrationController.update);

// PUT /api/registration/:id/academic-year — move this registration to another
// gan year, taking its child record and its collection row with it.
router.put('/:id/academic-year',
  requireRole('system_admin', 'accountant', 'branch_manager'),
  scopedRegistration,
  registrationController.setAcademicYear);

// POST /api/registration/:id/generate-link
router.post('/:id/generate-link', scopedRegistration, registrationController.generateLink);

// POST /api/registration/:id/renew — issue next year's contract for a family
// already in the gan. A registration covers ONE year; when the year turns the
// family needs a new one and a new signature.
router.post('/:id/renew', scopedRegistration, registrationController.renew);

// POST /api/registration/:id/activate
router.post('/:id/activate', scopedRegistration, registrationController.activate);

// POST /api/registration/:id/finalize-manual
router.post('/:id/finalize-manual', scopedRegistration, upload.single('contract_file'), registrationController.finalizeManual);

// GET /api/registration/:id/contract-download
router.get('/:id/contract-download', scopedRegistration, registrationController.downloadContract);

// GET /api/registration/:id/contract-versions
router.get('/:id/contract-versions', scopedRegistration, registrationController.listContractVersions);

// GET /api/registration/contract-versions/:versionId/download
router.get('/contract-versions/:versionId/download', registrationController.downloadContractVersion);

// POST /api/registration/:id/cancel — ביטול רישום: off the rosters, still in
// גבייה until the cancellation debt is settled. Managers may cancel their own.
router.post('/:id/cancel',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  scopedRegistration,
  registrationController.cancel);

// POST /api/registration/:id/settle-billing — the debt is paid; the office
// closes the file and the family drops from גבייה.
router.post('/:id/settle-billing',
  requireRole('system_admin', 'accountant'),
  registrationController.settleBilling);

// DELETE /api/registration/:id — for rows created in error. A real departure
// that owes money goes through /cancel above, or the debt is deleted with it.
router.delete('/:id',
  requireRole('system_admin', 'branch_manager', 'accountant'),
  scopedRegistration,
  registrationController.remove);

module.exports = router;
