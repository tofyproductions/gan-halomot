const router = require('express').Router();
const auth = require('../controllers/parentAuth.controller');
const { parentAuthMiddleware } = require('../middleware/parentAuth');

/**
 * The parent portal, mounted ABOVE the staff `authMiddleware` in routes/index.
 *
 * That placement is the point: nothing in here is ever reached by the staff
 * guard, and nothing under it is ever reached by a parent's token. The two
 * sides of the application do not share a gate — see middleware/parentAuth.js
 * for why sharing one would have opened every authenticate-only staff route to
 * several hundred outsiders.
 *
 * Anonymous by necessity: a parent activating an account has no token yet.
 * What protects these four is the one-time code and its throttles
 * (services/parentOtp.service.js), not the router.
 */
router.post('/auth/start', auth.start);
router.post('/auth/verify', auth.verify);
router.post('/auth/set-password', auth.setPassword);
router.post('/auth/login', auth.login);

// Everything below needs a parent token.
router.use(parentAuthMiddleware);
router.get('/me', auth.me);

// Every one of these resolves the parent's children afresh and refuses an id
// that is not among them — see parentPortal.controller.
const portal = require('../controllers/parentPortal.controller');
router.get('/editable-fields', portal.editableFields);
router.get('/children/:childId', portal.childDetails);
router.patch('/children/:childId', portal.updateChild);
router.get('/children/:childId/contracts', portal.childContracts);
router.get('/children/:childId/contracts/:contractId/file', portal.contractFile);

// Changing the phone is its own two-step flow, because the code has to go to
// the new number — see parentPortal.controller.
router.post('/phone/start', portal.startPhoneChange);
router.post('/phone/confirm', portal.confirmPhoneChange);

module.exports = router;
