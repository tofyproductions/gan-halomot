const express = require('express');
const router = express.Router();
const branchController = require('../controllers/branch.controller');
const { requireRole, requireBranchScope } = require('../middleware/auth');

/**
 * Bringing a branch into existence, or ending one, is top-level configuration.
 * Before this there was no check at all here: any authenticated account —
 * a גננת included — could create a gan or deactivate one.
 */
const adminOnly = requireRole('system_admin');

/**
 * Editing one is NOT the same act, and must not be admin-only.
 *
 * The security branch made all three admin-only together, which reads as the
 * safe choice and is not: a branch manager changing her own gan's address or
 * its licensed head count is ordinary work she does today, and taking it away
 * is a regression with no attacker on the other side of it. viewer-e2e 13g
 * caught exactly that.
 *
 * So the gate is "may you act for a branch at all", and WHICH branch is
 * decided in the controller against canAccessBranch — the same split every
 * other scoped route here uses. It matters for the admin_viewer: she has to
 * REACH the controller, because the 403 it raises for a gan she does not
 * manage is what the write guard turns into a proposal. Refusing her at the
 * door would file nothing and tell the office nothing.
 */
router.get('/', branchController.getAll);
router.post('/', adminOnly, branchController.create);
router.put('/:id', requireBranchScope, branchController.update);
router.delete('/:id', adminOnly, branchController.remove);

module.exports = router;
