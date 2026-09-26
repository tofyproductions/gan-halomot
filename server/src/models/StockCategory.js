const mongoose = require('mongoose');

const stockCategorySchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  name: { type: String, required: true, trim: true },
  sort_order: { type: Number, default: 0 },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

stockCategorySchema.index({ branch_id: 1, sort_order: 1 });
// Two concurrent first-visits to a fresh branch both saw count=0 and both
// inserted the default categories. Partial on active rows so deactivating a
// category doesn't block a later one with the same name.
stockCategorySchema.index(
  { branch_id: 1, name: 1 },
  { unique: true, partialFilterExpression: { is_active: true } },
);

module.exports = mongoose.model('StockCategory', stockCategorySchema);
