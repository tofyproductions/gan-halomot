const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema({
  name: { type: String, required: true },
  contact_name: { type: String, default: '' },
  contact_phone: { type: String, default: '' },
  contact_email: { type: String, default: '' },
  customer_name: { type: String, default: 'גן החלומות' },
  customer_id: { type: String, default: '' },
  min_order_amount: { type: Number, default: 0 },
  vat_rate: { type: Number, default: 1.18 },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('Supplier', supplierSchema);
