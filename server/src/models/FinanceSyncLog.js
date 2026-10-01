const mongoose = require('mongoose');

/** One ingest run — what the agent (or a Max upload) delivered, and when. */
const financeSyncLogSchema = new mongoose.Schema({
  source: { type: String, enum: ['agent', 'max_xlsx'], required: true },
  agent_version: { type: String, default: null },
  status: { type: String, enum: ['ok', 'error'], default: 'ok' },
  accounts_seen: { type: Number, default: 0 },
  inserted: { type: Number, default: 0 },
  updated: { type: Number, default: 0 },
  pending_replaced: { type: Number, default: 0 },
  error: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

financeSyncLogSchema.index({ source: 1, created_at: -1 });

module.exports = mongoose.model('FinanceSyncLog', financeSyncLogSchema);
