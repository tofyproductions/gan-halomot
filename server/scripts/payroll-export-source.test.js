#!/usr/bin/env node
/**
 * The source layer for the accountant export, tested against hand-built rows.
 *
 * What matters here is NOT "does 48.5 × 176 come out right" — that maths lives
 * in payrollCalc and has its own tests. What matters is:
 *   1. every figure is COPIED from the authoritative field, not recomputed;
 *   2. one person missing a bank account fails ONE person, with a readable line,
 *      not the whole file;
 *   3. freelancers / inactive staff are skipped on purpose, not failed;
 *   4. a source fetched without bank permission is caught as a setup error once.
 *
 * The rows below mimic the shape of fetchMonthData(...).rows.
 *
 *   node scripts/payroll-export-source.test.js
 */

const assert = require('assert');
const {
  toCanonicalEmployee,
  auditEmployee,
  buildExportSource,
} = require('../src/services/payrollExport/sourceLayer');

let passed = 0;
function ok(label) { console.log('  ✓ ' + label); passed++; }

// A complete, valid hourly employee row.
function validHourlyRow(over = {}) {
  return {
    employee_id: 'e1',
    full_name: 'רונית לוי',
    israeli_id: '312345678',
    employee_number: '1047',
    is_freelancer: false,
    is_active: true,
    salary_type: 'hourly',
    salary_is_net: false,
    branch_name: 'תל אביב',
    position: 'סייעת',
    bank_number: '10',
    bank_branch: '913',
    bank_account: '45012345',
    bank_account_holder: '',
    permanent_note: '',
    month: '2026-09',
    breakdown: {
      hours: { total: 176.5, regular: 170, ot_125: 6.5, ot_150: 0, days_worked: 22 },
      rates: { hourly_rate: 48.5 },
      components: {
        base_salary: 8560.25, travel: 352, recreation_monthly: 209,
        meal_vouchers: 0, bonuses: 0, closure_completion_bonus: 0,
        teken_breakdown: {},
      },
      deductions: { loans: 500, absence: 0 },
      estimated_total: 9121.25,
      warnings: [],
    },
    bonus: { effective: 300 },
    holiday_pay_auto: { total_pay: 0, total_days: 0 },
    sick_info: { pay: 0 },
    partial_absence: { deduction: 0, effective_hours: 0 },
    manual: {
      sick_days: 0, vacation_days: 1, holiday_pay: 0,
      gift_card: { kind: 'number', amount: 150 },
      cibus: { kind: 'empty' },
      miluim: { kind: 'empty' },
      recreation: { kind: 'number', amount: 209 },
      advance_deduction_text: '', notes: '',
      include_salary_completion: true,
    },
    status: 'draft',
    payslip_paid: false,
    ...over,
  };
}

console.log('toCanonicalEmployee — copies authoritative fields');
{
  const ce = toCanonicalEmployee(validHourlyRow());
  assert.strictEqual(ce.employee.employee_number, '1047');
  assert.strictEqual(ce.employee.israeli_id, '312345678');
  assert.strictEqual(ce.employee.bank.account, '45012345');
  // Amounts copied verbatim — no rounding drift, no re-derivation.
  assert.strictEqual(ce.earnings.base_salary, 8560.25);
  assert.strictEqual(ce.earnings.travel, 352);
  // הבראה is the table's own column. components.recreation_monthly is a leg
  // payrollCalc hard-zeroes; reading it meant August's הבראה never exported.
  assert.strictEqual(ce.earnings.recreation, 209);
  assert.strictEqual(
    toCanonicalEmployee(validHourlyRow({ manual: { recreation: { kind: 'empty' } } })).earnings.recreation, 0,
    'recreation_monthly is not a source — only the table column is');
  assert.strictEqual(ce.earnings.bonus, 300);        // from row.bonus.effective
  assert.strictEqual(ce.earnings.gift_card, 150);    // number-or-text → number
  assert.strictEqual(ce.deductions.loans, 500);
  assert.strictEqual(ce.totals.estimated_total, 9121.25);
  assert.strictEqual(ce.quantities.worked_hours, 176.5);
  assert.strictEqual(ce.quantities.vacation_days, 1);
  ok('valid hourly row maps cleanly');
}

console.log('בונוס קבוע and בונוס חד פעמי travel as two separate figures');
{
  // No one_time_bonus on the row at all — the field must default to 0, not NaN.
  const ceNone = toCanonicalEmployee(validHourlyRow());
  assert.strictEqual(ceNone.earnings.one_time_bonus, 0);
  ok('no one_time_bonus on the row → 0');

  const ceBoth = toCanonicalEmployee(validHourlyRow({
    bonus: { effective: 300 },
    one_time_bonus: { amount: 150, note: 'מתנת חג' },
  }));
  assert.strictEqual(ceBoth.earnings.bonus, 300, 'the standing figure is untouched');
  assert.strictEqual(ceBoth.earnings.one_time_bonus, 150, 'the one-off travels as its own figure');
  ok('קבוע and חד פעמי are copied as two distinct earnings, neither overwriting the other');
}

console.log('השלמת שכר אוטומטית and השלמת שכר חד פעמית travel as two separate figures');
{
  const ceNone = toCanonicalEmployee(validHourlyRow());
  assert.strictEqual(ceNone.earnings.one_time_salary_completion, 0);
  ok('no one_time_salary_completion on the row → 0');

  const ce = toCanonicalEmployee(validHourlyRow({
    one_time_salary_completion: { amount: 800, note: 'השלמה מחודש קודם' },
  }));
  assert.strictEqual(ce.earnings.one_time_salary_completion, 800, 'the manual one-off travels as its own figure');
  ok('one_time_salary_completion is copied independently of the automatic salary_completion');
}

console.log('holiday pay — manual overrides auto');
{
  const ce = toCanonicalEmployee(validHourlyRow({
    manual: { ...validHourlyRow().manual, holiday_pay: 420 },
    holiday_pay_auto: { total_pay: 999, total_days: 3 },
  }));
  assert.strictEqual(ce.earnings.holiday_pay, 420);  // manual wins
  ok('manual holiday_pay wins over auto');

  const ce2 = toCanonicalEmployee(validHourlyRow({
    holiday_pay_auto: { total_pay: 999, total_days: 3 },
  }));
  assert.strictEqual(ce2.earnings.holiday_pay, 999); // falls back to auto
  ok('auto holiday_pay used when no manual figure');
}

console.log('number-or-text — text is a directive, not a number');
{
  const ce = toCanonicalEmployee(validHourlyRow({
    manual: {
      ...validHourlyRow().manual,
      cibus: { kind: 'text', text: 'לא לזכות החודש' },
    },
  }));
  assert.strictEqual(ce.earnings.cibus, 0);
  assert.strictEqual(ce.directives.cibus_note, 'לא לזכות החודש');
  ok('text cibus → amount 0 + note kept');
}

console.log('advance deduction — instruction, never a silent number');
{
  const ce = toCanonicalEmployee(validHourlyRow({
    manual: { ...validHourlyRow().manual, advance_deduction_text: 'לנכות 500 ש"ח' },
  }));
  assert.strictEqual(ce.directives.advance_deduction, 'לנכות 500 ש"ח');
  ok('advance kept as a directive string');
}

console.log('auditEmployee — blocks and warns');
{
  const good = toCanonicalEmployee(validHourlyRow());
  assert.deepStrictEqual(auditEmployee(good).errors, []);

  // A missing bank account WARNS and no longer blocks (30.09.2026). The
  // movements file carries no bank field, so holding her out protected nothing
  // and made שקלולית carry her previous payslip forward instead — גאליה כהן's
  // test import showed August's 9.6 hours for a September she worked 108.6.
  const noBank = toCanonicalEmployee(validHourlyRow({ bank_account: '' }));
  const rBank = auditEmployee(noBank);
  assert.strictEqual(rBank.errors.length, 0);
  assert.ok(rBank.warnings.some(w => w.includes('חסר מספר חשבון בנק')));
  ok('missing bank account → a warning, not a block — her salary still travels');

  const noNum = toCanonicalEmployee(validHourlyRow({ employee_number: '' }));
  assert.ok(auditEmployee(noNum).errors.some(e => e.includes('חסר מספר עובד')));
  ok('missing employee_number → blocking error');
}

console.log('buildExportSource — sorts ready / failed / skipped');
{
  const rows = [
    validHourlyRow(),                                                  // ready
    // Failed for a reason that still blocks: no employee number, so the row
    // cannot be matched to anybody in שקלולית. (A missing bank account used to
    // be this example; it is a warning now.)
    validHourlyRow({ employee_id: 'e2', full_name: 'דנה כהן', employee_number: '' }), // failed
    validHourlyRow({ employee_id: 'e3', full_name: 'יעל בר', is_freelancer: true }), // skipped
    validHourlyRow({ employee_id: 'e4', full_name: 'מיה גל', is_active: false, inactive_reason: 'סיום העסקה' }), // skipped
  ];
  const out = buildExportSource('2026-09', rows);
  assert.strictEqual(out.summary.total, 4);
  assert.strictEqual(out.summary.ready, 1);
  assert.strictEqual(out.summary.failed, 1);
  assert.strictEqual(out.summary.skipped, 2);
  assert.strictEqual(out.failed[0].full_name, 'דנה כהן');
  assert.ok(out.skipped.some(s => s.reason.includes('פרילנסר')));
  assert.ok(out.skipped.some(s => s.reason.includes('סיום העסקה')));
  assert.strictEqual(out.setup_error, null);
  ok('four rows sorted into ready/failed/skipped with reasons');
}

console.log('buildExportSource — no bank permission is a setup error, once');
{
  // Rows fetched without accounting permission: bank fields absent entirely.
  const noPerm = ['a', 'b', 'c'].map((id, i) => {
    const r = validHourlyRow({ employee_id: id, full_name: 'עובד ' + i });
    delete r.bank_number; delete r.bank_branch;
    delete r.bank_account; delete r.bank_account_holder;
    return r;
  });
  const out = buildExportSource('2026-09', noPerm);
  assert.ok(out.setup_error && out.setup_error.includes('הרשאת'));
  assert.strictEqual(out.summary.ready, 0);
  assert.strictEqual(out.summary.failed, 3);
  ok('all-bank-absent → single setup_error surfaced');
}

console.log('בונוס אוגוסט is an object, and its amount is what travels');
{
  // The live breakdown stores closure_completion_bonus as
  // { amount, days, dates, deduction, reason } — never a bare number. This
  // fixture used to say 0, and that lie is the whole reason the bug lived:
  // money() of an object is NaN → 0, so 35 employees' בונוס אוגוסט for 08.2026
  // never reached שקלולית at all. The accountant typed אילנה שימחי's ₪1,844 in
  // by hand, and because we had never filed the code there was nothing for
  // September to switch off — it rode forward into the next payslip.
  const row = validHourlyRow();
  row.breakdown.components.closure_completion_bonus = {
    amount: 1844.4,
    dates: ['2026-08-17', '2026-08-18'],
    days: [],
    deduction: 0,
    unapproved_days: [],
    reason: 'בונוס אוגוסט — ימי חופשת קיץ בתשלום',
  };
  const out = buildExportSource('2026-08', [row]);
  assert.strictEqual(out.ready[0].earnings.august_bonus, 1844.4,
    'the amount, not the object');
  ok('an object-shaped בונוס אוגוסט yields its amount, never 0');

  // Absent is still 0, and a bare number keeps working for old records.
  const none = buildExportSource('2026-08', [validHourlyRow()]);
  assert.strictEqual(none.ready[0].earnings.august_bonus, 0);
  ok('no בונוס אוגוסט is 0, not NaN');
}

// A תקן employee's rate is read off amuta_distribution, and one marked global
// with nothing there resolves to ₪0. She can still carry נסיעות and a bonus, so
// "nothing positive this month" stays quiet — and the table, the card and the
// file then agree, to the shekel, that she is owed almost nothing. Agreement is
// not correctness, so this one is held out of the file to be looked at.
console.log('a תקן employee with no salary the engine could find is held back');
{
  const bare = () => ({
    employee_id: 'g9', employee_number: '99', israeli_id: '999000099',
    full_name: 'תקן ללא שכר מוסכם', salary_type: 'global', is_active: true,
    bank_number: '10', bank_branch: '936', bank_account: '123456',
    manual: {},
    breakdown: {
      components: { base_salary: 0, travel: 272, teken_breakdown: null },
      deductions: {}, hours: { total: 136, regular: 136, days_worked: 17 },
      rates: {}, estimated_total: 272, warnings: [],
    },
  });
  const out = buildExportSource('2026-09', [bare()]);
  assert.strictEqual(out.ready.length, 0, 'she must not reach the file');
  const why = JSON.stringify(out.failed || out.blocked || []);
  assert.ok(/שכר מוסכם/.test(why), `the reason must name the missing salary — got ${why}`);
  ok('a global employee with neither a teken salary nor a base salary is blocked, by name');

  // The supported shape stays supported: no commitment on file, paid as one
  // resolved amount. Blocking her would stop a real salary going out.
  const plain = bare();
  plain.breakdown.components.base_salary = 8000;
  plain.breakdown.estimated_total = 8272;
  assert.strictEqual(buildExportSource('2026-09', [plain]).ready.length, 1);
  ok('a global employee paid a plain base_salary with no teken split still goes out');
}

console.log('\nAll payroll-export source tests passed (' + passed + ' checks).');
