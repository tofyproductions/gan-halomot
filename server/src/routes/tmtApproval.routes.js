const express = require('express');
const multer = require('multer');
const router = express.Router();
const ctrl = require('../controllers/tmtApproval.controller');
const { requireTabWrite } = require('../middleware/auth');

// Everything here belongs to one screen — רישום לאמונה, tab id 'clicktac'.
// Reading the screen follows the tab the permissions screen handed out.
// ACTING on it still needs one of the roles below — a granted tab on its own
// is read-only until the app grows a permission for the actions themselves.
const allow = (...roles) => requireTabWrite('clicktac', ...roles);

// 10MB is generous for a spreadsheet — the ministry's 74-row export is 31KB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Uploading a ministry list changes who is considered enrolled next year, and
// applying the comparison marks children out of the intake queue. Both are
// admin/accountant work. A branch manager reads the comparison for her own gan.
router.post('/import', allow('system_admin', 'accountant'), upload.single('file'), ctrl.importFile);
router.post('/apply', allow('system_admin', 'accountant'), ctrl.apply);

// Static paths before /:id, so "reconcile" is not read as an id.
router.get('/reconcile/export', ctrl.exportReconcile);
router.get('/reconcile', ctrl.reconcileBranch);
router.get('/approvals', ctrl.listApprovals);
router.get('/contacts', ctrl.contacts);
router.get('/imports', ctrl.listImports);
// The placement board, and the confirm that turns it into real registrations.
router.get('/placement', ctrl.placement);
router.post('/placement/confirm', allow('system_admin', 'accountant', 'branch_manager'), ctrl.confirmPlacement);

// Undoing a whole upload. Deliberately admin/accountant only: it removes the
// ministry's answer for a whole gan and a whole year in one call.
router.delete('/data', allow('system_admin', 'accountant'), ctrl.deleteData);
router.delete('/approvals/:id', allow('system_admin', 'accountant'), ctrl.removeApproval);

module.exports = router;
