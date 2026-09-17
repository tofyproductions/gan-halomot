const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');
const c = require('../controllers/employeeCourses.controller');

// Mounted below the global authMiddleware in routes/index.js.
// Branch scoping happens inside the controller, per employee, from the DB.
router.use(requireRole('system_admin', 'branch_manager', 'accountant'));

router.get('/', c.list);
// The same rows as the screen, as a document. Scoped in the controller like
// everything else here — the file carries a ת"ז and a phone number per row,
// so a manager gets her branches and nobody else's.
router.get('/report.pdf', c.reportPdf);
router.post('/', c.create);
router.get('/:id/file', c.getFile);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;
