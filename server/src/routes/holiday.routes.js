const express = require('express');
const router = express.Router();
const c = require('../controllers/holiday.controller');

router.get('/', c.getAll);
// The published year, and the merged view a screen reads.
router.get('/calendar', c.calendar);
router.get('/poster', c.posterImage);
router.post('/import-year', c.importYear);
router.post('/', c.create);
router.post('/copy', c.copyFromBranch);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;
