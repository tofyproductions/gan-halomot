const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  sku: { type: String, default: '' },
  name: { type: String, required: true },
  qty: { type: Number, required: true },
  unit_price: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  // Set when the order is received (Phase 3 receive flow).
  qty_received: { type: Number, default: 0 },
  expiry_date: { type: Date, default: null },
  shelf_number: { type: String, default: '' },
  stock_item_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StockItem', default: null },
  batch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StockBatch', default: null },
});

const orderSchema = new mongoose.Schema({
  order_number: { type: String, required: true, unique: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  supplier_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  status: {
    type: String,
    enum: ['draft', 'pending', 'approved', 'sent', 'pending_receive', 'received', 'received_partial', 'cancelled'],
    default: 'pending',
  },
  items: [orderItemSchema],
  total_amount: { type: Number, default: 0 },
  notes: { type: String, default: '' },
  created_by: { type: String, default: '' },
  approved_by: { type: String, default: '' },
  approved_at: { type: Date, default: null },
  pending_receive_at: { type: Date, default: null },
  received_at: { type: Date, default: null },
  received_by_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  received_by_name: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

orderSchema.index({ branch_id: 1, status: 1 });

module.exports = mongoose.model('Order', orderSchema);
