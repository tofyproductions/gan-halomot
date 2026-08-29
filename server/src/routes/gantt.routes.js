const express = require('express');
const router = express.Router();
const c = require('../controllers/gantt.controller');

// What parents may see, per week. Read before the gantt itself so the
// screen can show the switch beside the plan it publishes.
router.get('/visibility', c.getVisibility);
router.put('/visibility', c.setVisibility);

router.get('/', c.get);
router.get('/archive', c.getArchive);
// Months worth copying FROM. Above '/:id/...' so it is never read as an id.
router.get('/sources', c.sources);
// Whose turn it is to be אבא / אמא של שבת, and a proposal for the month.
router.get('/shabbat-parents', c.shabbatParents);
router.post('/copy', c.copy);
router.post('/', c.save);
router.post('/:id/approve', c.approve);

module.exports = router;
