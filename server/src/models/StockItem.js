const mongoose = require('mongoose');

const UNITS = ['יח\'', 'ק"ג', 'ל\'', 'אריזה', 'חבילה'];

const stockItemSchema = new mongoose.Schema({
  branch_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  category_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StockCategory', required: true, index: true },
  product_id:  { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  supplier_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
  name:      { type: String, required: true, trim: true },
  unit:      { type: String, enum: UNITS, default: 'יח\'' },
  pack_size: { type: Number, default: 0 }, // units per pack when unit is אריזה/חבילה
  qty:       { type: Number, default: 0 }, // cached running total — modified only via movements
  min_qty:   { type: Number, default: 0 }, // red below
  warn_qty:  { type: Number, default: 0 }, // amber below (>=min_qty)
  notes:     { type: String, default: '' },
  is_active: { type: Boolean, default: true },
  last_counted_at: { type: Date, default: null },
  last_counted_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

stockItemSchema.index({ branch_id: 1, category_id: 1, is_active: 1 });

module.exports = mongoose.model('StockItem', stockItemSchema);
module.exports.UNITS = UNITS;
