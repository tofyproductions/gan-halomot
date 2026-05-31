const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/branchPricing.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Pricing config is an admin/finance area.
router.use(authMiddleware, requireRole('system_admin', 'branch_manager', 'accountant'));

router.post('/parse-tmt-pdf', upload.single('file'), c.parseTmtPdf);
router.get('/', c.getAll);
router.get('/:branchId', c.getForBranch);
router.put('/:branchId', c.upsert);

module.exports = router;
