const express = require('express');
const router = express.Router();
const { authMiddleware, allowSelfWrite } = require('../middleware/auth');
const c = require('../controllers/push.controller');

router.use(authMiddleware);
// Which device this person wants notifications on. Signed for the same reason
// the read receipt is: it is about her phone, not about a gan.
router.post('/register', allowSelfWrite('push'), c.registerStaff);
router.post('/unregister', allowSelfWrite('push'), c.unregister);
router.post('/register-web', allowSelfWrite('push'), c.registerWeb);
router.post('/unregister-web', allowSelfWrite('push'), c.unregisterWeb);
router.get('/vapid-public-key', c.vapidPublicKey);

module.exports = router;
