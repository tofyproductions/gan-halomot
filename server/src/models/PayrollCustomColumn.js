const mongoose = require('mongoose');

/**
 * PayrollCustomColumn = an ad-hoc column the admin added to a particular
 * month's payroll table (e.g. "מענק חג חורף", "הוצאות נסיעה לחו"ל"). One
 * row per (month × label).
 *
 * `kind` defines what the cell editor offers:
 *   - 'text'           — free text only
 *   - 'number'         — numeric only (NIS amount)
 *   - 'number_or_text' — toggleable between number and free text
 *
 * Cell values are stored on PayrollMonth.manual.custom_values keyed by this
 * column's id (so deleting the column does NOT lose data immediately — the
 * value just becomes orphaned).
 */
const payrollCustomColumnSchema = new mongoose.Schema({
  month: { type: String, required: true, index: true }, // 'YYYY-MM' OR '*' for "all months"
  label: { type: String, required: true, trim: true },
  kind: {
    type: String,
    enum: ['text', 'number', 'number_or_text'],
    default: 'number',
  },
  position: { type: Number, default: 0 },
  is_active: { type: Boolean, default: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

payrollCustomColumnSchema.index({ month: 1, position: 1 });

module.exports = mongoose.model('PayrollCustomColumn', payrollCustomColumnSchema);
