const router = require('express').Router();
const { requireRole } = require('../middleware/auth');
const c = require('../controllers/rosterGap.controller');

/**
 * פערי רישום — read-only, and gated to the people who would act on it.
 *
 * A branch manager sees her own branches (the controller scopes it), because
 * "a child of mine has no card" is hers to answer. The screen writes nothing,
 * so there is no write gate to add.
 */
router.get('/', requireRole('system_admin', 'admin_viewer', 'accountant', 'branch_manager'), c.list);

module.exports = router;
