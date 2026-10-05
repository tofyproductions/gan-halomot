const express = require('express');
const router = express.Router();
const c = require('../controllers/shareLinks.controller');
const { authMiddleware, requireRole } = require('../middleware/auth');

// The custom rows of the קישורים להפצה screen. Reading is for whoever sees
// the tab; adding and removing advertised addresses is management's.
router.use(authMiddleware);
const manage = requireRole('system_admin', 'accountant', 'branch_manager');

router.get('/', c.list);
router.post('/', manage, c.create);
router.put('/:id', manage, c.update);
router.delete('/:id', manage, c.remove);

module.exports = router;
