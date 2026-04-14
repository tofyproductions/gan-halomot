const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  sku: { type: String, default: '' },
  name: { type: String, required: true },
  qty: { type: Number, required: true },
  unit_price: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
}, { _id: false });

const orderSchema = new mongoose.Schema({
  order_number: { type: String, required: true, unique: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  supplier_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  status: {
    type: String,
    enum: ['draft', 'pending', 'approved', 'sent', 'cancelled'],
    default: 'pending',
  },
  items: [orderItemSchema],
  total_amount: { type: Number, default: 0 },
  notes: { type: String, default: '' },
  created_by: { type: String, default: '' },
  approved_by: { type: String, default: '' },
  approved_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

orderSchema.index({ branch_id: 1, status: 1 });

module.exports = mongoose.model('Order', orderSchema);
