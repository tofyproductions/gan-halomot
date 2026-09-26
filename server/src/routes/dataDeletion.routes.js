const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const { wrapControllers } = require('../utils/asyncWrap');
const c = wrapControllers(require('../controllers/dataDeletion.controller'));

router.use(authMiddleware);
router.post('/me', c.requestStaff);

module.exports = router;
