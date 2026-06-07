const mongoose = require('mongoose');

/**
 * Employee = payroll record for a person working at a branch.
 *
 * This is SEPARATE from User (which is the login/auth record). Most of the ~70
 * employees do not have login credentials. A few (managers/admins) do — for
 * them we link via `user_id`. The business key that ties punches to employees
 * is `israeli_id` (matches the userId stored on the TIMEDOX clock).
 *
 * Fields mirror the structure of the salary CSV:
 *   - salary_type: hourly (שעתי) or global (גלובלי)
 *   - hourly_rate / global_salary / required_hours
 *   - amuta_distribution: how the salary is split across legal entities
 *   - extras: travel, meal vouchers, recreation (הבראה), etc.
 *   - loans[]: installment tracking for deductions
 *   - bonuses[]: fixed or per-hour bonuses
 *   - notes: free-text exceptions (pension exemption, maternity, etc.)
 */

const loanSchema = new mongoose.Schema({
  total_amount: { type: Number, required: true },           // e.g. 50000
  installment_amount: { type: Number, required: true },     // default monthly payment, e.g. 5000
  installments_total: { type: Number, required: true },     // e.g. 10
  installments_paid: { type: Number, default: 0 },          // legacy count tracker
  start_month: { type: String, default: '' },               // 'YYYY-MM' — first deduction month
  // Explicit per-month schedule (new model). Built on creation from
  // start_month + installment_amount × installments_total, editable per month
  // afterwards. When present it is the source of truth for both the monthly
  // deduction and the remaining balance; legacy loans (empty payments) fall
  // back to the installments_paid/total rule.
  payments: {
    type: [{
      month: { type: String, required: true },              // 'YYYY-MM'
      amount: { type: Number, default: 0 },                 // ₪ deducted that month
      _id: false,
    }],
    default: [],
  },
  started_at: { type: Date, default: null },
  notes: { type: String, default: '' },
}, { _id: true });

const bonusSchema = new mongoose.Schema({
  type: { type: String, enum: ['fixed', 'per_hour', 'per_day'], default: 'fixed' },
  amount: { type: Number, required: true },                 // NIS
  reason: { type: String, default: '' },                    // e.g. "הובלת קבוצה"
  effective_from: { type: Date, default: null },
  effective_to: { type: Date, default: null },
  active: { type: Boolean, default: true },
}, { _id: true });

const amutaSplitSchema = new mongoose.Schema({
  amuta_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Amuta', required: true },
  // One of the two pricing modes (null if not used in this amuta for this employee):
  hourly_rate: { type: Number, default: null },             // for שעתי
  global_salary: { type: Number, default: null },           // for גלובלי
  global_ot_rate: { type: Number, default: null },          // שעות נוספות גלובלי
  required_hours: { type: Number, default: null },          // מחוייבת ל-X שעות חודשיות
}, { _id: false });

/**
 * Per-branch rate override — used when an employee works across multiple
 * branches with different pay rates per branch. The `branch_id` field is the
 * branch where the employee can also be clocked in (in addition to her home
 * branch). When she punches at that branch, the calculator uses the rates
 * here instead of the primary `amuta_distribution[0]` rates.
 *
 * If empty (default), all hours are paid at the primary rate regardless of
 * where they happened. The home branch (`Employee.branch_id`) does NOT need
 * to appear here — its rate comes from `amuta_distribution`.
 */
const branchRateSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  hourly_rate: { type: Number, default: null },
  global_salary: { type: Number, default: null },
  global_ot_rate: { type: Number, default: null },
  required_hours: { type: Number, default: null },
}, { _id: false });

/**
 * Personal per-branch hourly bonus — agreed individually with this employee
 * (NOT branch-wide). bonus = rate × hours worked at branch_id. Surfaced as an
 * auto-computed value in the payroll table's dedicated bonus column and added
 * to her estimated total. e.g. ליאל: +3₪/hr at Herzliya.
 */
const hourlyBonusSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  rate: { type: Number, default: 0 },        // ₪ per hour worked at this branch
  reason: { type: String, default: '' },     // e.g. "בונוס אישי - הרצליה"
}, { _id: false });

const employeeSchema = new mongoose.Schema({
  // Identity
  full_name: { type: String, required: true, trim: true },
  israeli_id: { type: String, default: '', index: true, trim: true }, // 9-digit ת"ז, matches clock userId
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // optional login link

  // Contact (optional — most fields live on User if they have a login)
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  address: { type: String, default: '' },

  // Role
  position: { type: String, default: '' },                  // e.g. גננת / סייעת / מנהלת
  start_date: { type: Date, default: null },

  // Salary configuration
  salary_type: { type: String, enum: ['hourly', 'global'], default: 'hourly' },
  // Whether the configured global_salary / hourly_rate values are net or gross.
  // The CSV frequently writes "נטו 7000" or "ברוטו 8000" — we preserve this
  // distinction so payroll calculation can apply the correct tax treatment.
  salary_is_net: { type: Boolean, default: false },
  amuta_distribution: { type: [amutaSplitSchema], default: [] },
  // Per-branch rate overrides for cross-branch workers. Empty by default.
  branch_rates: { type: [branchRateSchema], default: [] },
  // Personal per-branch hourly bonuses (individually agreed). Empty by default.
  hourly_bonuses: { type: [hourlyBonusSchema], default: [] },

  // Extras (monthly defaults, can be overridden per PayrollMonth entry)
  // Two travel modes:
  //   - 'per_day': נסיעות = travel_per_day × ימי עבודה (most common, default 16₪/day)
  //   - 'monthly_flat': נסיעות = travel_monthly_flat each month regardless of days
  // The monthly admin UI can override either with a per-month manual value.
  travel_mode: { type: String, enum: ['per_day', 'monthly_flat'], default: 'per_day' },
  travel_per_day: { type: Number, default: 16 },            // ₪/יום ב-mode='per_day'
  travel_monthly_flat: { type: Number, default: 0 },        // ₪/חודש ב-mode='monthly_flat'

  // Kept for backward compatibility — old name. New code should use travel_monthly_flat.
  travel_allowance: { type: Number, default: 0 },
  meal_vouchers: { type: Number, default: 0 },              // סיבוס
  recreation_annual: { type: Number, default: 0 },          // הבראה (annual)

  // Weekly working days (0=Sun … 6=Sat). Used to count sick/absence days:
  // only weekdays in this set count, and Saturday is always off. Default is
  // Sun–Thu; adjust per employee from their committed schedule.
  work_days: { type: [Number], default: [0, 1, 2, 3, 4] },

  // Tax / pension flags
  pension_exempt: { type: Boolean, default: false },
  bituach_leumi_exempt: { type: Boolean, default: false },
  has_army_reserve_form: { type: Boolean, default: false },

  // Ongoing financial state
  loans: { type: [loanSchema], default: [] },
  bonuses: { type: [bonusSchema], default: [] },

  // Notes / exceptions / free-form
  notes: { type: String, default: '' },
  // Permanent payroll-table note — shown every month (vs the per-month note on
  // PayrollMonth.manual.notes which is one-time).
  permanent_note: { type: String, default: '' },

  // Status
  is_active: { type: Boolean, default: true },
  inactive_reason: { type: String, default: '' }, // why the employee was deactivated
  on_maternity_leave: { type: Boolean, default: false },
  maternity_leave_from: { type: Date, default: null },
  maternity_leave_to: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// Useful compound indexes
employeeSchema.index({ branch_id: 1, is_active: 1 });
employeeSchema.index({ israeli_id: 1, is_active: 1 });

/**
 * Pre-save normalization: Israeli IDs are exactly 9 digits. Users (and the
 * TIMEDOX clock!) sometimes strip the leading zero, leaving 8 digits. We
 * normalize on every save so comparisons against clock-reported punches
 * always line up regardless of zero-padding.
 *
 * Rules:
 * - Keep only digit characters (drop spaces, hyphens, etc.)
 * - Left-pad with zeros to 9 digits if the result is 7–8 digits long
 * - Leave alone if empty or >9 digits (let the user see their invalid input)
 */
employeeSchema.pre('save', function normalizeIsraeliId(next) {
  if (this.israeli_id != null) {
    const digits = String(this.israeli_id).replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 9) {
      this.israeli_id = digits.padStart(9, '0');
    } else {
      this.israeli_id = digits; // pass through (may be empty or invalid)
    }
  }
  next();
});

/**
 * Post-save hook: if an Employee gets an `israeli_id` (either at creation or
 * via an update that sets it for the first time), link any orphaned Punches
 * that were stored with `employee_id: null` but the same `israeli_id` in the
 * same branch. This closes the loop for the common flow where punches arrive
 * from the clock BEFORE the corresponding employee has been fully configured
 * in the server (CSV had no Israeli IDs, we set them later).
 */
employeeSchema.post('save', async function relinkOrphanPunches(doc) {
  try {
    if (!doc || !doc.israeli_id) return;
    // Lazy-require to avoid a circular import loop with models/index.js
    const Punch = mongoose.model('Punch');
    // Drop the branch_id filter so we also catch cross-branch orphans:
    // an employee from branch A who occasionally punches at branch B leaves
    // orphan punches in branch B's records. After saving the employee we
    // link those too. Salary calc aggregates by employee_id (not branch_id),
    // so every hour ends up under the correct home branch.
    const result = await Punch.updateMany(
      { israeli_id: doc.israeli_id, employee_id: null },
      { $set: { employee_id: doc._id } }
    );
    if (result.modifiedCount > 0) {
      // eslint-disable-next-line no-console
      console.log(`[Employee] relinked ${result.modifiedCount} orphan punches to ${doc.full_name} (${doc.israeli_id})`);
    }
  } catch (err) {
    // Never fail the save because of the backfill
    // eslint-disable-next-line no-console
    console.error('[Employee] relinkOrphanPunches failed:', err.message);
  }
});

module.exports = mongoose.model('Employee', employeeSchema);
