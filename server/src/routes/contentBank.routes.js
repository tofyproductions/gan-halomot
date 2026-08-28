const express = require('express');
const router = express.Router();
const c = require('../controllers/contentBank.controller');

// The subject list, before anything is chosen.
router.get('/themes', c.themes);

// Propose a whole week for a subject. POST because it takes a body, not
// because it writes — it writes nothing.
router.post('/suggest', c.suggest);

// What the gananet typed into the plan herself, kept when she saves it.
// Above '/:id' so "capture" is never read as an item id.
router.post('/capture', c.capture);

router.get('/', c.browse);
router.post('/', c.create);
router.put('/:id', c.update);
router.delete('/:id', c.remove);
router.post('/:id/restore', c.restore);

module.exports = router;
