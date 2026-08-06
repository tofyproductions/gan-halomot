const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/employmentContracts.controller');

router.use(authMiddleware);
// A branch manager sets up her own hires; only accounting/admin confirm.
router.use(requireRole('system_admin', 'accountant', 'branch_manager'));

router.get('/', c.list);
// Static paths before '/:id/...' so they aren't read as ids.
router.get('/status', c.statusMap);
router.get('/context/:employeeId', c.getContext);
router.post('/preview', c.preview);
router.post('/waive', c.waive);
router.post('/upload', c.upload);
router.post('/', c.create);
router.post('/:id/send', c.send);
router.post('/:id/approve', c.approve);
router.get('/:id/file', c.file);

module.exports = router;
