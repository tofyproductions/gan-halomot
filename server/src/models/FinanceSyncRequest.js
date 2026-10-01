const mongoose = require('mongoose');

/**
 * "סנכרן עכשיו" — a request the bank-pi agent claims on its next poll.
 * One pending request at a time; pressing again while one waits returns it.
 */
const financeSyncRequestSchema = new mongoose.Schema({
  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  status: { type: String, enum: ['pending', 'claimed', 'done', 'failed'], default: 'pending' },
  claimed_at: { type: Date, default: null },
  finished_at: { type: Date, default: null },
  result: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('FinanceSyncRequest', financeSyncRequestSchema);
