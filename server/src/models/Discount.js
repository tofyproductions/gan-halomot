const mongoose = require('mongoose');

const discountSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  // Scope: who gets the discount
  scope: {
    type: String,
    enum: ['child', 'classroom', 'branch'],
    required: true,
  },
  // Target: specific child or classroom (null for branch-wide)
  registration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', default: null },
  classroom_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', default: null },
  // Type: percentage or fixed amount
  discount_type: {
    type: String,
    enum: ['percentage', 'fixed'],
    required: true,
  },
  value: { type: Number, required: true }, // e.g. 10 for 10% or 500 for ₪500
  // When: specific month or all months
  month: { type: Number, default: null, min: 1, max: 12 }, // null = all months
  academic_year: { type: String, default: '' },
  reason: { type: String, default: '' },
  is_active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

discountSchema.index({ branch_id: 1, scope: 1 });

module.exports = mongoose.model('Discount', discountSchema);
