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
ok('every non-zero amount component is one row; zeros vanish', () => {
  const byCode = new Map(rows.map(r => [r[3], r]));
  assert.deepStrictEqual(byCode.get(3).slice(4), [250, 1]);   // נסיעות — an amount, not a count
  assert.strictEqual(byCode.get(35)[4], 350);                  // בונוס
  // ימי מחלה is COUNTED: 480 over 2 days is 240 a day, so the payslip says
  // two days instead of one. See the units rule in the adapter.
  assert.deepStrictEqual(byCode.get(34).slice(4), [240, 2]);
  assert.ok(!byCode.has(44), 'holiday 0 → no row');
  for (const r of rows) {
    // חודש עבודה is a NUMBER. שקלולית rejected the old '08/2026' string on
    // every row of the September trial: "צריך להיות מספר חיובי שלם או אפס".
    assert.strictEqual(r[0], 8);
    assert.strictEqual(typeof r[0], 'number', 'must be numeric, not a date string');
    assert.strictEqual(r[1], '17');
    // סוג רשומה = which code table the row's קוד רכיב came from. Salary
    // components are table 1; שי לחג is an imputed income and is table 2 —
    // the column exists precisely so the two cannot be confused.
    assert.strictEqual(r[2], r[3] === 22 ? 2 : 1, `record type for code ${r[3]}`);
  }
});
ok('deductions are negative', () => {
  const absence = rows.find(r => r[3] === 36);
  assert.strictEqual(absence[4], -120);
});
ok('unmapped components + directives land in notes, not rows', () => {
  const subjects = notes.map(n => n.subject);
  // שי לחג is NOT here any more: its code was confirmed on 28.09.2026 and it
  // is a row (22, table 2). A component that is both a row and a note gets
  // keyed twice, so leaving it in this list would be the bug.
  assert.ok(!subjects.includes('תו קנייה (גיפט קארד)') && !subjects.includes('שי לחג'),
    'a component with a confirmed code stops being a note');
  assert.ok(rows.some(r => r[3] === 22 && r[2] === 2), 'שי לחג is a row in the imputed table');
  assert.ok(subjects.includes('ניכוי הלוואה'));
  assert.ok(subjects.some(s => s.startsWith('ניכוי מקדמה')));
  // 22 is שי לחג, confirmed by the software house on 28.09.2026.
  assert.ok(!rows.some(r => ![1, 32, 33, 3, 34, 35, 36, 22].includes(r[3])), 'no invented codes');
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

console.log('record type');
ok('the three code tables, as the software house numbered them', () => {
  assert.strictEqual(shkulit.RECORD_TYPE.SALARY, 1);
  assert.strictEqual(shkulit.RECORD_TYPE.IMPUTED, 2);
  assert.strictEqual(shkulit.RECORD_TYPE.VOLUNTARY_DEDUCTION, 3);
});
ok('every movement row carries a numeric table, never the old empty string', () => {
  const valid = new Set([1, 2, 3]);
  for (const r of rows) {
    assert.strictEqual(typeof r[2], 'number', `row ${JSON.stringify(r)} record type must be a number`);
    assert.ok(valid.has(r[2]), `row ${JSON.stringify(r)} record type must be 1, 2 or 3`);
  }
});
ok('deductions from the SALARY table stay type 1 — a negative amount is not a ניכוי רשות', () => {
  const byCode = new Map(rows.map(r => [r[3], r]));
  const absence = byCode.get(36);
  assert.ok(absence, 'the fixture must produce ימים חסרים');
  assert.strictEqual(absence[2], 1, 'ימים חסרים is a salary component');
  assert.ok(absence[4] < 0, 'and still goes out negative');
});
ok('the components still on the notes sheet produced no rows', () => {
  // Their table is known now; their קוד רכיב is not. They must not have leaked
  // into the file on the strength of half an answer.
  const codes = new Set(rows.map(r => r[3]));
  for (const c of [2, 21]) assert.ok(!codes.has(c), `imputed code ${c} must not appear yet`);
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


console.log('counted components — the quantity is the count, not 1');
ok('two days of חג go out as 2 × the daily rate, not 1 × the total', () => {
  // רינת אברבנאל, 09.2026: 622.36 for two days went out as כמות 1, and the
  // payslip then said one day of חג. The money was right; the count was not.
  const r = { ...row, holiday_pay_auto: { total_pay: 622.36, total_days: 2 } };
  const { rows: rr } = shkulit.buildMovements(buildExportSource('2026-09', [r]));
  const holiday = rr.find(x => x[3] === 44);
  assert.ok(holiday, 'a holiday row must exist');
  assert.deepStrictEqual(holiday.slice(4), [311.18, 2]);
  assert.strictEqual(Math.round(holiday[4] * holiday[5] * 100) / 100, 622.36,
    'rate × quantity must still be the money the table says');
});
ok('one day stays one row of one — nothing to split', () => {
  const r = { ...row, holiday_pay_auto: { total_pay: 311.18, total_days: 1 } };
  const { rows: rr } = shkulit.buildMovements(buildExportSource('2026-09', [r]));
  assert.deepStrictEqual(rr.find(x => x[3] === 44).slice(4), [311.18, 1]);
});
ok('a count that does not divide exactly keeps the money whole and says so', () => {
  // 100 over 3 days is 33.33, and 33.33 × 3 is 99.99. Paying 99.99 in order to
  // report a count would be a wage claim, so the amount travels whole and the
  // real count is told to the accountant in words.
  const r = { ...row, holiday_pay_auto: { total_pay: 100, total_days: 3 } };
  const { rows: rr, notes: nn } = shkulit.buildMovements(buildExportSource('2026-09', [r]));
  assert.deepStrictEqual(rr.find(x => x[3] === 44).slice(4), [100, 1]);
  assert.ok(nn.some(n => n.subject === 'ימי חג' && /3 ימים/.test(n.text)),
    'the real count must reach the accountant in words');
});
ok('a deduction keeps its sign when it is split into units', () => {
  const r = {
    ...row,
    absence: { deductible_days: 2 },
    breakdown: { ...row.breakdown, deductions: { loans: 0, absence: 300 } },
  };
  const { rows: rr } = shkulit.buildMovements(buildExportSource('2026-09', [r]));
  const miss = rr.find(x => x[3] === 36);
  assert.ok(miss, 'ימים חסרים must be a row');
  assert.deepStrictEqual(miss.slice(4), [-150, 2], 'negative rate, positive count');
  assert.strictEqual(miss[2], 1, 'a negative salary component stays table 1');
});

console.log('ימי עבודה — never filed under a code nobody confirmed');
ok('code 4 is הבראה, so no work-days row is ever produced under it', () => {
  // A code-4 row briefly went out carrying the work-day count. Code 4 is
  // הבראה — both our אקסולוגיה table and שקלולית's own screen say so — and it
  // surfaced in the payslip as a recreation line. It paid nothing only because
  // the rate was 0; a rate on that row pays הבראה to every global employee.
  const globalRow = {
    ...row, employee_number: '21', israeli_id: '999000021', salary_type: 'global',
    breakdown: { ...row.breakdown, rates: {} },
  };
  for (const r of [globalRow, row]) {
    const { rows: rr, notes: nn } = shkulit.buildMovements(buildExportSource('2026-09', [r]));
    assert.ok(!rr.some(x => x[3] === 4),
      'nothing may be filed under code 4 — it belongs to הבראה');
    assert.ok(nn.some(n => n.subject === 'ימי עבודה' && /20/.test(n.text)),
      'the day count still reaches the accountant, as a note');
  }
});

console.log('a תקן employee is filed as the parts, not the headline');
ok('the agreed salary is never sent whole beside its own completion', () => {
  // ליאור מחפוד, 09.2026: 129.9 of 162.5 committed hours, מקדם תקן 0.746.
  // Agreed ₪10,300 = ₪7,685 regular + ₪554 OT125 + ₪2,062 completion.
  const teken = {
    ...row, employee_number: '27', israeli_id: '203677125', full_name: 'מחפוד ליאור',
    salary_type: 'global',
    breakdown: {
      ...row.breakdown,
      rates: {},
      components: {
        base_salary: 10300, travel: 272, recreation_monthly: 0, meal_vouchers: 0,
        teken_breakdown: { regular_pay: 7685, ot125_pay: 554, ot150_pay: 0, completion: 2062 },
      },
      deductions: {},
    },
    manual: { include_salary_completion: true },
  };
  const src = buildExportSource('2026-09', [teken]);
  const { rows: rr } = shkulit.buildMovements(src);
  const byCode = new Map(rr.map((r) => [r[3], r]));

  assert.deepStrictEqual(byCode.get(1).slice(4), [7685, 1],
    'שכר יסוד is the prorated regular pay, NOT the agreed ₪10,300');
  assert.deepStrictEqual(byCode.get(32).slice(4), [554, 1], 'OT 125% as the amount inside the salary');
  assert.ok(!byCode.has(33), '150% is zero this month — no row');
  assert.strictEqual(byCode.get(38)[4], 2062, 'the completion still travels');

  // The whole point: the parts add back to the agreed salary exactly.
  const salaryTotal = [1, 32, 33, 38]
    .filter((c) => byCode.has(c))
    .reduce((t, c) => t + byCode.get(c)[4] * byCode.get(c)[5], 0);
  assert.strictEqual(salaryTotal, 10301, 'within a shekel of the agreed ₪10,300 — never ₪12,867');
});

console.log('last month\'s components are switched off, not left to pay again');
ok('a code filed before and absent now goes out at zero', () => {
  const src = buildExportSource('2026-09', [row]);
  // Last month she had ימי חג (44) and הבראה (4); this month neither — the
  // fixture's holiday pay is zero and הבראה is never filed by us at all.
  // Code 3 (נסיעות) IS filed this month and must be left alone.
  const previous = new Map([['17', [
    { code: 44, table: 1 }, { code: 4, table: 1 }, { code: 3, table: 1 },
  ]]]);
  const { rows: rr, notes: nn, filed } = shkulit.buildMovements(src, previous);

  const z44 = rr.find((r) => r[3] === 44);
  assert.ok(z44, 'the stale ימי חג row must be present');
  assert.deepStrictEqual(z44.slice(4), [0, 0], 'zeroed — rate and quantity both');
  const z4 = rr.find((r) => r[3] === 4 && r[4] === 0 && r[5] === 0);
  assert.ok(z4, 'הבראה from last month is switched off too');

  // Code 3 (נסיעות) IS filed this month, so it must NOT be zeroed.
  const threes = rr.filter((r) => r[3] === 3);
  assert.strictEqual(threes.length, 1, 'a component still being filed gets one row, not a zero as well');
  assert.notStrictEqual(threes[0][4], 0);

  assert.ok(nn.some((n) => n.subject === 'רכיבים שבוטלו'),
    'the accountant is told which components were switched off');

  // The zero rows must NOT be remembered — otherwise we would re-send a zero
  // for a component nobody files any more, every month, for ever.
  const mine = filed.get('17') || [];
  assert.ok(!mine.some((c) => c.code === 44), 'a switch-off is not itself remembered');
  assert.ok(mine.some((c) => c.code === 3), 'what was really filed is remembered');
});
ok('with no history nothing is zeroed', () => {
  const src = buildExportSource('2026-09', [row]);
  const { rows: rr } = shkulit.buildMovements(src, new Map());
  assert.ok(!rr.some((r) => r[4] === 0 && r[5] === 0),
    'a first-ever file has nothing to switch off');
});

console.log('a code that gets confirmed becomes a row, without a deploy');
ok('a component with no confirmed code stays a note until one is entered', () => {
  // תווי מזון is the remaining unconfirmed one. It sits under שווי ארוחות in
  // the אקסולוגיה just as סיבוס does, and it is deliberately NOT given סיבוס's
  // code: "probably the same line" is the reasoning that once put a work-day
  // count under הבראה.
  const r = { ...row, manual: { ...row.manual, gift_card: { kind: 'empty' } } };
  r.breakdown = { ...row.breakdown, components: { ...row.breakdown.components, meal_vouchers: 90 } };
  const src = buildExportSource('2026-09', [r]);

  const bare = shkulit.buildMovements(src);
  assert.ok(bare.notes.some((n) => n.subject === 'תווי מזון / כלכלה'), 'it travels as a note');
  assert.ok(!bare.rows.some((x) => x[3] === 21 && x[4] === 90),
    'and is never filed under סיבוס\'s code just because it is the same table');

  // Once confirmed it is entered in settings — no deploy.
  const withCode = shkulit.buildMovements(src, new Map(), { meal_vouchers: 2 });
  const mv = withCode.rows.find((x) => x[3] === 2);
  assert.ok(mv, 'it is now a row');
  assert.strictEqual(mv[2], 2, 'זקופות — table 2');
  assert.strictEqual(mv[4], 90);
  assert.ok(!withCode.notes.some((n) => n.subject === 'תווי מזון / כלכלה'),
    'once it is a row it stops being a note — otherwise it gets keyed twice');
});
ok('the two confirmed imputed codes are rows, not notes', () => {
  const r = { ...row, manual: { ...row.manual, cibus: { kind: 'number', amount: 180 } } };
  const { rows: rr, notes: nn } = shkulit.buildMovements(buildExportSource('2026-09', [r]));
  const gift = rr.find((x) => x[3] === 22);
  const cibus = rr.find((x) => x[3] === 21);
  assert.deepStrictEqual(gift.slice(2), [2, 22, 200, 1], 'שי לחג: table 2, code 22');
  assert.deepStrictEqual(cibus.slice(2), [2, 21, 180, 1], 'סיבוס: table 2, code 21');
  assert.ok(!nn.some((n) => ['סיבוס', 'שי לחג', 'תו קנייה (גיפט קארד)'].includes(n.subject)),
    'neither is also a note');
});
ok('a configured deduction keeps its sign and its own table', () => {
  const src = buildExportSource('2026-09', [row]);
  const { rows: rr } = shkulit.buildMovements(src, new Map(), { loans: 1 });
  const loan = rr.find((x) => x[3] === 1 && x[2] === 3);
  assert.ok(loan, 'the loan lands in the ניכויי רשות table');
  assert.strictEqual(loan[4], -300, 'a deduction is negative, as every other deduction here is');
});

console.log('the תקן row shows the מקדם, and the money still lands');
ok('the agreed salary times its coefficient comes to the payslip figure', () => {
  const teken = {
    ...row, employee_number: '27', israeli_id: '203677125', full_name: 'מחפוד ליאור',
    salary_type: 'global',
    breakdown: {
      ...row.breakdown, rates: {},
      components: { base_salary: 10300, travel: 272,
        teken_breakdown: { teken_salary: 10300, hourly_value: 62.42, regular_pay: 7685, ot125_pay: 554, ot150_pay: 0, completion: 2062 } },
      deductions: {},
    },
    manual: { include_salary_completion: true },
  };
  const { rows: rr } = shkulit.buildMovements(buildExportSource('2026-09', [teken]));
  const base = rr.find((x) => x[3] === 1);
  assert.strictEqual(base[4], 10300, 'the rate is the agreed salary, recognisable on sight');
  assert.ok(base[5] > 0.74 && base[5] < 0.75, 'the quantity is the מקדם תקן');
  assert.strictEqual(Math.round(base[4] * base[5] * 100) / 100, 7685,
    'and rate × quantity is still exactly the payslip figure');

  const ot = rr.find((x) => x[3] === 32);
  assert.strictEqual(ot[5], 7.1, 'the hours are the hours the payslip states — not a derived decimal');
  assert.strictEqual(Math.round(ot[4] * ot[5] * 100) / 100, 554, 'and the money is unchanged');
});

console.log(`\nAll שקלולית adapter tests passed (${passed} checks).`);
