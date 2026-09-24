const mongoose = require('mongoose');

/**
 * One thing, sold by several suppliers.
 *
 * A group holds one product per supplier and what a unit of sale contains
 * (`pack_qty` — 400 wipes in DALAS's carton, 80 in שאבי's pack) so the two
 * prices can be compared per wipe, not per box. Claude proposes pairs; an
 * admin confirms or rejects them; the order form reads only `confirmed`.
 *
 * `pair_key` is the memory. It is the two product ids sorted and joined, and
 * it is unique: a pair that was proposed once — and above all a pair that was
 * REJECTED — is never proposed again, however many scans run. A confirmed pair
 * whose product is already in a confirmed group is merged into that group and
 * kept here with `merged_into` set, so its key keeps guarding.
 */
const memberSchema = new mongoose.Schema({
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  supplier_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  /** Base units per unit of sale. null = unknown, compare per pack only. */
  pack_qty: { type: Number, default: null },
}, { _id: false });

const productMatchSchema = new mongoose.Schema({
  products: { type: [memberSchema], default: [] },
  base_unit: { type: String, default: '' },
  label: { type: String, default: '' },
  status: { type: String, enum: ['proposed', 'confirmed', 'rejected'], default: 'proposed', index: true },
  confidence: { type: Number, default: 0 },
  reason: { type: String, default: '' },
  proposed_by: { type: String, enum: ['ai', 'user'], default: 'ai' },
  decided_by: { type: String, default: '' },
  decided_at: { type: Date, default: null },
  pair_key: { type: String, default: null, unique: true, sparse: true },
  merged_into: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductMatch', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

productMatchSchema.index({ 'products.product_id': 1 });

/** The two ids sorted, so A:B and B:A are the same pair. */
productMatchSchema.statics.pairKey = function pairKey(a, b) {
  return [String(a), String(b)].sort().join(':');
};

module.exports = mongoose.model('ProductMatch', productMatchSchema);
