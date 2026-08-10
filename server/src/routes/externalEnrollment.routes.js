const express = require('express');
const multer = require('multer');
const router = express.Router();
const ctrl = require('../controllers/externalEnrollment.controller');
const { requireRole } = require('../middleware/auth');

// 10MB is generous for a spreadsheet — the 77-row export is 27KB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Importing external enrollments creates registrations and children, so it is
// admin/accountant work. A branch manager reads the queue; she does not file
// seventy families into the system.
router.post('/import', requireRole('system_admin', 'accountant'), upload.single('file'), ctrl.importFile);

// Static paths before /:id, so "contacts" and "pricing" are not read as ids.
router.get('/contacts', ctrl.contacts);
router.get('/pricing', ctrl.pricing);
router.get('/classroom-plan', ctrl.classroomPlan);
router.post('/classrooms', requireRole('system_admin', 'accountant'), ctrl.createClassroom);
router.post('/promote-bulk', requireRole('system_admin', 'accountant'), ctrl.promoteBulk);

router.get('/', ctrl.list);
router.get('/:id', ctrl.getOne);
router.post('/:id/promote', requireRole('system_admin', 'accountant'), ctrl.promote);
router.put('/:id/review', requireRole('system_admin', 'accountant'), ctrl.setReview);

module.exports = router;
