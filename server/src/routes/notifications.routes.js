const router = require('express').Router();
const { requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/notifications.controller');

/**
 * The notifications waiting for somebody. Mounted below the staff auth
 * middleware, so everything here already has a logged-in user.
 *
 * No tab gate on the first route, on purpose: this is not a screen somebody is
 * granted, it is the caller's own list, and a person who may log in may see
 * what is addressed to them. The `by-recipient` view is the opposite — it
 * names every member of staff and what they have not done yet — so it is
 * system_admin only.
 */
router.get('/', ctrl.listMine);
router.get('/by-recipient', requireRole('system_admin'), ctrl.listByRecipient);

module.exports = router;
