const router = require('express').Router();
const c = require('./controllers/tenant.controller');

/**
 * Mounted above the application's own auth, because none of this is reached
 * with a gan's token — see tenant.controller for why the two do not share a
 * signing key.
 */
router.post('/login', c.login);

// Before the login, deliberately: the login screen renders the brand.
router.get('/brand', c.brand);

router.use(c.platformAuth);

router.get('/summary', c.summary);
router.get('/tenants', c.list);
router.get('/tenants/:id', c.get);
router.get('/audit', c.audit);

// Support opening a customer's system. NOT requireOwner — this is exactly what
// support is for, and making it owner-only would mean the owner does every
// support call or somebody shares an owner login. It is read-only, expires in
// thirty minutes, and is logged with a reason before the token is minted.
router.post('/tenants/:id/impersonate', c.impersonate);

// Billing. Looking is support's business; deciding what a customer owes is not.
router.get('/billing', c.billingList);
router.post('/billing/run', c.requireOwner, c.billingRun);
router.patch('/billing/:id', c.requireOwner, c.billingMark);

// Creating, pricing and switching customers off is the owner's, not support's.
router.post('/tenants', c.requireOwner, c.create);
router.patch('/tenants/:id', c.requireOwner, c.update);
router.post('/tenants/:id/suspend', c.requireOwner, c.suspend);
router.post('/tenants/:id/resume', c.requireOwner, c.resume);

module.exports = router;
