const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  supplier_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  sku: { type: String, default: '' },
  category: { type: String, default: '' },
  name: { type: String, required: true },
  price_before_vat: { type: Number, default: 0 },
  price_with_vat: { type: Number, default: 0 },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

productSchema.index({ supplier_id: 1 });

module.exports = mongoose.model('Product', productSchema);
