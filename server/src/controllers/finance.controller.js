const mongoose = require('mongoose');
const { BankAccount, BankTransaction, FinanceSyncLog, FinanceSyncRequest } = require('../models');
const { importMaxExport } = require('../services/maxImport.service');
const { unlinkSettlement } = require('../services/cardSettlement.service');

const STALE_MS = 48 * 3600 * 1000;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function status(req, res) {
  const last = await FinanceSyncLog.findOne({ source: 'agent', status: 'ok' }).sort({ created_at: -1 }).lean();
  const lastReq = await FinanceSyncRequest.findOne().sort({ created_at: -1 }).lean();
  const at = last?.created_at || null;
  res.json({
    last_agent_ingest_at: at,
    stale: !at || Date.now() - new Date(at).getTime() > STALE_MS,
    last_request: lastReq ? { status: lastReq.status, result: lastReq.result, created_at: lastReq.created_at, finished_at: lastReq.finished_at } : null,
  });
}

async function accounts(req, res) {
  const list = await BankAccount.find({ is_active: true }).sort({ type: 1, label: 1 }).lean();
  const last = await BankTransaction.aggregate([{ $group: { _id: '$account_id', last: { $max: '$date' } } }]);
  const byId = new Map(last.map(l => [String(l._id), l.last]));
  res.json({ accounts: list.map(a => ({ ...a, last_tx_date: byId.get(String(a._id)) || null })) });
}

async function transactions(req, res) {
  const { month, account_id, direction, q } = req.query;
  const filter = {};
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'חודש לא תקין' });
    filter.date = { $gte: `${month}-01`, $lte: `${month}-31` };
  }
  if (account_id) {
    if (!mongoose.isValidObjectId(account_id)) return res.status(400).json({ error: 'חשבון לא תקין' });
    filter.account_id = account_id;
  }
  if (direction === 'in') filter.amount = { $gt: 0 };
  if (direction === 'out') filter.amount = { $lt: 0 };
  if (q && String(q).trim()) {
    const re = new RegExp(escapeRe(String(q).trim().slice(0, 60)), 'i');
    filter.$or = [{ description: re }, { counterparty: re }, { transfer_note: re }];
  }
  const rows = await BankTransaction.find(filter).sort({ date: -1, created_at: -1 }).limit(2000).lean();
  const totals = { in: 0, out: 0, net: 0 };
  for (const t of rows) {
    if (t.is_internal_transfer) continue;
    if (t.amount > 0) totals.in += t.amount; else totals.out += t.amount;
  }
  totals.net = totals.in + totals.out;
  for (const k of Object.keys(totals)) totals[k] = Math.round(totals[k] * 100) / 100;
  res.json({ transactions: rows, totals });
}

async function flag(req, res) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: 'תנועה לא תקינה' });
  const t = await BankTransaction.findById(id);
  if (!t) return res.status(404).json({ error: 'התנועה לא נמצאה' });
  const { is_internal_transfer, is_one_time } = req.body || {};
  if (is_internal_transfer === false && t.matched_card_account_id) {
    await unlinkSettlement(t._id);
  } else if (typeof is_internal_transfer === 'boolean') {
    t.is_internal_transfer = is_internal_transfer;
  }
  if (typeof is_one_time === 'boolean') t.is_one_time = is_one_time;
  t.flagged_by = req.user.id;
  t.flagged_at = new Date();
  await t.save();
  res.json({ transaction: await BankTransaction.findById(id).lean() });
}

async function importMax(req, res) {
  const b64 = String(req.body?.file_data || '').replace(/^data:[^,]*,/, '');
  if (!b64) return res.status(400).json({ error: 'לא התקבל קובץ' });
  try {
    return res.json(await importMaxExport(Buffer.from(b64, 'base64')));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

async function requestSync(req, res) {
  const existing = await FinanceSyncRequest.findOne({ status: { $in: ['pending', 'claimed'] } }).lean();
  if (existing) return res.json({ request: existing });
  const r = await FinanceSyncRequest.create({ requested_by: req.user.id });
  res.json({ request: r.toObject() });
}

module.exports = { status, accounts, transactions, flag, importMax, requestSync };
