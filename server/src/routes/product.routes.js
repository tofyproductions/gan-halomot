const express = require('express');
const router = express.Router();
const c = require('../controllers/product.controller');
const m = require('../controllers/productMatch.controller');
const { requireTab } = require('../middleware/auth');

// התאמות מוצרים: admin by default, and whoever was handed the tab on the
// permissions screen — the matching work is exactly what אב הבית does.
const matchesTab = requireTab('product-matches', 'system_admin');

router.get('/', c.getAll);

// The same product at another supplier. Before /:id so "matches" is never
// read as a product id. Confirmed comparisons are for whoever orders; the
// review, the scan and every decision are the system admin's.
router.get('/matches', m.matches);
router.get('/matches/review', matchesTab, m.review);
router.post('/matches/scan', matchesTab, m.scan);
router.post('/matches', matchesTab, m.create);
router.post('/matches/:id/confirm', matchesTab, m.confirm);
router.post('/matches/:id/packs', matchesTab, m.packs);
router.post('/matches/:id/reject', matchesTab, m.reject);
router.post('/matches/:id/unlink', matchesTab, m.unlink);

// The stored picture, as bytes. Before /:id so it is not read as an id.
router.get('/:id/image', c.image);
router.post('/', c.create);
router.post('/import', c.bulkImport);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;
