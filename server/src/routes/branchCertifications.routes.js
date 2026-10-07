const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');
const c = require('../controllers/branchCertifications.controller');

// Mounted below the global authMiddleware in routes/index.js.
// Branch scoping happens inside the controller, per row, from the DB.
router.use(requireRole('system_admin', 'branch_manager', 'accountant'));

router.get('/', c.list);
router.post('/', c.create);
// Who the expiry digest writes to. Editing the list is the office's call.
router.get('/alert-recipients', c.getRecipients);
router.put('/alert-recipients', requireRole('system_admin', 'accountant'), c.setRecipients);
// Reading the certificates out of Drive. The scan WRITES NOTHING — it returns
// proposals a person approves, because a certificate filed under the wrong
// branch is a branch that looks covered and is not.
router.get('/drive/folders', c.getDriveFolders);
router.put('/drive/folders', requireRole('system_admin', 'accountant'), c.setDriveFolders);
router.get('/drive/scan', c.scanDrive);
router.post('/drive/import', c.importFromDrive);

router.get('/:id/file', c.getFile);
router.post('/:id/renew', c.renew);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;
