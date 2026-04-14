const express = require('express');
const router = express.Router();
const c = require('../controllers/gantt.controller');

router.get('/', c.get);
router.get('/archive', c.getArchive);
router.post('/', c.save);
router.post('/:id/approve', c.approve);

module.exports = router;
