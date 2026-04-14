const express = require('express');
const router = express.Router();
const branchController = require('../controllers/branch.controller');

router.get('/', branchController.getAll);
router.post('/', branchController.create);
router.put('/:id', branchController.update);
router.delete('/:id', branchController.remove);

module.exports = router;
