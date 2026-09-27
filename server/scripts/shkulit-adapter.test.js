#!/usr/bin/env node
/**
 * The שקלולית adapter, tested against hand-built canonical employees.
 *
 * What matters:
 *   1. every non-zero mapped component becomes exactly one movement row with
 *      the right code, as an amount (rate=sum, qty=1) — zero components vanish;
 *   2. deductions come out NEGATIVE, so a "missing days" figure can never be
 *      read as pay;
 *   3. what has no שקלולית code (cibus, gift card, loans) and every free-text
 *      directive lands in notes — never guessed into a numeric row;
 *   4. the master file carries identity + bank in the template's columns.
 *
 *   node scripts/shkulit-adapter.test.js
 */

const assert = require('assert');
const { buildExportSource } = require('../src/services/payrollExport/sourceLayer');
const shkulit = require('../src/services/payrollExport/shkulitAdapter');

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

// A realistic hourly row, the shape fetchMonthData returns.
const row = {
  employee_id: 'e1',
  employee_number: '17',
  israeli_id: '999000001',
  full_name: 'עובדת ניסיון',
  salary_type: 'hourly',
  is_active: true,
  month: '2026-08',
  bank_number: '10', bank_branch: '936', bank_account: '123456', bank_account_holder: 'עובדת ניסיון',
  breakdown: {
    components: { base_salary: 5000, travel: 250, recreation_monthly: 0, meal_vouchers: 0 },
    deductions: { loans: 300, absence: 120 },
    hours: { total: 120, regular: 110, ot_125: 8, ot_150: 2, days_worked: 20 },
    estimated_total: 5130,
    warnings: [],
  },
  manual: {
    sick_days: 2,
    gift_card: { kind: 'number', amount: 200 },
    cibus: { kind: 'empty' },
    miluim: { kind: 'empty' },
    advance_deduction_text: 'מקדמה ₪500 — שולמה 15.08',
  },
  sick_info: { pay: 480 },
  bonus: { effective: 350 },
  holiday_pay_auto: { total_pay: 0, total_days: 0 },
  partial_absence: { deduction: 0, effective_hours: 0 },
};

const source = buildExportSource('2026-08', [row]);
assert.strictEqual(source.ready.length, 1, 'the row must pass the audit');
const { header, rows, notes } = shkulit.buildMovements(source);

console.log('movements');
ok('template columns, exactly', () => {
  assert.deepStrictEqual(header, ['חודש עבודה', 'מספר עובד', 'סוג רשומה', 'קוד רכיב', 'תעריף', 'כמות']);
});
ok('every non-zero mapped component is one amount row; zeros vanish', () => {
  const byCode = new Map(rows.map(r => [r[3], r]));
  assert.strictEqual(byCode.get(1)[4], 5000);   // שכר יסוד
  assert.strictEqual(byCode.get(3)[4], 250);    // נסיעות
  assert.strictEqual(byCode.get(34)[4], 480);   // ימי מחלה
  assert.strictEqual(byCode.get(35)[4], 350);   // בונוס
  assert.ok(!byCode.has(4), 'recreation is 0 → no row');
  assert.ok(!byCode.has(44), 'holiday 0 → no row');
  for (const r of rows) {
    assert.strictEqual(r[0], '08/2026');
    assert.strictEqual(r[1], '17');
    assert.strictEqual(r[5], 1, 'amount mode: quantity is always 1');
  }
});
ok('deductions are negative', () => {
  const absence = rows.find(r => r[3] === 36);
  assert.strictEqual(absence[4], -120);
});
ok('unmapped components + directives land in notes, not rows', () => {
  const subjects = notes.map(n => n.subject);
  assert.ok(subjects.includes('תו קנייה (גיפט קארד)'));
  assert.ok(subjects.includes('ניכוי הלוואה'));
  assert.ok(subjects.includes('ניכוי מקדמה'));
  assert.ok(!rows.some(r => ![1, 3, 34, 35, 36].includes(r[3])), 'no invented codes');
});

console.log('master');
ok('identity + bank in the template columns', () => {
  const extras = new Map([['17', { birth_date: '1990-05-01', start_date: '2026-08-01', gender: 'female' }]]);
  const master = shkulit.buildMaster(source, extras);
  assert.strictEqual(master.header[0], 'מספר זהות');
  const r = master.rows[0];
  assert.strictEqual(r[0], '999000001');
  assert.strictEqual(r[1], '17');
  assert.strictEqual(r[3], 'עובדת');          // שם פרטי
  assert.strictEqual(r[2], 'ניסיון');          // שם משפחה
  assert.strictEqual(r[4], '01/05/1990');
  assert.strictEqual(r[6], 'נקבה');
  assert.strictEqual(r[12], '10');
  assert.strictEqual(r[13], '936');
  assert.strictEqual(r[14], '123456');
});

console.log(`\nAll שקלולית adapter tests passed (${passed} checks).`);
