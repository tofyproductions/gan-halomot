const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const c = require('../controllers/push.controller');

router.use(authMiddleware);
router.post('/register', c.registerStaff);
router.post('/unregister', c.unregister);
router.post('/register-web', c.registerWeb);
router.post('/unregister-web', c.unregisterWeb);
router.get('/vapid-public-key', c.vapidPublicKey);

module.exports = router;
