const express = require('express');
const router = express.Router();
const c = require('../controllers/product.controller');

router.get('/', c.getAll);
// The stored picture, as bytes. Before /:id so it is not read as an id.
router.get('/:id/image', c.image);
router.post('/', c.create);
router.post('/import', c.bulkImport);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;
