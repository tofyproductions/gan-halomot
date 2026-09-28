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
    // Salary components are table 1; שי לחג is an imputed income (2); counts
    // — ניצול חופשה/מחלה, ימי ושעות עבודה — live in the attendance table (4),
    // where the spec says the rate is not relevant.
    const expectTable = r[3] === 22 ? 2 : 1;
    assert.ok([expectTable, 4].includes(r[2]), `record type for code ${r[3]} was ${r[2]}`);
    if (r[2] === 4) assert.strictEqual(r[4], 0, 'an attendance row carries no rate');
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
  // 22 שי לחג and 8 תמורת חופשה were both confirmed on 28.09.2026.
  const salaryCodes = rows.filter(r => r[2] !== 4).map(r => r[3]);
  assert.ok(!salaryCodes.some(c => ![1, 32, 33, 3, 34, 35, 36, 22, 8].includes(c)), 'no invented codes');
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
  // 1/2/3 are the three code tables; 4 is היעדרויות ונתוני העסקה, where the
  // counts live and the rate is not relevant.
  const valid = new Set([1, 2, 3, 4]);
  for (const r of rows) {
    assert.strictEqual(typeof r[2], 'number', `row ${JSON.stringify(r)} record type must be a number`);
    assert.ok(valid.has(r[2]), `row ${JSON.stringify(r)} record type must be 1-4`);
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
  // Scoped to the IMPUTED table: code 2 also exists in the attendance table,
  // where it means ניצול מחלה and is perfectly legitimate.
  const imputed = new Set(rows.filter(r => r[2] === 2).map(r => r[3]));
  for (const c of [2, 21]) assert.ok(!imputed.has(c), `imputed code ${c} must not appear yet`);
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

console.log('counts go to the attendance table, where a count belongs');
ok('ניצול חופשה is סוג רשומה 4 קוד 1, with no rate', () => {
  // This is what a month of guessing was for. The days were being filed as a
  // salary component — which pays money and never touches the attendance
  // figures — so the payslip showed תמורת חופשה paid and ניצול חופשה at 0.000
  // at the same time. The spec is explicit: table 4, rate not relevant.
  const r = { ...row, salary_type: 'hourly', vacation_eff_days: 3, vacation_pay: 900,
    vacation_balance_available: 10, manual: {} };
  const { rows: rr } = shkulit.buildMovements(buildExportSource('2026-09', [r]));
  const used = rr.find((x) => x[2] === 4 && x[3] === 1);
  assert.ok(used, 'the count must be filed');
  assert.deepStrictEqual(used.slice(4), [0, 3], 'no rate, three days');

  // And the money is a SEPARATE row in the salary table — two facts, two
  // tables, which is what they always were.
  const paid = rr.find((x) => x[2] === 1 && x[3] === 8);
  assert.ok(paid, 'the payment is still filed');
  assert.strictEqual(Math.round(paid[4] * paid[5] * 100) / 100, 900);
});
ok('a תקן employee reports the count and is paid nothing for it', () => {
  const r = {
    ...row, salary_type: 'global', vacation_eff_days: 6, vacation_pay: 0,
    vacation_balance_available: 4, manual: {},
    breakdown: { ...row.breakdown, rates: {},
      components: { base_salary: 10300,
        teken_breakdown: { teken_salary: 10300, hourly_value: 62, regular_pay: 10300, ot125_pay: 0, ot150_pay: 0, completion: 0 } },
      deductions: {} },
  };
  const { rows: rr } = shkulit.buildMovements(buildExportSource('2026-09', [r]));
  assert.deepStrictEqual(rr.find((x) => x[2] === 4 && x[3] === 1).slice(4), [0, 6],
    'six days used');
  assert.ok(!rr.some((x) => x[2] === 1 && x[3] === 8),
    'and nothing in the salary table — her salary already contains them');
});
ok('ימי עבודה is code 4 in the ATTENDANCE table, not in the salary table', () => {
  // קוד 4 in the salary table is הבראה, which is why the first attempt showed
  // up as a recreation line. In table 4 it is ימי עבודה משולמים.
  const { rows: rr } = shkulit.buildMovements(source);
  const days = rr.find((x) => x[2] === 4 && x[3] === 4);
  assert.ok(days, 'the work-day count is filed');
  // 20 worked + the fixture's 2 sick days: code 4 is ימי עבודה מ-שולמים, so a
  // paid day of absence belongs in it. The 20 alone go out under code 7.
  assert.deepStrictEqual(days.slice(4), [0, 22]);
  assert.deepStrictEqual(rr.find((x) => x[2] === 4 && x[3] === 7).slice(4), [0, 20]);
  assert.ok(!rr.some((x) => x[2] === 1 && x[3] === 4),
    'nothing may be filed under code 4 of the SALARY table — that is הבראה');
});
ok('שעות עבודה בפועל is code 5 in the attendance table', () => {
  const { rows: rr } = shkulit.buildMovements(source);
  assert.deepStrictEqual(rr.find((x) => x[2] === 4 && x[3] === 5).slice(4), [0, 120]);
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
  // Scoped to the imputed table — code 2 in table 4 is ניצול מחלה.
  const mv = withCode.rows.find((x) => x[2] === 2 && x[3] === 2);
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

console.log('תמורת חופשה — code 8 carries the days, and the money only when there is money');
ok('an hourly employee: days and the pay for them, in one row', () => {
  const r = { ...row, salary_type: 'hourly', vacation_eff_days: 5, vacation_pay: 2000,
    vacation_balance_available: 10, manual: {} };
  const { rows: rr } = shkulit.buildMovements(buildExportSource('2026-09', [r]));
  const v = rr.find((x) => x[3] === 8);
  assert.ok(v, 'a vacation row must exist');
  assert.deepStrictEqual(v.slice(4), [400, 5], 'the daily rate × the days');
  assert.strictEqual(Math.round(v[4] * v[5] * 100) / 100, 2000, 'and it comes to the pay');
  assert.strictEqual(v[2], 1, 'רכיבי שכר');
});
ok('a quantity of zero still switches a component off — that part did work', () => {
  // Worth pinning: the carried-forward rows rely on qty 0, and they behaved
  // correctly in the same file where the rate-0 assumption failed. The two are
  // different columns and only one of them is honoured at zero.
  const src = buildExportSource('2026-09', [row]);
  const { rows: rr } = shkulit.buildMovements(src, new Map([['17', [{ code: 44, table: 1 }]]]));
  const z = rr.find((x) => x[3] === 44);
  assert.deepStrictEqual(z.slice(4), [0, 0], 'rate AND quantity zero is the switch-off');
});
ok('an hourly employee capped at her balance files only what she had', () => {
  const r = { ...row, salary_type: 'hourly', vacation_eff_days: 5, vacation_pay: 800,
    vacation_balance_available: 2, manual: {} };
  const { rows: rr, notes: nn } = shkulit.buildMovements(buildExportSource('2026-09', [r]));
  const v = rr.find((x) => x[3] === 8);
  assert.strictEqual(v[5], 2, 'two days — the balance she held');
  assert.strictEqual(Math.round(v[4] * v[5] * 100) / 100, 800);
  assert.ok(nn.some((n) => /3 ימים נותרו ללא תשלום/.test(n.text)),
    'and the three she was away without cover are named');
});
ok('no vacation means no row at all', () => {
  const r = { ...row, salary_type: 'hourly', vacation_eff_days: 0, vacation_pay: 0, manual: {} };
  const { rows: rr } = shkulit.buildMovements(buildExportSource('2026-09', [r]));
  assert.ok(!rr.some((x) => x[3] === 8), 'a month with no leave files nothing');
});

console.log('codes we never file can still be switched off, by name');
ok("ליאור's קוד 47 is zeroed even though it was never in our file", () => {
  // השלמת שכר על ידי מעביד sat in her September payslip at August's ₪3,791.
  // We have never sent 47, so it was never in the snapshot and the automatic
  // switch-off could not reach it. Naming it on the list does.
  const src = buildExportSource('2026-09', [row]);
  const { rows: rr, notes: nn } = shkulit.buildMovements(
    src, new Map(), {}, [{ code: 47, table: 1, label: 'השלמת שכר על ידי מעביד' }],
  );
  const z = rr.find((x) => x[3] === 47);
  assert.ok(z, 'the row must be emitted');
  assert.deepStrictEqual(z.slice(2), [1, 47, 0, 0], 'salary table, zeroed');
  assert.ok(nn.some((n) => n.subject === 'רכיבים שבוטלו' && /47/.test(n.text)),
    'and the accountant is told it was switched off');
});
ok('a standing code is NEVER zeroed in a month we file it ourselves', () => {
  // The dangerous case: if the list could zero a component we are sending, it
  // would silently delete that month's pay. The filed set wins.
  const src = buildExportSource('2026-09', [row]);
  const { rows: rr } = shkulit.buildMovements(
    src, new Map(), {}, [{ code: 3, table: 1, label: 'נסיעות' }],   // 3 IS filed
  );
  const threes = rr.filter((x) => x[3] === 3);
  assert.strictEqual(threes.length, 1, 'one row, not a payment and a zero');
  assert.notStrictEqual(threes[0][4], 0, 'and it still carries the money');
});
ok('a standing code is not emitted twice when it is also last month\'s leftover', () => {
  const src = buildExportSource('2026-09', [row]);
  const { rows: rr } = shkulit.buildMovements(
    src, new Map([['17', [{ code: 47, table: 1 }]]]), {}, [{ code: 47, table: 1 }],
  );
  assert.strictEqual(rr.filter((x) => x[3] === 47).length, 1, 'exactly one zero row');
});
ok('an empty list changes nothing', () => {
  const src = buildExportSource('2026-09', [row]);
  const a = shkulit.buildMovements(src, new Map(), {}, []);
  const b = shkulit.buildMovements(src, new Map(), {});
  assert.deepStrictEqual(a.rows, b.rows, 'no list means the previous behaviour, exactly');
});

console.log('ימי עבודה: paid and actual are two counts, not one');
ok('days of leave count as PAID days, and only worked days count as actual', () => {
  // מהרט worked two days and was paid for two more of חופשה. Her payslip read
  // "ימים משולמים 2 · בפועל 2" — the paid leave was nowhere, so the payslip
  // disagreed with its own תמורת חופשה line.
  const r = { ...row, salary_type: 'hourly', vacation_eff_days: 2, vacation_pay: 238,
    vacation_balance_available: 5, manual: {},
    breakdown: { ...row.breakdown, hours: { total: 17.02, regular: 16, ot_125: 1.02, ot_150: 0, days_worked: 2 } } };
  const { rows: rr } = shkulit.buildMovements(buildExportSource('2026-09', [r]));
  const paid = rr.find((x) => x[2] === 4 && x[3] === 4);
  const actual = rr.find((x) => x[2] === 4 && x[3] === 7);
  assert.strictEqual(paid[5], 4, 'two worked + two of leave');
  assert.strictEqual(actual[5], 2, 'and two actually worked');
  assert.strictEqual(paid[4], 0, 'an attendance row carries no rate');
});
ok('with no leave there is one count, filed once', () => {
  // Two identical rows would invite the reader to wonder which is authoritative.
  const r = { ...row, salary_type: 'hourly', vacation_eff_days: 0, manual: {},
    breakdown: { ...row.breakdown, hours: { total: 80, regular: 80, ot_125: 0, ot_150: 0, days_worked: 10 } } };
  const { rows: rr } = shkulit.buildMovements(buildExportSource('2026-09', [r]));
  assert.strictEqual(rr.find((x) => x[2] === 4 && x[3] === 4)[5], 10);
  assert.ok(!rr.some((x) => x[2] === 4 && x[3] === 7),
    'ימי עבודה בפועל is filed only when it differs from the paid count');
});
ok('sick, חג and מילואים days are paid days too', () => {
  const r = { ...row, salary_type: 'hourly', vacation_eff_days: 1, manual: { sick_days: 2, miluim_days: 3 },
    holiday_pay_auto: { total_pay: 400, total_days: 1 },
    vacation_balance_available: 9,
    breakdown: { ...row.breakdown, hours: { total: 40, regular: 40, ot_125: 0, ot_150: 0, days_worked: 5 } } };
  const { rows: rr } = shkulit.buildMovements(buildExportSource('2026-09', [r]));
  // 5 worked + 1 vacation + 2 sick + 1 חג + 3 מילואים
  assert.strictEqual(rr.find((x) => x[2] === 4 && x[3] === 4)[5], 12);
  assert.strictEqual(rr.find((x) => x[2] === 4 && x[3] === 7)[5], 5);
});

console.log('an employee who worked no days at all says so');
ok('zero worked days is filed, not omitted', () => {
  // Fourteen employees in 09.2026 worked nothing — the whole month was חופשה
  // or מחלה. Suppressing the row left a payslip reading as though they had
  // worked every paid day.
  const r = { ...row, salary_type: 'hourly', vacation_eff_days: 6, vacation_pay: 900,
    vacation_balance_available: 10, manual: {},
    breakdown: { ...row.breakdown, hours: { total: 0, regular: 0, ot_125: 0, ot_150: 0, days_worked: 0 } } };
  const { rows: rr } = shkulit.buildMovements(buildExportSource('2026-09', [r]));
  assert.strictEqual(rr.find((x) => x[2] === 4 && x[3] === 4)[5], 6, 'six paid days');
  const actual = rr.find((x) => x[2] === 4 && x[3] === 7);
  assert.ok(actual, 'and the worked count must be present');
  assert.strictEqual(actual[5], 0, 'saying zero out loud');
});

console.log('בונוס אוגוסט goes out under code 35, with the regular bonus');
{
  const withAug = (aug, plain) => {
    const r = { ...row, bonus: { effective: plain }, manual: {},
      breakdown: { ...row.breakdown,
        components: { ...row.breakdown.components,
          closure_completion_bonus: { amount: aug, days: [], dates: [],
            deduction: 0, unapproved_days: [], reason: 'בונוס אוגוסט' } } } };
    return shkulit.buildMovements(buildExportSource('2026-08', [r]));
  };

  ok('a בונוס אוגוסט alone is code 35, never 39', () => {
    // אילנה שימחי's 08.2026 payslip puts her ₪1,844 on a line named "בונוס".
    // 39 "בונוס מיוחד" exists in the אקסולוגיה and is NOT what the accountant
    // used, so filing it there would have left the real bonus untouched under
    // 35 and sent a zero to an empty code.
    const { rows: rr } = withAug(1844.4, 0);
    const b = rr.filter((x) => x[2] === 1 && x[3] === 35);
    assert.strictEqual(b.length, 1, 'exactly one bonus row');
    assert.strictEqual(b[0][4], 1844.4);
    assert.strictEqual(rr.filter((x) => x[3] === 39).length, 0, 'code 39 is not used');
  });

  ok('a regular bonus and a בונוס אוגוסט are summed into ONE row', () => {
    // Two rows under one code would leave שקלולית to decide whether to add
    // them or keep the last, and that answer is written down nowhere.
    const { rows: rr } = withAug(1844.4, 350);
    const b = rr.filter((x) => x[2] === 1 && x[3] === 35);
    assert.strictEqual(b.length, 1, 'still one row');
    assert.strictEqual(b[0][4], 2194.4, '350 + 1,844.40');
  });

  ok('and the notes say what the single row is made of', () => {
    const { notes: nn } = withAug(1844.4, 350);
    const n = nn.find((x) => x.subject === 'בונוס אוגוסט');
    assert.ok(n, 'a note is written');
    assert.ok(n.text.includes('350') && n.text.includes('1844.4'),
      'both halves are named: ' + n.text);
  });

  ok('no בונוס אוגוסט writes no note', () => {
    const { notes: nn } = withAug(0, 350);
    assert.ok(!nn.some((x) => x.subject === 'בונוס אוגוסט'));
  });
}

console.log('בונוס חד פעמי rides the SAME code 35 row as בונוס קבוע');
{
  const withOneTime = (oneTime, plain) => {
    const r = { ...row, bonus: { effective: plain }, one_time_bonus: { amount: oneTime, note: 'מתנת חג' }, manual: {} };
    return shkulit.buildMovements(buildExportSource('2026-08', [r]));
  };

  ok('a one-time bonus alone is code 35', () => {
    const { rows: rr } = withOneTime(500, 0);
    const b = rr.filter((x) => x[2] === 1 && x[3] === 35);
    assert.strictEqual(b.length, 1, 'exactly one bonus row');
    assert.strictEqual(b[0][4], 500);
  });

  ok('a standing bonus and a one-time bonus are summed into ONE row', () => {
    const { rows: rr } = withOneTime(500, 350);
    const b = rr.filter((x) => x[2] === 1 && x[3] === 35);
    assert.strictEqual(b.length, 1, 'still one row');
    assert.strictEqual(b[0][4], 850, '350 + 500');
  });

  ok('and the notes say what the single row is made of', () => {
    const { notes: nn } = withOneTime(500, 350);
    const n = nn.find((x) => x.subject === 'בונוס חד פעמי');
    assert.ok(n, 'a note is written');
    assert.ok(n.text.includes('350') && n.text.includes('500'), 'both halves are named: ' + n.text);
  });

  ok('no one-time bonus writes no note', () => {
    const { notes: nn } = withOneTime(0, 350);
    assert.ok(!nn.some((x) => x.subject === 'בונוס חד פעמי'));
  });
}

console.log('כל שלושת רכיבי הבונוס (קבוע + חד פעמי + אוגוסט) מסתכמים לשורת קוד 35 אחת');
{
  const r = {
    ...row,
    bonus: { effective: 350 },
    one_time_bonus: { amount: 500, note: 'מתנת חג' },
    manual: {},
    breakdown: {
      ...row.breakdown,
      components: {
        ...row.breakdown.components,
        closure_completion_bonus: {
          amount: 1844.4, days: [], dates: [], deduction: 0, unapproved_days: [], reason: 'בונוס אוגוסט',
        },
      },
    },
  };
  ok('קבוע + חד פעמי + אוגוסט → שורה אחת, סכום אחד', () => {
    const { rows: rr } = shkulit.buildMovements(buildExportSource('2026-08', [r]));
    const b = rr.filter((x) => x[2] === 1 && x[3] === 35);
    assert.strictEqual(b.length, 1, 'still exactly one row');
    assert.strictEqual(b[0][4], 2694.4, '350 + 500 + 1844.40');
  });
}

console.log(`\nAll שקלולית adapter tests passed (${passed} checks).`);
