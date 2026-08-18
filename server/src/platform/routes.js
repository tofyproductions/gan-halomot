const router = require('express').Router();
const c = require('./controllers/tenant.controller');

/**
 * Mounted above the application's own auth, because none of this is reached
 * with a gan's token — see tenant.controller for why the two do not share a
 * signing key.
 */
router.post('/login', c.login);

router.use(c.platformAuth);

router.get('/summary', c.summary);
router.get('/tenants', c.list);
router.get('/tenants/:id', c.get);
router.get('/audit', c.audit);

// Creating, pricing and switching customers off is the owner's, not support's.
router.post('/tenants', c.requireOwner, c.create);
router.patch('/tenants/:id', c.requireOwner, c.update);
router.post('/tenants/:id/suspend', c.requireOwner, c.suspend);
router.post('/tenants/:id/resume', c.requireOwner, c.resume);

module.exports = router;
