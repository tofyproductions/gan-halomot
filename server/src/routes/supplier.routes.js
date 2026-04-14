const express = require('express');
const router = express.Router();
const c = require('../controllers/supplier.controller');

router.get('/', c.getAll);
router.get('/:id', c.getById);
router.post('/', c.create);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;
