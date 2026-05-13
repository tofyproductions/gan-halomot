const mongoose = require('mongoose');

/**
 * PayrollMonth = one row per (employee × month) capturing both
 *   - manual fields entered by the admin (sick days, vacation, gift card, etc.)
 *   - a cached snapshot of the auto-calculated salary breakdown
 *
 * The auto-snapshot is recomputed on every read; we cache it here only so we
 * can finalize a month and freeze the auto values too (status='finalized'
 * means stop recomputing).
 */

// A field that can hold either a number (NIS amount) or free text.
// Used by gift_card, recreation, cibus, miluim — usually numbers, sometimes notes.
const numberOrTextSchema = new mongoose.Schema({
  kind: { type: String, enum: ['number', 'text', 'empty'], default: 'empty' },
  amount: { type: Number, default: null },
  text: { type: String, default: '' },
}, { _id: false });

const payrollMonthSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  month: { type: String, required: true, index: true }, // 'YYYY-MM'

  // --- Manual fields the admin fills in each month ---
  manual: {
    sick_days:       { type: Number, default: 0 },      // ימי מחלה
    absence_days:    { type: Number, default: 0 },      // ימי היעדרות
    vacation_days:   { type: Number, default: 0 },      // ימי חופשה
    holiday_pay:     { type: Number, default: 0 },      // דמי חגים

    // Advance deduction directive — references a saved preset OR free text.
    // The action attached to the preset determines what payroll should do.
    advance_deduction_preset_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollPresetOption', default: null },
    advance_deduction_text:      { type: String, default: '' },

    // Mixed-type fields (number OR text)
    gift_card:    { type: numberOrTextSchema, default: () => ({}) },
    recreation:   { type: numberOrTextSchema, default: () => ({}) }, // הבראה
    cibus:        { type: numberOrTextSchema, default: () => ({}) },
    miluim:       { type: numberOrTextSchema, default: () => ({}) },

    // Optional per-month override of the employee's default travel allowance.
    // If null, the auto value (travel_per_day × days_worked or monthly flat) is used.
    travel_override: { type: Number, default: null },

    notes: { type: String, default: '' },

    // Ad-hoc admin-added columns for this month — keyed by PayrollCustomColumn id.
    // Value shape matches numberOrTextSchema regardless of column kind:
    //   - kind='text'   → only `text` is meaningful
    //   - kind='number' → only `amount`
    //   - kind='number_or_text' → either field, distinguished by `kind`
    custom_values: { type: mongoose.Schema.Types.Mixed, default: {} },
  },

  // --- Auto snapshot ---
  // Stored only when finalized; otherwise computed live on read.
  auto_snapshot: { type: mongoose.Schema.Types.Mixed, default: null },

  // Snapshot of vacation balance from the latest parsed payslip for this
  // employee. Recorded by the payslip-audit ingest step. Used by the manager
  // UI to show "balance available" alongside any month-level vacation usage.
  vacation_balance_from_payslip: { type: Number, default: null },
  vacation_balance_recorded_at: { type: Date, default: null },
  // Vacation requests (EmployeeRequest._id) approved into this month.
  // When a manager approves a vacation request, the days are added to
  // manual.vacation_days and the request id is recorded here so the UI
  // can show the source of each day.
  vacation_request_ids: { type: [mongoose.Schema.Types.ObjectId], ref: 'EmployeeRequest', default: [] },

  status: {
    type: String,
    enum: ['draft', 'finalized'],
    default: 'draft',
  },
  finalized_at: { type: Date, default: null },
  finalized_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

payrollMonthSchema.index({ employee_id: 1, month: 1 }, { unique: true });
payrollMonthSchema.index({ branch_id: 1, month: 1 });

module.exports = mongoose.model('PayrollMonth', payrollMonthSchema);
