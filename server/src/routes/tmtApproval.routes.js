const express = require('express');
const multer = require('multer');
const router = express.Router();
const ctrl = require('../controllers/tmtApproval.controller');
const { requireRole } = require('../middleware/auth');

// 10MB is generous for a spreadsheet — the ministry's 74-row export is 31KB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Uploading a ministry list changes who is considered enrolled next year, and
// applying the comparison marks children out of the intake queue. Both are
// admin/accountant work. A branch manager reads the comparison for her own gan.
router.post('/import', requireRole('system_admin', 'accountant'), upload.single('file'), ctrl.importFile);
router.post('/apply', requireRole('system_admin', 'accountant'), ctrl.apply);

// Static paths before /:id, so "reconcile" is not read as an id.
router.get('/reconcile/export', ctrl.exportReconcile);
router.get('/reconcile', ctrl.reconcileBranch);
router.get('/approvals', ctrl.listApprovals);
router.get('/contacts', ctrl.contacts);
router.get('/imports', ctrl.listImports);

// Undoing a whole upload. Deliberately admin/accountant only: it removes the
// ministry's answer for a whole gan and a whole year in one call.
router.delete('/data', requireRole('system_admin', 'accountant'), ctrl.deleteData);
router.delete('/approvals/:id', requireRole('system_admin', 'accountant'), ctrl.removeApproval);

module.exports = router;
