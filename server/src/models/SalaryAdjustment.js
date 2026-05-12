const mongoose = require('mongoose');

/**
 * SalaryAdjustment = an ad-hoc credit / debit / hours change attached to one
 * employee in one month. Distinct from the auto-calculated payroll figure.
 *
 * The branch manager uses these to record:
 *   - bonuses, overtime payouts, reimbursements for special purchases
 *   - manual hour corrections (e.g. clock missed a punch)
 *   - travel additions
 *   - loan / advance requests (deducted from upcoming payroll)
 *
 * Negative amounts represent deductions. `hours` is independent from `amount`:
 *   - 'hours_add' / 'hours_deduct'    use `hours` only
 *   - 'hour_correction'               use `hours` (positive or negative)
 *   - all other types                 use `amount`
 *
 * Adjustments aggregate into the PayrollMonth breakdown at read time, so the
 * monthly table shows the adjusted total alongside the auto-computed one.
 */
const salaryAdjustmentSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  month: { type: String, required: true, index: true }, // 'YYYY-MM'

  type: {
    type: String,
    enum: [
      'money_add',           // תוספת כספית — בונוס/שעות נוספות/וכו'
      'money_deduct',        // ניכוי כספי
      'hours_add',           // תוספת שעות
      'hours_deduct',        // הורדת שעות
      'hour_correction',     // תיקון דיווח שעות (יכול להיות חיובי או שלילי)
      'travel_add',          // תוספת נסיעות
      'purchase_reimburse',  // החזר עבור קניות שביצע עבור הגן
      'advance_request',     // בקשת מקדמה (לקיזוז עתידי)
      'loan_request',        // בקשת הלוואה
      'other',               // אחר — חופשי
    ],
    required: true,
  },
  amount: { type: Number, default: 0 },   // ₪ — שלילי = ניכוי
  hours: { type: Number, default: 0 },    // שעות — שלילי = הורדה
  reason: { type: String, default: '', trim: true },

  // Workflow
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'approved', // managers' entries auto-approve; admin-only types may switch this
  },
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_at: { type: Date, default: null },
  decided_note: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

salaryAdjustmentSchema.index({ employee_id: 1, month: 1 });
salaryAdjustmentSchema.index({ branch_id: 1, month: 1, status: 1 });

module.exports = mongoose.model('SalaryAdjustment', salaryAdjustmentSchema);
