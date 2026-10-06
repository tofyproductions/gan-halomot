const router = require('express').Router();
const { wrapControllers } = require('../utils/asyncWrap');
const ctrl = wrapControllers(require('../controllers/parentSignups.controller'));
const { requireTab } = require('../middleware/auth');

/**
 * מעקב הורים רשומים — who reached the portal and who the office must chase.
 *
 * Management only, and that is narrower than most screens here on purpose.
 * Every row carries a family's ID number and mobile, and the question the
 * screen answers — who to ring this evening — is the office's question, not
 * the staff room's. A class leader who wants to know whether her room is
 * signed up can be told; she does not need fifty-four ID numbers to find out.
 *
 * Read only. Nothing on this screen changes anything: chasing a parent
 * happens in WhatsApp, and correcting a wrong mobile happens where the rest
 * of a child's details are corrected.
 */
const allow = requireTab('parent_signups', 'system_admin', 'admin_viewer', 'branch_manager');

router.get('/', allow, ctrl.list);

module.exports = router;
