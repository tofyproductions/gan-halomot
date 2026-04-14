const express = require('express');
const router = express.Router();
const c = require('../controllers/holiday.controller');

router.get('/', c.getAll);
router.post('/', c.create);
router.post('/copy', c.copyFromBranch);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;
