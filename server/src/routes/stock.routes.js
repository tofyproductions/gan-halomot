const router = require('express').Router();
const { authMiddleware, requireTab } = require('../middleware/auth');
const ctrl = require('../controllers/stock.controller');

const STOCK_ROLES = ['system_admin', 'branch_manager', 'class_leader', 'cook'];

// By TAB, not by hardcoded role: the permissions screen can hand מעקב מלאי
// to anyone (אב הבית), and a tab that opens a screen whose API refuses it
// is a grant that does not work.
router.use(authMiddleware, requireTab('stock', ...STOCK_ROLES));

// Categories
router.get('/categories', ctrl.listCategories);
router.post('/categories', ctrl.createCategory);
router.patch('/categories/:id', ctrl.updateCategory);
router.delete('/categories/:id', ctrl.deleteCategory);

// Items
router.get('/items', ctrl.listItems);
router.post('/items', ctrl.createItem);
router.patch('/items/:id', ctrl.updateItem);
router.delete('/items/:id', ctrl.deleteItem);

// Movements (qty changes)
router.post('/items/:id/adjust', ctrl.adjustItem);
router.post('/items/:id/count', ctrl.countItem);
router.post('/movements/:id/undo', ctrl.undoMovement);
router.get('/movements', ctrl.listMovements);

// Helpers
router.get('/search-products', ctrl.searchProducts);
router.get('/consumption', ctrl.consumptionStats);
router.get('/shortages', ctrl.listShortages);
router.get('/shortages-by-branch', ctrl.shortagesByBranch);

module.exports = router;
