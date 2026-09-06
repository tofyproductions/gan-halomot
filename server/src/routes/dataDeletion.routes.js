const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const c = require('../controllers/dataDeletion.controller');

router.use(authMiddleware);
router.post('/me', c.requestStaff);

module.exports = router;
