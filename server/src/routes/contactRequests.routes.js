const express = require('express');
const multer = require('multer');
const { authMiddleware } = require('../middleware/auth');
const c = require('../controllers/contactRequests.controller');

/**
 * "פניות למשרד" — every signed-in person may write to the office, so there is
 * no role gate; the controller decides, per thread, who is the sender and who
 * is the office (see its header). A viewer's writes here are exempt from the
 * proposal gate (NO_WRITE_GATE_PREFIXES in middleware/auth.js) — they are her
 * own messages, not changes to the gan.
 */
const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: c.MAX_FILE_BYTES, files: 1 },
});

function uploadErrors(err, _req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'התמונה גדולה מדי (עד 10MB)' });
  if (err) return res.status(400).json({ error: err.message });
  next();
}

router.use(authMiddleware);

router.post('/', upload.single('file'), uploadErrors, c.create);
router.get('/mine', c.mine);
router.get('/inbox', c.inbox);
router.get('/counts', c.counts);
router.get('/:id', c.getOne);
router.post('/:id/reply', upload.single('file'), uploadErrors, c.reply);
router.post('/:id/close', c.close);
router.get('/:id/attachment/:i', c.attachment);

module.exports = router;
