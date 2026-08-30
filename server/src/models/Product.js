const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  supplier_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  sku: { type: String, default: '' },
  category: { type: String, default: '' },
  name: { type: String, required: true },
  price_before_vat: { type: Number, default: 0 },
  price_with_vat: { type: Number, default: 0 },
  image_url: { type: String, default: '' },
  // הערה קבועה — rides along automatically on every order that includes this
  // product, all the way to the supplier's PDF. This is where "תבלינים של
  // 'טעם וריח' בלבד — אלרגיה לשומשום" lives, so nobody has to remember to
  // retype it and the one time it is forgotten is not the time that matters.
  standing_note: { type: String, default: '' },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

productSchema.index({ supplier_id: 1 });

module.exports = mongoose.model('Product', productSchema);
