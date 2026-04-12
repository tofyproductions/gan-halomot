const mongoose = require('mongoose');

const priceAdjustmentSchema = new mongoose.Schema({
  registration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', required: true },
  effective_month: { type: Number, required: true },
  new_monthly_fee: { type: Number, required: true },
  reason: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('PriceAdjustment', priceAdjustmentSchema);
