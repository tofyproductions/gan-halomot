const mongoose = require('mongoose');
const { FinanceSyncRequest } = require('../models');
const { ingest } = require('../services/financeIngest.service');

async function ingestFeed(req, res) {
  try {
    const result = await ingest(req.body?.accounts, { agentVersion: req.body?.agent_version || null, source: 'agent' });
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

/** The agent polls this every minute; a pending "סנכרן עכשיו" is handed out once. */
async function claim(req, res) {
  const r = await FinanceSyncRequest.findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'claimed', claimed_at: new Date() } },
    { sort: { created_at: 1 }, new: true },
  );
  return res.json({ id: r ? String(r._id) : null });
}

async function finish(req, res) {
  const { id, ok, result } = req.body || {};
  if (!id || !mongoose.isValidObjectId(id)) return res.status(400).json({ error: 'id חסר או שגוי' });
  await FinanceSyncRequest.updateOne(
    { _id: id, status: 'claimed' },
    { $set: { status: ok === true ? 'done' : 'failed', finished_at: new Date(), result: String(result || '').slice(0, 500) } },
  );
  return res.json({ ok: true });
}

module.exports = { ingestFeed, claim, finish };
