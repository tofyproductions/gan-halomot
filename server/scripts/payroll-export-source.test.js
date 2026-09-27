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
  assert.strictEqual(ce.earnings.recreation, 209);
  assert.strictEqual(ce.earnings.bonus, 300);        // from row.bonus.effective
  assert.strictEqual(ce.earnings.gift_card, 150);    // number-or-text → number
  assert.strictEqual(ce.deductions.loans, 500);
  assert.strictEqual(ce.totals.estimated_total, 9121.25);
  assert.strictEqual(ce.quantities.worked_hours, 176.5);
  assert.strictEqual(ce.quantities.vacation_days, 1);
  ok('valid hourly row maps cleanly');
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

  const noBank = toCanonicalEmployee(validHourlyRow({ bank_account: '' }));
  const rBank = auditEmployee(noBank);
  assert.strictEqual(rBank.errors.length, 1);
  assert.ok(rBank.errors[0].includes('חסר מספר חשבון בנק'));
  ok('missing bank account → one blocking error, readable');

  const noNum = toCanonicalEmployee(validHourlyRow({ employee_number: '' }));
  assert.ok(auditEmployee(noNum).errors.some(e => e.includes('חסר מספר עובד')));
  ok('missing employee_number → blocking error');
}

console.log('buildExportSource — sorts ready / failed / skipped');
{
  const rows = [
    validHourlyRow(),                                                  // ready
    validHourlyRow({ employee_id: 'e2', full_name: 'דנה כהן', bank_account: '' }), // failed
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

console.log('\nAll payroll-export source tests passed (' + passed + ' checks).');
