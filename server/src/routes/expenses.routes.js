const express = require('express');
const { requireTab, requireTabWrite } = require('../middleware/auth');
const { asyncWrap: w } = require('../utils/asyncWrap');
const c = require('../controllers/expenses.controller');

const router = express.Router();
const read = requireTab('expenses', 'system_admin', 'admin_viewer', 'accountant');
const write = requireTabWrite('expenses', 'system_admin', 'accountant');

// reads — pure, no GET writes
router.get('/pairs', read, w(c.pairQueue));
router.get('/pairs/alternatives', read, w(c.pairAlternatives));
router.get('/receipts', read, w(c.receiptsLane));
router.get('/receipts/:id/candidates', read, w(c.receiptCandidates));
router.get('/closed', read, w(c.closed));
router.get('/search', read, w(c.searchAll));
router.get('/counts', read, w(c.counts));
router.get('/documents/:id', read, w(c.getDocument));
router.get('/documents/:id/file', read, w(c.getFile));
router.get('/documents/:id/orders', read, w(c.documentOrders));
router.get('/rules', read, w(c.listRules));
router.get('/suppliers-missing-tax-id', read, w(c.suppliersMissingTaxId));
router.get('/intake/status', read, w(c.intakeStatus));

// writes
router.post('/documents', write, w(c.createDocument));
router.patch('/documents/:id', write, w(c.patchDocument));
router.post('/documents/:id/void', write, w(c.voidDoc));
router.post('/documents/:id/confirm', write, w(c.confirmDoc));
router.post('/documents/:id/supplier', write, w(c.createSupplier));
router.post('/pairs/accept', write, w(c.acceptPair));
router.post('/pairs/reject', write, w(c.rejectPair));
router.post('/pairs/unpair', write, w(c.unpair));
router.post('/documents/:id/unpaid', write, w(c.markUnpaid));
router.delete('/documents/:id/unpaid', write, w(c.unmarkUnpaid));
router.post('/documents/:id/decision', write, w(c.decide));
router.delete('/documents/:id/decision', write, w(c.undecide));
router.post('/receipts/:id/link', write, w(c.linkReceipt));
router.delete('/receipts/:id/link', write, w(c.unlinkReceipt));
router.post('/receipts/:id/is-document', write, w(c.receiptIsDocument));
router.post('/suppliers/:id/receipt-is-document', write, w(c.supplierReceiptIsDocument));
router.post('/documents/:id/order', write, w(c.linkOrder));
router.delete('/documents/:id/order', write, w(c.unlinkOrder));
router.post('/rules', write, w(c.createRule));
router.delete('/rules/:id', write, w(c.deleteRule));
router.post('/intake/pull', write, w(c.intakePull));

router.use(c.errorHandler);

module.exports = router;
