const express = require('express');
const router = express.Router();
const c = require('../controllers/supplyList.controller');

router.get('/', c.get);
router.put('/', c.update);
router.get('/poster', c.posterImage);

module.exports = router;
