#!/usr/bin/env node
/**
 * The שקלולית adapter, tested against hand-built canonical employees.
 *
 * What matters (per the accountant's answers, 27.09.2026):
 *   1. an HOURLY employee's base pay goes out as hours: code 1 at the card's
 *      rate, codes 32/33 at the 125%/150% rate — שקלולית prices them;
 *   2. a GLOBAL employee's base goes out as the resolved amount;
 *   3. amount components (bonus etc.) are one row each, zeros vanish;
 *   4. deductions come out NEGATIVE — confirmed by the accountant;
 *   5. what has no שקלולית code yet (cibus, gift card, loans, הבראה) and
 *      every free-text directive lands in notes — never guessed into rows;
 *   6. the master file carries identity + bank in the template's columns.
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
    rates: { hourly_rate: 45 },
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
ok('hourly base goes out as hours: 1 / 32 / 33 at the card rate × factor', () => {
  const byCode = new Map(rows.map(r => [r[3], r]));
  assert.deepStrictEqual(byCode.get(1).slice(4), [45, 110]);      // regular
  assert.deepStrictEqual(byCode.get(32).slice(4), [56.25, 8]);    // 125%
  assert.deepStrictEqual(byCode.get(33).slice(4), [67.5, 2]);     // 150%
});
ok('every non-zero amount component is one row (qty 1); zeros vanish', () => {
  const byCode = new Map(rows.map(r => [r[3], r]));
  assert.strictEqual(byCode.get(3)[4], 250);    // נסיעות
  assert.strictEqual(byCode.get(34)[4], 480);   // ימי מחלה
  assert.strictEqual(byCode.get(35)[4], 350);   // בונוס
  assert.ok(!byCode.has(4), 'recreation never becomes a row — the accountant computes it');
  assert.ok(!byCode.has(44), 'holiday 0 → no row');
  for (const r of rows) {
    // חודש עבודה is a NUMBER. שקלולית rejected the old '08/2026' string on
    // every row of the September trial: "צריך להיות מספר חיובי שלם או אפס".
    assert.strictEqual(r[0], 8);
    assert.strictEqual(typeof r[0], 'number', 'must be numeric, not a date string');
    assert.strictEqual(r[1], '17');
    assert.strictEqual(r[2], '', 'record type: empty (not in use per the accountant)');
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
  assert.ok(subjects.some(s => s.startsWith('ניכוי מקדמה')));
  assert.ok(!rows.some(r => ![1, 32, 33, 3, 34, 35, 36].includes(r[3])), 'no invented codes');
});
ok('global employee → base as the resolved amount; net employee → flagged', () => {
  const globalRow = {
    ...row, employee_number: '18', full_name: 'גלובלית נטו', israeli_id: '999000002',
    salary_type: 'global', salary_is_net: true,
    breakdown: { ...row.breakdown, components: { base_salary: 8000 }, deductions: {}, rates: {} },
    manual: {},
  };
  const src2 = buildExportSource('2026-08', [globalRow]);
  const m2 = shkulit.buildMovements(src2);
  const base = m2.rows.find(r => r[3] === 1);
  assert.deepStrictEqual(base.slice(4), [8000, 1]);
  assert.ok(!m2.rows.some(r => [32, 33].includes(r[3])), 'no OT rows for a global');
  assert.ok(m2.notes.some(n => n.subject === 'עובד/ת נטו'));
});
ok('hourly without a card rate falls back to the amount, with a note', () => {
  const noRate = {
    ...row, employee_number: '19', full_name: 'בלי תעריף', israeli_id: '999000003',
    breakdown: { ...row.breakdown, rates: {} }, manual: {},
  };
  const src3 = buildExportSource('2026-08', [noRate]);
  const m3 = shkulit.buildMovements(src3);
  const base = m3.rows.find(r => r[3] === 1);
  assert.deepStrictEqual(base.slice(4), [5000, 1]);
  assert.ok(m3.notes.some(n => n.subject === 'שכר בסיס'));
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

console.log('master diff');
ok('new employee, changed field, unchanged row — each called by name', () => {
  const extras = new Map([['17', { birth_date: '1990-05-01', start_date: '2026-08-01', gender: 'female' }]]);
  const master = shkulit.buildMaster(source, extras);
  const named = shkulit.masterRowToNamed(master.rows[0]);

  // Nothing known → she is new.
  let d = shkulit.buildMasterDiff(master, new Map());
  assert.strictEqual(d.new.length, 1);
  assert.strictEqual(d.changed.length, 0);

  // Snapshot identical → unchanged.
  d = shkulit.buildMasterDiff(master, new Map([['17', { ...named }]]));
  assert.strictEqual(d.new.length, 0);
  assert.strictEqual(d.changed.length, 0);
  assert.strictEqual(d.unchanged, 1);

  // A moved bank account → exactly one change, named by its column.
  d = shkulit.buildMasterDiff(master, new Map([['17', { ...named, 'בנק-מספר חשבון': '999' }]]));
  assert.strictEqual(d.changed.length, 1);
  assert.deepStrictEqual(d.changed[0].changes, [{ column: 'בנק-מספר חשבון', before: '999', after: '123456' }]);
});

console.log('month encoding');
ok('the month alone, 1-12 — what שקלולית accepted on 28.09', () => {
  assert.strictEqual(shkulit.monthValue('2026-09'), 9);
  assert.strictEqual(shkulit.monthValue('2026-01'), 1, 'no leading zero survives as a string');
  assert.strictEqual(shkulit.monthValue('2026-12'), 12);
  for (let m = 1; m <= 12; m++) {
    const v = shkulit.monthValue(`2026-${String(m).padStart(2, '0')}`);
    assert.strictEqual(typeof v, 'number', `month ${m} must be a number`);
    assert.ok(Number.isInteger(v) && v >= 1 && v <= 12, `month ${m} must land in 1..12, got ${v}`);
  }
});
ok('the two shapes שקלולית rejected are never produced', () => {
  // 202609 → "יכול להיות מספר מ 1 עד 12"; '09/2026' → the original failure.
  for (const m of ['2026-09', '2026-01', '2026-12']) {
    const v = shkulit.monthValue(m);
    assert.ok(v < 100, `${m} must not be a YYYYMM period, got ${v}`);
    assert.notStrictEqual(typeof v, 'string');
  }
});
ok('garbage returns 0 on purpose — the row fails loudly, never books a wrong month', () => {
  for (const bad of ['', null, undefined, 'שלום', '2026', '09/2026', '2026-13', '2026-00']) {
    assert.strictEqual(shkulit.monthValue(bad), 0, `${JSON.stringify(bad)} → 0`);
  }
});

console.log(`\nAll שקלולית adapter tests passed (${passed} checks).`);
