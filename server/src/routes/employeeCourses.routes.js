const express = require('express');
const router = express.Router();
const { requireTab, requireTabWrite, tabDecision } = require('../middleware/auth');
const c = require('../controllers/employeeCourses.controller');

/**
 * Guarded by the SCREEN, the same way and for the same reason as אישורי מעון:
 * a role-only guard threw out the back-office account that had been handed
 * קורסים והכשרות on the permissions screen. Reading follows the tab; changing
 * follows `courses_write`, and whoever holds that works across every branch.
 */
const ROLES = ['system_admin', 'branch_manager', 'accountant'];
const READ = requireTab('courses', ...ROLES);
const WRITE = requireTabWrite('courses', ...ROLES);
const widenForWriter = (req, _res, next) => {
  if (tabDecision(req.user, 'courses_write') === 'allow') req.tabWriteGrant = true;
  next();
};

// Mounted below the global authMiddleware in routes/index.js.
// Branch scoping happens inside the controller, per employee, from the DB.
router.use(READ, widenForWriter);

router.get('/', c.list);
// The same rows as the screen, as a document. Scoped in the controller like
// everything else here — the file carries a ת"ז and a phone number per row,
// so a manager gets her branches and nobody else's.
router.get('/report.pdf', c.reportPdf);
router.post('/', WRITE, c.create);
router.get('/:id/file', c.getFile);
router.put('/:id', WRITE, c.update);
router.delete('/:id', WRITE, c.remove);

module.exports = router;
