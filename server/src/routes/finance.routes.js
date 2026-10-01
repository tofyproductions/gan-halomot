const express = require('express');
const { requireTab, requireTabWrite } = require('../middleware/auth');
const { asyncWrap } = require('../utils/asyncWrap');
const c = require('../controllers/finance.controller');

const router = express.Router();
const read = requireTab('bank', 'system_admin', 'admin_viewer', 'accountant');
const write = requireTabWrite('bank', 'system_admin', 'accountant');

router.get('/status', read, asyncWrap(c.status));
router.get('/accounts', read, asyncWrap(c.accounts));
router.get('/transactions', read, asyncWrap(c.transactions));
router.patch('/transactions/:id', write, asyncWrap(c.flag));
router.post('/import/max', write, asyncWrap(c.importMax));
router.post('/sync/request', write, asyncWrap(c.requestSync));

module.exports = router;
