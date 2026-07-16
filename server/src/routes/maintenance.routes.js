const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/maintenance.controller');

router.use(authMiddleware);
router.use(requireRole('system_admin', 'branch_manager', 'accountant', 'class_leader'));

router.get('/', c.list);
router.post('/', c.create);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

router.post('/:id/faults', c.addFault);
router.put('/:id/faults/:faultId', c.updateFault);
router.get('/:id/faults/:faultId/photo', c.faultPhoto);
router.delete('/:id/faults/:faultId', c.removeFault);

module.exports = router;
