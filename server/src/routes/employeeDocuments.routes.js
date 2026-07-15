const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/employeeDocuments.controller');

router.use(authMiddleware);
router.use(requireRole('system_admin', 'branch_manager', 'accountant'));

router.get('/', c.list);
router.post('/', c.create);
router.get('/:id/file', c.getFile);
router.put('/:id', c.update);
router.post('/:id/acknowledge', c.acknowledge);
router.delete('/:id', c.remove);

module.exports = router;
