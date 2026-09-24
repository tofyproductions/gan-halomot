const mongoose = require('mongoose');

/**
 * Which products the matcher has already looked at.
 *
 * The fingerprint is supplier + sku + name + unit — the things that decide
 * whether two products are the same. A price change is not a reason to ask
 * the model again; a renamed product is. A product with a mark is never sent
 * as "new" again, which is what keeps every catalogue import from re-reading
 * the whole world.
 */
const productScanMarkSchema = new mongoose.Schema({
  fingerprint: { type: String, required: true, unique: true, index: true },
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  scanned_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('ProductScanMark', productScanMarkSchema);
