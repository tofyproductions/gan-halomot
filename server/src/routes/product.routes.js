const express = require('express');
const router = express.Router();
const c = require('../controllers/product.controller');
const m = require('../controllers/productMatch.controller');
const { requireRole } = require('../middleware/auth');

const adminOnly = requireRole('system_admin');

router.get('/', c.getAll);

// The same product at another supplier. Before /:id so "matches" is never
// read as a product id. Confirmed comparisons are for whoever orders; the
// review, the scan and every decision are the system admin's.
router.get('/matches', m.matches);
router.get('/matches/review', adminOnly, m.review);
router.post('/matches/scan', adminOnly, m.scan);
router.post('/matches', adminOnly, m.create);
router.post('/matches/:id/confirm', adminOnly, m.confirm);
router.post('/matches/:id/reject', adminOnly, m.reject);
router.post('/matches/:id/unlink', adminOnly, m.unlink);

// The stored picture, as bytes. Before /:id so it is not read as an id.
router.get('/:id/image', c.image);
router.post('/', c.create);
router.post('/import', c.bulkImport);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;
