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
      paused: { type: Boolean, default: false },            // month skipped — loan extended by one
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

/**
 * Standing weekly hours for an employee who does NOT clock in (office staff, a
 * manager, someone at a site without a clock). The system materializes her
 * punches from this schedule day by day, up to today — never in advance, so the
 * hours report always reflects work actually done rather than a forecast.
 *
 * `exceptions` is how a single arbitrary day gets different hours or is skipped
 * entirely; it always beats the weekly pattern. Deleting a generated punch from
 * the attendance grid writes an `off` exception, so the day is not resurrected
 * on the next pass.
 *
 * A real clock punch on a scheduled day is never overwritten — that day is left
 * alone and raised as a conflict in "בעיות בהחתמה" for a human to decide.
 */
const fixedScheduleDaySchema = new mongoose.Schema({
  weekday: { type: Number, required: true, min: 0, max: 6 }, // 0=Sunday … 6=Saturday
  in: { type: String, required: true },   // 'HH:mm' Israel-local
  out: { type: String, required: true },  // 'HH:mm' Israel-local
}, { _id: false });

const fixedScheduleExceptionSchema = new mongoose.Schema({
  date: { type: String, required: true },        // 'YYYY-MM-DD'
  off: { type: Boolean, default: false },        // did not work that day at all
  in: { type: String, default: '' },             // override hours (ignored when off)
  out: { type: String, default: '' },
  note: { type: String, default: '' },
}, { _id: false });

/**
 * A single finger read off a ZKTeco device. `b64` is the raw device template
 * blob (base64) exactly as the clock returned it — it is written back verbatim
 * to another device of the same family. Biometric data: never returned to the
 * browser (see the `select: false` on the field below).
 */
const fingerTemplateSchema = new mongoose.Schema({
  fid: { type: Number, required: true },   // finger index 0–9
  valid: { type: Number, default: 1 },
  size: { type: Number, default: 0 },
  b64: { type: String, required: true },
}, { _id: false });

/**
 * Where this employee's fingerprint currently lives. `captured_*` describe the
 * copy we hold; `synced_branches` is the per-branch write log, so the sweeper
 * knows which clocks still need the finger and the UI can show "מסונכרן".
 */
const syncedBranchSchema = new mongoose.Schema({
  branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  synced_at: { type: Date, default: null },      // set when the agent confirmed the write
  attempted_at: { type: Date, default: null },   // last time a write was queued (drives retry backoff)
  command_id: { type: mongoose.Schema.Types.ObjectId, ref: 'AgentCommand', default: null },
  finger_count: { type: Number, default: 0 },
  status: { type: String, enum: ['queued', 'ok', 'failed'], default: 'queued' },
  error: { type: String, default: '' },
}, { _id: false });

const fingerprintSchema = new mongoose.Schema({
  templates: { type: [fingerTemplateSchema], default: [] },
  finger_count: { type: Number, default: 0 },
  captured_at: { type: Date, default: null },
  captured_branch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  synced_branches: { type: [syncedBranchSchema], default: [] },
}, { _id: false });

const employeeSchema = new mongoose.Schema({
  // Identity
  full_name: { type: String, required: true, trim: true },
  israeli_id: { type: String, default: '', index: true, trim: true }, // 9-digit ת"ז, matches clock userId
  // Extra IDs the CLOCK sends for this worker when it was enrolled with a wrong
  // ת"ז (typo/digit-shift). Punches with these IDs are matched to this employee
  // too, so they don't come in as "unidentified". Stored normalized to 9 digits.
  clock_aliases: { type: [String], default: [], index: true },
  // Fingerprint templates read off a clock, kept server-side so a cross-branch
  // worker can be pushed onto EVERY branch she works at without enrolling her
  // finger again on each device (and so a wiped/replaced device can be
  // refilled). `select: false` — the blobs never leave the server by accident:
  // any query that needs them must ask with .select('+fingerprint').
  fingerprint: {
    type: fingerprintSchema,
    default: null,
    select: false,
  },
  // Payslip employee number assigned by the accountant's payroll software. Lets
  // the accountant locate each employee by the same number shown on the תלוש.
  employee_number: { type: String, default: '', trim: true },
  // Freelancer: issues an invoice for her hours instead of getting a payslip.
  // Shown in the salary table but excluded from the accountant PDF/Excel export
  // and from the payslip audit (there is no payslip for her).
  is_freelancer: { type: Boolean, default: false },
  /**
   * A role-holder the system does NOT pay — an owner-manager who draws nothing,
   * a volunteer, someone on the org chart for responsibility rather than wages.
   *
   * She is a full employee in every other respect: a branch, a role, a login,
   * an enrollment on the clock, and she can be a branch manager with tasks and
   * approvals. She is simply absent from the salary table, the accountant
   * export, and the missing-punch chase — so she can never be paid by accident
   * and never inflates a month's totals.
   *
   * Reversible with one switch and NO data migration: turn it back on, give her
   * a rate, and she is payable from that month. `salary_started_at` records
   * when that happened, so it is clear that earlier months were unpaid by
   * design rather than by omission.
   */
  receives_salary: { type: Boolean, default: true },
  salary_started_at: { type: Date, default: null },
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

  // Standing manual travel amount entered by accounting. When set (non-null) it
  // is the travel paid EVERY month going forward (overrides the auto per-day /
  // flat calc) until accounting changes or clears it. A month-specific override
  // in PayrollMonth.manual.travel_override still takes precedence for that month.
  travel_override: { type: Number, default: null },

  // Bank details for salary payment (sensitive — exposed only to accounting/admin).
  bank_number: { type: String, default: '' },   // קוד בנק (e.g. 10 = לאומי)
  bank_branch: { type: String, default: '' },    // מספר סניף
  bank_account: { type: String, default: '' },   // מספר חשבון
  // Whose account it is, when that is not the employee. A 16-year-old often has
  // no account of her own and is paid into a parent's; the accountant must see
  // that the name on the transfer legitimately differs from the payslip, rather
  // than reading it as a typo. Empty = the account is the employee's own.
  bank_account_holder: { type: String, default: '' },
  pension_fund: { type: String, default: '' },     // קופת פנסיה (שם/מספר) — for the accountant
  education_fund: { type: String, default: '' },   // קרן השתלמות (שם/מספר)

  // Kept for backward compatibility — old name. New code should use travel_monthly_flat.
  travel_allowance: { type: Number, default: 0 },
  meal_vouchers: { type: Number, default: 0 },              // סיבוס
  recreation_annual: { type: Number, default: 0 },          // הבראה (annual)

  // Standing weekly hours for employees who don't clock in — see the schema
  // comment above. Disabled by default: everyone punches unless told otherwise.
  fixed_schedule: {
    enabled: { type: Boolean, default: false },
    days: { type: [fixedScheduleDaySchema], default: [] },
    exceptions: { type: [fixedScheduleExceptionSchema], default: [] },
    // Don't generate anything before this date (e.g. the day the arrangement
    // started). Null = from the employee's start_date, or from the month shown.
    start_date: { type: String, default: null }, // 'YYYY-MM-DD'
    note: { type: String, default: '' },
  },

  // Weekly working days (0=Sun … 6=Sat). Used to count sick/absence days:
  // only weekdays in this set count, and Saturday is always off. Default is
  // Sun–Thu; adjust per employee from their committed schedule.
  work_days: { type: [Number], default: [0, 1, 2, 3, 4] },

  // Sick-pay policy (חוק דמי מחלה):
  //   'statutory' — day 1 unpaid, days 2-3 at 50%, day 4+ at 100% (default)
  //   'full'      — every sick day paid 100% from the first day (per contract)
  // A per-certificate "pay_from_first_day" toggle can force full for one cert.
  sick_pay_policy: { type: String, enum: ['statutory', 'full'], default: 'statutory' },
  // Opening sick-day balance as of the END of as_of_month. The system accrues
  // 1.5 days for each full month after as_of_month (capped at 90) and subtracts
  // sick days used. Leave days=0/as_of_month=null to start accrual from hire.
  sick_balance_opening: {
    days: { type: Number, default: 0 },
    as_of_month: { type: String, default: null }, // 'YYYY-MM'
  },
  // Manual override of the ₪ value of one sick day. When null the payroll
  // derives it from the employee's daily wage (rate × daily hours, or global
  // salary ÷ monthly work-days).
  sick_daily_value_override: { type: Number, default: null },

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
  // Pregnancy tracking. Drives the accountant-facing badge (protected period +
  // 40h exam-hours balance) — DISPLAY/ALERT ONLY, never auto-computes pay.
  // See חוק עבודת נשים: 40h exam hours, protected period (≥6mo seniority),
  // maternity leave, שמירת הריון. The pregnancy_exam EmployeeRequests carry the
  // actual hour draws; these fields are the status + dates.
  is_pregnant: { type: Boolean, default: false },
  due_date: { type: Date, default: null },
  gave_birth_date: { type: Date, default: null },
  on_pregnancy_bedrest: { type: Boolean, default: false }, // שמירת הריון (NII-funded)
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
