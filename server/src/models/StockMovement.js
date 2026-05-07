const mongoose = require('mongoose');

const REASONS = ['count', 'delivery', 'consumption', 'correction', 'spoilage', 'undo', 'init'];

const stockMovementSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  item_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'StockItem', required: true, index: true },
  delta:     { type: Number, required: true }, // signed; positive = in, negative = out
  reason:    { type: String, enum: REASONS, default: 'correction' },
  qty_before: { type: Number, default: 0 },
  qty_after:  { type: Number, default: 0 },
  source_order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  batch_id:        { type: mongoose.Schema.Types.ObjectId, ref: 'StockBatch', default: null },
  reverses_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement', default: null },
  reversed_by_id:  { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement', default: null },
  by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  by_user_name: { type: String, default: '' },
  notes: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

stockMovementSchema.index({ item_id: 1, created_at: -1 });
stockMovementSchema.index({ branch_id: 1, created_at: -1 });

module.exports = mongoose.model('StockMovement', stockMovementSchema);
module.exports.REASONS = REASONS;
