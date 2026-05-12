const mongoose = require('mongoose');

/**
 * PayrollPresetOption = saved option for a dropdown-style payroll field
 * (currently advance_deduction). When the admin types a new free-text value
 * we persist it here so it shows up in future months as a chooseable preset.
 *
 * `action` describes what the bookkeeping system should do when this option
 * is chosen:
 *   - 'deduct_advance'   — קיזוז המקדמה ששולמה
 *   - 'pay_full'         — להפקיד שכר מלא (קיזוז בחודש הבא)
 *   - 'partial_percent'  — לשלם רק % מהשכר (action_params.percent)
 *   - 'custom'           — admin will handle manually based on `label` text
 */
const payrollPresetOptionSchema = new mongoose.Schema({
  field_name: { type: String, required: true, index: true }, // 'advance_deduction' for now
  label: { type: String, required: true, trim: true },
  action: {
    type: String,
    enum: ['deduct_advance', 'pay_full', 'partial_percent', 'custom'],
    default: 'custom',
  },
  action_params: { type: mongoose.Schema.Types.Mixed, default: {} },
  usage_count: { type: Number, default: 0 },
  is_active: { type: Boolean, default: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

payrollPresetOptionSchema.index({ field_name: 1, label: 1 }, { unique: true });

module.exports = mongoose.model('PayrollPresetOption', payrollPresetOptionSchema);
