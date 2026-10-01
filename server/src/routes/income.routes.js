const express = require('express');
const { requireTab, requireTabWrite } = require('../middleware/auth');
const { asyncWrap } = require('../utils/asyncWrap');
const c = require('../controllers/income.controller');

const router = express.Router();
const read = requireTab('income', 'system_admin', 'admin_viewer', 'accountant');
const write = requireTabWrite('income', 'system_admin', 'accountant');

// reads — pure, no GET writes
router.get('/kaplan/queue', read, asyncWrap(c.kaplanQueue));
router.get('/kaplan/alternatives', read, asyncWrap(c.kaplanAlternatives));
router.get('/kaplan/report', read, asyncWrap(c.kaplanReport));
router.get('/kaplan/households', read, asyncWrap(c.kaplanHouseholds));
router.get('/clicktac/summary', read, asyncWrap(c.clicktacSummary));
router.get('/emunah', read, asyncWrap(c.emunahGet));
router.get('/rules', read, asyncWrap(c.listRules));

// writes
router.post('/kaplan/accept', write, asyncWrap(c.kaplanAccept));
router.post('/kaplan/reject', write, asyncWrap(c.kaplanReject));
router.post('/kaplan/unallocate', write, asyncWrap(c.kaplanUnallocate));
router.post('/clicktac/import', write, asyncWrap(c.clicktacImport));
router.post('/emunah/import', write, asyncWrap(c.emunahImport));
router.post('/rules', write, asyncWrap(c.createRule));
router.delete('/rules/:id', write, asyncWrap(c.deleteRule));

router.use(c.errorHandler);

module.exports = router;
