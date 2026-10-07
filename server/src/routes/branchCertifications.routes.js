const express = require('express');
const router = express.Router();
const {
  requireRole, requireTab, requireTabWrite, tabDecision,
} = require('../middleware/auth');
const c = require('../controllers/branchCertifications.controller');

/**
 * Guarded by the SCREEN, not by the role.
 *
 * This was requireRole(system_admin, branch_manager, accountant), and the
 * permissions screen does not work that way: the office handed אישורי מעון to
 * the back-office role, whose base is a teacher's, and the person who files
 * every certificate in the gan clicked the menu item and was thrown back to
 * the dashboard. The menu said yes and the route said no.
 *
 * Reading follows the tab grant. Changing follows a separate write grant,
 * `branch_certifications_write` — seeing the licence folder and editing it are
 * two permissions. Whoever holds the write grant works across every branch:
 * the person filing the folder files it for all of them, and scoping her to
 * the one branch her account happens to hang off would grant the job and then
 * refuse the work.
 */
const ROLES = ['system_admin', 'branch_manager', 'accountant'];
const READ = requireTab('branch_certifications', ...ROLES);
const WRITE = requireTabWrite('branch_certifications', ...ROLES);
const widenForWriter = (req, _res, next) => {
  if (tabDecision(req.user, 'branch_certifications_write') === 'allow') req.tabWriteGrant = true;
  next();
};

// Mounted below the global authMiddleware in routes/index.js.
router.use(READ, widenForWriter);

router.get('/', c.list);
router.post('/', WRITE, c.create);
// Who the expiry digest writes to. Editing the list is the office's call.
router.get('/alert-recipients', c.getRecipients);
router.put('/alert-recipients', requireRole('system_admin', 'accountant'), c.setRecipients);
// Reading the certificates out of Drive. The scan WRITES NOTHING — it returns
// proposals a person approves, because a certificate filed under the wrong
// branch is a branch that looks covered and is not.
router.get('/drive/folders', c.getDriveFolders);
router.put('/drive/folders', requireRole('system_admin', 'accountant'), c.setDriveFolders);
router.get('/drive/scan', c.scanDrive);
router.post('/drive/import', WRITE, c.importFromDrive);

// The whole folder as one PDF — cover page, then the certificates themselves.
router.get('/:branchId/portfolio.pdf', c.portfolioPdf);

router.get('/:id/file', c.getFile);
router.post('/:id/renew', WRITE, c.renew);
router.put('/:id', WRITE, c.update);
router.delete('/:id', WRITE, c.remove);

module.exports = router;
