const mongoose = require('mongoose');

// A StockBatch represents one received quantity of a single item with a single
// expiry date and shelf location. The item's running qty is the sum of its
// active batches; consumption draws down from the batch closest to expiry first
// (FEFO). Manual count adjustments can produce an anonymous batch with no
// expiry/shelf so the totals stay consistent.

const stockBatchSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  item_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'StockItem', required: true, index: true },
  qty:       { type: Number, required: true, default: 0 },
  expiry_date:   { type: Date, default: null },
  shelf_number:  { type: String, default: '' },
  source_order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  received_at:   { type: Date, default: Date.now },
  is_active:     { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

stockBatchSchema.index({ item_id: 1, expiry_date: 1 });

module.exports = mongoose.model('StockBatch', stockBatchSchema);
