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
  installment_amount: { type: Number, required: true },     // e.g. 5000
  installments_total: { type: Number, required: true },     // e.g. 10
  installments_paid: { type: Number, default: 0 },          // e.g. 3
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

  // Extras (monthly defaults, can be overridden per PayrollRun)
  travel_allowance: { type: Number, default: 0 },           // נסיעות
  meal_vouchers: { type: Number, default: 0 },              // סיבוס
  recreation_annual: { type: Number, default: 0 },          // הבראה (annual)

  // Tax / pension flags
  pension_exempt: { type: Boolean, default: false },
  bituach_leumi_exempt: { type: Boolean, default: false },
  has_army_reserve_form: { type: Boolean, default: false },

  // Ongoing financial state
  loans: { type: [loanSchema], default: [] },
  bonuses: { type: [bonusSchema], default: [] },

  // Notes / exceptions / free-form
  notes: { type: String, default: '' },

  // Status
  is_active: { type: Boolean, default: true },
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
