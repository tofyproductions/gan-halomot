const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/employeeRosterImport.controller');

// The roster is a spreadsheet of a hundred rows — kept in memory, never written
// to disk: it carries every employee's ת"ז, telephone and date of birth, and a
// temp file is a copy of that nobody remembers to delete.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(authMiddleware);

// Admin and accounting only. This rewrites identity and leave balances across
// the whole staff — a branch manager may edit her own people, but nobody edits
// ninety-five records from one upload except the two roles that answer for
// payroll.
const GATE = requireRole('system_admin', 'accountant');

router.post('/preview', GATE, upload.single('file'), c.preview);
router.post('/apply', GATE, upload.single('file'), c.apply);

module.exports = router;
