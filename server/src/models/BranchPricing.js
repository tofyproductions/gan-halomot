const mongoose = require('mongoose');

// One subsidy tier (דרגת סבסוד) row in the state price matrix.
// `prices` is index-aligned to the parent doc's `age_groups` array, so renaming
// an age group or a tier never orphans a price — only adding/removing a column
// touches the cells.
const tierSchema = new mongoose.Schema({
  label: { type: String, default: '' },   // e.g. "דרגה 1"
  prices: { type: [Number], default: [] },  // parent monthly price per age group
}, { _id: false });

// A per-branch add-on (תוספת) on top of the base price.
const addonSchema = new mongoose.Schema({
  key: { type: String, default: '' },       // stable-ish slug, optional
  label: { type: String, required: true },   // e.g. "תפריט תזונתי בשרי"
  price: { type: Number, default: 0 },        // monthly price
  is_active: { type: Boolean, default: true },
}, { _id: false });

const branchPricingSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  academic_year: { type: String, default: '' },

  // Private (מעון פרטי) → one flat uniform price.
  // Subsidized (מעון סמל / משרד התמ"ת) → state matrix + add-ons.
  pricing_type: { type: String, enum: ['private', 'subsidized'], default: 'subsidized' },

  // --- Private ---
  fixed_monthly_fee: { type: Number, default: 0 },

  // --- Subsidized: state base-price matrix (set by the state) ---
  age_groups: { type: [String], default: [] },  // columns, e.g. ['תינוק','פעוט']
  tiers: { type: [tierSchema], default: [] },     // rows, prices index-aligned to age_groups

  // --- Add-ons (per branch) ---
  addons: { type: [addonSchema], default: [] },

  // --- One-time fees ---
  one_time: {
    insurance: { type: Number, default: 0 },     // ביטוח
    registration: { type: Number, default: 0 },  // דמי רישום
  },

  notes: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// One pricing document per branch per academic year.
branchPricingSchema.index({ branch_id: 1, academic_year: 1 }, { unique: true });

module.exports = mongoose.model('BranchPricing', branchPricingSchema);
