const router = require('express').Router();
const multer = require('multer');
const { wrapControllers } = require('../utils/asyncWrap');
const ctrl = wrapControllers(require('../controllers/photos.controller'));
const { requireTab } = require('../middleware/auth');
const { MAX_UPLOAD_BYTES } = require('../services/photo.service');

/**
 * The gan's photographs, staff side.
 *
 * Held in memory rather than written to a temp file: every upload is resized
 * and forwarded to object storage immediately, so a disk round-trip would buy
 * nothing — and Render's disk is ephemeral, which makes a half-written temp
 * file a bug waiting for a deploy.
 *
 * Thirty at a time is a phone's camera roll after a morning in the garden.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 30 },
});

/**
 * Open to whoever is in the room. A teacher takes the photographs; requiring a
 * manager to upload them means they are uploaded a week later or not at all.
 * The controller narrows each of them to their own branches.
 */
const allow = requireTab('nursery', 'system_admin', 'branch_manager', 'class_leader', 'teacher', 'assistant', 'classroom_board');

// Diagnostic: which of the four things an upload needs is actually broken.
router.get('/selftest', allow, ctrl.selftest);
// The rooms this user may upload to — all categories, this year only.
router.get('/classrooms', allow, ctrl.listClassrooms);
router.get('/', allow, ctrl.list);
router.post('/upload', allow, upload.array('photos', 30), ctrl.upload);
// פעולה קבוצתית. מוגדרת לפני '/:id' — אחרת 'bulk-tag' ייקרא כמזהה תמונה.
router.post('/bulk-tag', allow, ctrl.bulkTag);
router.post('/bulk-delete', allow, ctrl.bulkRemove);

router.patch('/:id', allow, ctrl.tag);
router.delete('/:id', allow, ctrl.remove);

module.exports = router;
