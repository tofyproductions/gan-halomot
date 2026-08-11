const express = require('express');
const multer = require('multer');
const router = express.Router();
const ctrl = require('../controllers/externalEnrollment.controller');
const { requireTabWrite } = require('../middleware/auth');

// Same screen as tmtApproval.routes.js — רישום לאמונה, tab id 'clicktac'.
// The tab grants reading; these roles grant acting.
const allow = (...roles) => requireTabWrite('clicktac', ...roles);

// 10MB is generous for a spreadsheet — the 77-row export is 27KB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Importing external enrollments creates registrations and children, so it is
// admin/accountant work. A branch manager reads the queue; she does not file
// seventy families into the system.
router.post('/import', allow('system_admin', 'accountant'), upload.single('file'), ctrl.importFile);

// Static paths before /:id, so "contacts" and "pricing" are not read as ids.
router.get('/contacts', ctrl.contacts);
router.get('/pricing', ctrl.pricing);
router.get('/classroom-plan', ctrl.classroomPlan);
router.post('/classrooms', allow('system_admin', 'accountant'), ctrl.createClassroom);
router.post('/promote-bulk', allow('system_admin', 'accountant'), ctrl.promoteBulk);

// Undoing a whole upload — a file put against the wrong branch. Refuses to
// touch rows that already became registrations.
router.delete('/data', allow('system_admin', 'accountant'), ctrl.deleteData);

router.get('/', ctrl.list);
router.get('/:id', ctrl.getOne);
router.post('/:id/promote', allow('system_admin', 'accountant'), ctrl.promote);
router.put('/:id/review', allow('system_admin', 'accountant'), ctrl.setReview);
// Which group the child actually joins — the manager's call, and it beats
// every age group in either file.
router.put('/:id/placement', allow('system_admin', 'accountant', 'branch_manager'), ctrl.setPlacement);

module.exports = router;
