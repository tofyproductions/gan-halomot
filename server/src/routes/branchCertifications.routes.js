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
router.get('/:id/file', c.getFile);
router.post('/:id/renew', c.renew);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;
