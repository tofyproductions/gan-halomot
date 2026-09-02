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

    // Vacation pay is contingent on the employee having remaining vacation
    // balance in her payslip — the accountant cards carry a standing note to
    // pay only if days remain. Accounting can deliberately approve paying
    // even without balance; that flips the note. Accountant/admin only.
    vacation_pay_confirmed: { type: Boolean, default: false },

    // Advance deduction directive — references a saved preset OR free text.
    // The action attached to the preset determines what payroll should do.
    advance_deduction_preset_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollPresetOption', default: null },
    advance_deduction_text:      { type: String, default: '' },

    // Mixed-type fields (number OR text)
    gift_card:    { type: numberOrTextSchema, default: () => ({}) },
    recreation:   { type: numberOrTextSchema, default: () => ({}) }, // הבראה
    cibus:        { type: numberOrTextSchema, default: () => ({}) },
    miluim:       { type: numberOrTextSchema, default: () => ({}) },

    // Bonus (בונוס): added to the estimated total. `override_amount` overrides
    // the auto-computed personal bonus (rate × branch hours); `disabled` zeroes
    // it; `note` documents what the bonus is for (defaults to the auto reason).
    bonus: {
      override_amount: { type: Number, default: null },
      note:            { type: String, default: '' },
      disabled:        { type: Boolean, default: false },
    },

    // Optional per-month override of the employee's default travel allowance.
    // If null, the auto value (travel_per_day × days_worked or monthly flat) is used.
    travel_override: { type: Number, default: null },
    // Free text about this month's travel — "3 ימים ברכב פרטי", "נסע עם הורה".
    // Deliberately NOT the same field as travel_override: that one is a Number
    // the salary engine reads directly, so putting prose in it would silently
    // zero the travel component. A branch manager writes here; the accountant
    // reads it and sets the figure.
    travel_note: { type: String, default: '' },

    notes: { type: String, default: '' },

    // Standard-salary (תקן) completion toggle. Defaults true — the system
    // adds השלמת שכר to bring a teken-salary employee up to her full agreed
    // salary even when she didn't complete required hours. Manager can set
    // false to pay only the actual worked hours × hourly_value (no top-up).
    include_salary_completion: { type: Boolean, default: true },

    // "השלמת שכר אוגוסט" — UNRELATED to include_salary_completion above (that
    // one is the standing תקן top-up; this one is the once-a-year decision that
    // THIS employee is owed pay for the branch's summer closure). When true,
    // services/closureCompletion.js materializes her committed weekdays inside
    // the branch's Holiday closure window that have no real punch:
    //   - hourly:  real, counted Punch rows — paid like any other worked day.
    //   - global:  the same Punch rows, but payrollCalc.js excludes them from
    //     hours; payrollMonth.controller.js instead prices them at her hourly_value
    //     and adds that as a separate `closure_completion_bonus`, offsetting the
    //     automatic completion so the total isn't paid twice (exactly like the
    //     sick-pay/completion_offset pattern above).
    // Per-employee, per-month. Admin/accountant only (not a branch-manager field).
    closure_completion: { type: Boolean, default: false },

    // בונוס אוגוסט — the per-day approval list behind the flag above. A day in
    // the fixed summer window (Aug 16–31, services/augustBonus.js) is paid ONLY
    // if its date is listed here; the flag alone pays nothing. `default:
    // undefined` is deliberate: a row flagged before this field existed is
    // recognizable (field missing) and adopts its already-materialized punch
    // dates as its approved list, so an already-paid August never silently
    // shrinks (closureCompletion.materializeMonth handles that adoption).
    closure_completion_approved_dates: { type: [String], default: undefined },

    // DEPRECATED — no longer read by the calc. Statutory daily overtime is now
    // always paid automatically; the beyond-commitment supplement is gated by
    // the two approval flags below. Kept for back-compat with old documents.
    include_teken_ot: { type: Boolean, default: true },

    // Approval gate for the beyond-commitment supplement (extra regular hours a
    // תקן employee worked above her committed hours). The supplement is paid
    // ONLY when BOTH the branch manager and accounting approve it. Each flag is
    // writable solely by the matching role (branch_manager / accountant; admin
    // may set either).
    supplement_manager_approved: { type: Boolean, default: false },
    supplement_accounting_approved: { type: Boolean, default: false },

    // Per-day absence records for committed days the employee missed (already
    // excluding kindergarten holidays + approved vacation/sick). Each day needs
    // BOTH manager and accounting approval; only the deductible categories
    // (unpaid/other) reduce pay, at the uniform daily rate (S / committed days).
    absence_entries: {
      type: [{
        date: { type: String },                              // YYYY-MM-DD
        category: { type: String, default: 'unpaid' },       // unpaid|other(deduct) | sick|vacation|reserve(paid)
        note: { type: String, default: '' },
        manager_approved: { type: Boolean, default: false },
        accounting_approved: { type: Boolean, default: false },
      }],
      default: [],
    },

    // Per-day PARTIAL-absence approvals: committed days the employee DID show up
    // for but worked > 1h short of their committed hours. Hours are recomputed
    // live (commitment − worked); this only records the accountant's per-day
    // approval. Approved hours are deducted proportionally (separate from the
    // whole-day absence_entries above).
    partial_absence_entries: {
      type: [{
        date: { type: String },                          // YYYY-MM-DD
        excused: { type: Boolean, default: false },      // approved as justified → NOT deducted
        reason: { type: String, default: '' },           // optional reason for excusing
      }],
      default: [],
    },
    // Per-day EXTRA-hours approvals: days the employee worked beyond their
    // commitment (over-commitment) or on a day off. Default = not approved (not
    // paid); approving a day pays its extra hours at the committed hourly value.
    partial_extra_entries: {
      type: [{
        date: { type: String },                          // YYYY-MM-DD
        approved: { type: Boolean, default: false },     // approved → PAY the extra hours
        reason: { type: String, default: '' },           // optional reason
      }],
      default: [],
    },

    // Whole-day-absence ↔ extra-hours OFFSET approvals. When a committed day was
    // missed but a similar-sized extra day (±1h) was worked elsewhere, the
    // accountant can approve an offset: the absence day is NOT deducted and the
    // matched extra day is NOT paid (they cancel out). Keyed by the absence date.
    absence_offset_entries: {
      type: [{
        absence_date: { type: String },   // YYYY-MM-DD — the missed committed day
        extra_date: { type: String },     // YYYY-MM-DD — the extra-hours day it cancels against
        approved: { type: Boolean, default: false },
      }],
      default: [],
    },

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
  // Sick requests (EmployeeRequest._id) approved into this month. Same idea as
  // vacation_request_ids: approving a sick request adds work-day-counted days
  // to manual.sick_days and records the source id here (idempotent).
  sick_request_ids: { type: [mongoose.Schema.Types.ObjectId], ref: 'EmployeeRequest', default: [] },

  status: {
    type: String,
    enum: ['draft', 'finalized'],
    default: 'draft',
  },
  finalized_at: { type: Date, default: null },
  finalized_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Payslip payment state. Set when the payslip is sent to the employee
  // ("אושר ושולם") — marks the month approved+paid and archives the payslip
  // (see SavedPayslip). Distinct from `status` (draft/finalized editing lock).
  payslip_paid:    { type: Boolean, default: false },
  payslip_paid_at: { type: Date, default: null },
  payslip_sent_to: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

payrollMonthSchema.index({ employee_id: 1, month: 1 }, { unique: true });
payrollMonthSchema.index({ branch_id: 1, month: 1 });

module.exports = mongoose.model('PayrollMonth', payrollMonthSchema);
