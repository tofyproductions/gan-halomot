const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const c = require('../controllers/ganEvents.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(authMiddleware);

const MANAGER = requireRole('system_admin', 'branch_manager');

// Campaign list (one row per multi-branch event).
router.get('/', c.listEvents);
// Full campaign (all branch instances) by shared group id.
router.get('/group/:groupId', c.getGroup);
router.post('/', MANAGER, c.createEvent);
// Parse an uploaded Excel/CSV list → display groups (no persistence yet).
router.post('/import', MANAGER, upload.single('file'), c.importItems);
// Add a branch to a campaign ("send to another branch's manager").
router.post('/group/:groupId/add-branch', MANAGER, c.addBranch);
router.delete('/group/:groupId', MANAGER, c.deleteGroup);
// Edit / delete a single branch instance.
router.put('/:id', MANAGER, c.updateEvent);
router.delete('/:id', MANAGER, c.deleteInstance);

module.exports = router;
