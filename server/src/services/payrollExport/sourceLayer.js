'use strict';

/**
 * Payroll export — SOURCE LAYER.
 *
 * This is step one of letting an accountant pull our payroll into their own
 * payroll software (currently targeting שקלולית / TML). It is deliberately
 * INDEPENDENT of any target format: it turns one month of our internal payroll
 * rows into a clean, stable "canonical" shape, and it audits each employee so a
 * missing bank account fails ONE person with a clear message instead of the
 * whole file.
 *
 * WHY A CANONICAL LAYER AT ALL. The target file layout (column order, element
 * codes, encoding) is not known yet — it comes from the accountant. So we split
 * the work: this layer is "everything we have about a person this month, named
 * once, correctly"; a later adapter picks from it per שקלולית's spec. When the
 * spec changes, the adapter changes and this layer does not.
 *
 * THE ONE RULE THAT MATTERS: we never recompute a salary number here. Every
 * figure is pulled from the exact field the on-screen payroll and the existing
 * accountant PDF already read (`buildAccountantHtml` in payrollMonth.controller).
 * A second implementation of Israeli payroll maths is a wrong number waiting for
 * the month someone edits only one of them. So `toCanonicalEmployee` is pure
 * plumbing: read authoritative fields, rename them, hand them on.
 *
 * INPUT. `rows` are the objects returned by the payroll month endpoint
 * (`getMonth` / `fetchMonthData`). Each row already merges the auto snapshot
 * (`row.breakdown`) with the admin's manual fields (`row.manual`) and the
 * derived blocks (`holiday_pay_auto`, `sick_info`, `vacation_eff_days`,
 * `partial_absence`, `bonus`). Bank fields (`bank_number` etc.) are only present
 * when the caller had accounting/admin permission — so this layer MUST be fed
 * rows fetched as an accounting/admin user, or every employee will read as
 * "missing bank" (which `auditMonth` detects and reports as a setup error, not
 * seventy per-employee failures).
 *
 * OUTPUT. `buildExportSource(month, rows)` returns:
 *   { month, ready[], failed[], skipped[], warned[], summary }
 * `ready` are canonical employees that passed validation (safe to export);
 * `failed` carry per-employee blocking errors; `skipped` are freelancers /
 * inactive people left out on purpose; `warned` passed but have a note the
 * accountant should see. This is the "logs per single employee" the brief asks
 * for.
 */

// ── small helpers ───────────────────────────────────────────────────────────

// Money to agorot-safe 2 decimals. Never used to COMPUTE a total, only to tidy
// a figure we were handed.
function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function num(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

// PayrollMonth's "number OR free text" fields (gift_card, cibus, miluim, the
// manual recreation override). We surface the numeric amount when it is a
// number, and keep any free text separately as an instruction for the
// accountant — putting prose where a number is expected is how a component
// silently zeroes out.
function numberOrText(field) {
  if (!field || typeof field !== 'object') return { amount: 0, text: '' };
  if (field.kind === 'number') return { amount: money(field.amount), text: '' };
  if (field.kind === 'text') return { amount: 0, text: String(field.text || '').trim() };
  return { amount: 0, text: '' };
}

// A 9-digit Israeli ת״ז, zero-padded. We do NOT reject a "wrong" checksum here
// (some real IDs in the system are foreign passports / temporary numbers); we
// only flag when it is clearly unusable — empty or non-numeric.
function normalizeIsraeliId(id) {
  const digits = String(id || '').replace(/\D/g, '');
  return digits;
}

// ── canonical mapping (pure) ─────────────────────────────────────────────────

/**
 * Map ONE payroll row to the canonical employee-month shape.
 * Pure: no I/O, no recomputation. Safe to unit-test with a hand-built row.
 */
function toCanonicalEmployee(row) {
  const b = row.breakdown || {};
  const c = b.components || {};
  const d = b.deductions || {};
  const tb = c.teken_breakdown || {};
  const manual = row.manual || {};
  const isGlobal = row.salary_type === 'global';

  // Holiday pay: a manual figure wins over the auto one (mirrors the accountant PDF).
  const holidayPay = num(manual.holiday_pay) > 0
    ? money(manual.holiday_pay)
    : money(row.holiday_pay_auto?.total_pay);
  const holidayDays = row.holiday_pay_auto?.total_days || 0;

  // Vacation: effective days actually drawn from balance, else the manual entry.
  const vacationDays = row.vacation_eff_days != null
    ? num(row.vacation_eff_days)
    : num(manual.vacation_days);

  // Salary completion (השלמת שכר) is a teken-only line, and only when enabled.
  const salaryCompletion = (isGlobal && manual.include_salary_completion !== false)
    ? money(tb.completion)
    : 0;

  const giftCard = numberOrText(manual.gift_card);
  const cibus = numberOrText(manual.cibus);
  const miluim = numberOrText(manual.miluim);

  // Advance deduction is an INSTRUCTION (preset label or free text), not a
  // number the engine resolved — the accountant reads it and sets the figure.
  const advanceDirective = (manual.advance_deduction_preset?.label
    || manual.advance_deduction_text
    || '').trim();

  return {
    employee: {
      employee_number: String(row.employee_number || '').trim(), // key in שקלולית
      israeli_id: normalizeIsraeliId(row.israeli_id),
      full_name: row.full_name || '',
      salary_type: row.salary_type || 'hourly',                  // 'hourly' | 'global'
      salary_is_net: !!row.salary_is_net,
      is_freelancer: !!row.is_freelancer,
      is_active: row.is_active !== false,
      inactive_reason: row.inactive_reason || '',
      branch_name: row.branch_name || '',
      position: row.position || '',
      bank: {
        // `undefined` (field absent) means "fetched without bank permission";
        // '' means "genuinely empty for this employee". auditMonth tells them apart.
        code: row.bank_number,
        branch: row.bank_branch,
        account: row.bank_account,
        holder: row.bank_account_holder || '',
      },
    },

    month: row.month || b.month || '',

    // Raw counts — for a target that ingests quantities and prices them itself.
    quantities: {
      worked_hours: num(b.hours?.total),
      regular_hours: num(b.hours?.regular),
      ot_125_hours: num(b.hours?.ot_125),
      ot_150_hours: num(b.hours?.ot_150),
      days_worked: num(b.hours?.days_worked),
      sick_days: num(manual.sick_days),
      vacation_days: vacationDays,
      holiday_days: num(holidayDays),
      absence_deduct_days: num(row.absence?.deductible_days),
      partial_absence_hours: num(row.partial_absence?.effective_hours),
    },

    // Money components — for a target that ingests resolved amounts. Each is
    // pulled from the authoritative field; none is summed here.
    earnings: {
      base_salary: money(c.base_salary),
      salary_completion: salaryCompletion,
      travel: money(c.travel),
      recreation: money(c.recreation_monthly),
      meal_vouchers: money(c.meal_vouchers),
      holiday_pay: holidayPay,
      sick_pay: money(row.sick_info?.pay),
      bonus: money(row.bonus?.effective),
      august_bonus: money(c.closure_completion_bonus),
      gift_card: giftCard.amount,
      cibus: cibus.amount,
      miluim: miluim.amount,
    },

    deductions: {
      loans: money(d.loans),
      absence: money(d.absence),
      partial_absence: money(row.partial_absence?.deduction),
    },

    // Free-text the accountant must read and act on (never silently a number).
    directives: {
      advance_deduction: advanceDirective,
      travel_note: (manual.travel_note || '').trim(),
      gift_card_note: giftCard.text,
      cibus_note: cibus.text,
      miluim_note: miluim.text,
      notes: [row.permanent_note, manual.notes].filter(Boolean).join(' · '),
    },

    totals: {
      // The same "סה״כ משוער" the screen and the accountant PDF show. Estimate,
      // pre-tax/pension — the accountant produces the net. Surfaced for control
      // totals, never as an exported pay component.
      estimated_total: money(b.estimated_total),
    },

    flags: {
      status: row.status || 'draft',                 // 'draft' | 'finalized'
      payslip_paid: !!row.payslip_paid,
      calc_warnings: Array.isArray(b.warnings) ? b.warnings.slice() : [],
    },
  };
}

// ── per-employee audit ───────────────────────────────────────────────────────

/**
 * Validate ONE canonical employee for export.
 * Returns { errors, warnings } — each a list of Hebrew, accountant-readable
 * strings. `errors` block that employee from the file; `warnings` do not.
 */
function auditEmployee(ce) {
  const errors = [];
  const warnings = [];
  const name = ce.employee.full_name || 'עובד ללא שם';

  // Blocking: identity + how the target locates the person.
  if (!ce.employee.employee_number) {
    errors.push(`${name}: חסר מספר עובד — לא ניתן לשייך לעובד בתוכנת השכר.`);
  }
  const id = ce.employee.israeli_id;
  if (!id) {
    errors.push(`${name}: חסר מספר תעודת זהות.`);
  } else if (id.length !== 9) {
    warnings.push(`${name}: תעודת זהות באורך ${id.length} ספרות (לא 9) — ודא שזה תקין (דרכון/מספר זמני).`);
  }

  // Blocking: no bank account, no salary payment.
  if (ce.employee.bank.account === undefined) {
    // Field absent = fetched without bank permission. This is a setup problem,
    // not this employee's problem. auditMonth escalates it once, globally.
    errors.push(`${name}: פרטי בנק אינם זמינים (הרשאת צפייה חסרה).`);
  } else if (!String(ce.employee.bank.account).trim()) {
    errors.push(`${name}: חסר מספר חשבון בנק.`);
  } else {
    if (!String(ce.employee.bank.code || '').trim()) warnings.push(`${name}: חסר קוד בנק.`);
    if (!String(ce.employee.bank.branch || '').trim()) warnings.push(`${name}: חסר מספר סניף בנק.`);
  }

  // Warning: nothing to pay this month — probably fine (unpaid leave), but the
  // accountant should decide, not have the person silently dropped.
  const anyEarning = Object.values(ce.earnings).some(v => num(v) > 0);
  if (!anyEarning) {
    warnings.push(`${name}: אין רכיבי שכר חיוביים החודש.`);
  }

  // Warning: carry the calc engine's own warnings (missing punches, etc.).
  for (const w of ce.flags.calc_warnings) warnings.push(`${name}: ${w}`);

  return { errors, warnings };
}

// ── month-level assembly ─────────────────────────────────────────────────────

/**
 * Turn a month's rows into an export-ready bundle with per-employee logging.
 *
 * @param {string} month  'YYYY-MM'
 * @param {object[]} rows  rows from fetchMonthData(...).rows
 * @param {object} [opts]
 * @param {boolean} [opts.includeInactive=false]     include left/ended employees
 * @param {boolean} [opts.includeFreelancers=false]  include invoice freelancers
 */
function buildExportSource(month, rows, opts = {}) {
  const { includeInactive = false, includeFreelancers = false } = opts;
  const list = Array.isArray(rows) ? rows : [];

  const ready = [];
  const failed = [];
  const skipped = [];
  const warned = [];

  for (const row of list) {
    const ce = toCanonicalEmployee(row);
    const name = ce.employee.full_name || 'עובד ללא שם';
    const ref = {
      employee_id: String(row.employee_id || ''),
      employee_number: ce.employee.employee_number,
      full_name: name,
    };

    // Skip categories BEFORE validating — a freelancer has no bank/payslip on
    // purpose, so failing her for "missing bank" would be noise.
    if (ce.employee.is_freelancer && !includeFreelancers) {
      skipped.push({ ...ref, reason: 'פרילנסר — מפיק/ה חשבונית, אין תלוש.' });
      continue;
    }
    if (!ce.employee.is_active && !includeInactive) {
      const why = ce.employee.inactive_reason || 'לא צוינה סיבה';
      skipped.push({ ...ref, reason: `עובד/ת לא פעיל/ה (${why}).` });
      continue;
    }

    const { errors, warnings } = auditEmployee(ce);
    if (errors.length) {
      failed.push({ ...ref, errors, warnings });
      continue;
    }
    ready.push(ce);
    if (warnings.length) warned.push({ ...ref, warnings });
  }

  // Global setup check: if EVERY row lacked bank fields entirely, the source
  // was fetched without accounting permission — say so once, loudly, instead of
  // reporting N identical per-employee failures.
  const consideredCount = ready.length + failed.length;
  const allBankAbsent = consideredCount > 0
    && list.every(r => r.bank_account === undefined);
  const setup_error = allBankAbsent
    ? 'הנתונים נטענו ללא הרשאת צפייה בפרטי בנק — יש להריץ את הייצוא כמשתמש הנהלת חשבונות/מנהל.'
    : null;

  return {
    month,
    setup_error,
    ready,
    failed,
    skipped,
    warned,
    summary: {
      total: list.length,
      ready: ready.length,
      failed: failed.length,
      skipped: skipped.length,
      warned: warned.length,
    },
  };
}

module.exports = {
  toCanonicalEmployee,
  auditEmployee,
  buildExportSource,
  // exported for tests / adapters
  _internals: { money, num, numberOrText, normalizeIsraeliId },
};
