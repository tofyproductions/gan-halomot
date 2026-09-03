const express = require('express');
const router = express.Router();
const branchController = require('../controllers/branch.controller');
const { requireRole } = require('../middleware/auth');

// Creating, renaming, retuning capacity, or deactivating a branch is top-level
// configuration — system_admin only. Reading the list stays open (the
// controller already scopes it to the caller's branches).
const adminOnly = requireRole('system_admin');

router.get('/', branchController.getAll);
router.post('/', adminOnly, branchController.create);
router.put('/:id', adminOnly, branchController.update);
router.delete('/:id', adminOnly, branchController.remove);

module.exports = router;
