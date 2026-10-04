#!/usr/bin/env node
/**
 * Switching off last month's leftovers — against the case that went wrong.
 *
 * אסתר הרוניאן, 09.2026: her September payslip paid August's בונוס (₪3,525)
 * and August's הבראה (14 × 338.80) a second time. August was keyed by hand at
 * the accountant's, so there was no August file to remember; and the one
 * snapshot we kept was overwritten by the first September download, after which
 * every September export took September itself for "the previous month".
 *
 *   node scripts/shkulit-movement-history.test.js
 */

const assert = require('assert');
const { buildExportSource } = require('../src/services/payrollExport/sourceLayer');
const shkulit = require('../src/services/payrollExport/shkulitAdapter');
const mh = require('../src/services/payrollExport/movementHistory');

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

const esther = (month, over = {}) => ({
  employee_id: 'e31', employee_number: '31', israeli_id: '023806615', full_name: 'אסתר הרוניאן',
  salary_type: 'global', is_active: true, month,
  bank_number: '10', bank_branch: '946', bank_account: '2659891',
  breakdown: {
    hours: { total: 92.22, regular: 87.12, ot_125: 5.1, ot_150: 0, days_worked: 14 },
    rates: {},
    components: {
      base_salary: 9500, travel: 224,
      teken_breakdown: { teken_salary: 9500, hourly_value: 68.22, regular_pay: 5944, ot125_pay: 435, ot150_pay: 0, completion: 3121.53 },
    },
    deductions: {},
    warnings: [],
  },
  manual: { include_salary_completion: true },
  holiday_pay_auto: { total_pay: 0, total_days: 0 },
  sick_info: { pay: 0 },
  partial_absence: { deduction: 0 },
  ...over,
});

// August as our own payroll table had it: the summer bonus and הבראה.
const augustRow = esther('2026-08', {
  manual: { include_salary_completion: true, recreation: { kind: 'number', amount: 4743 } },
  breakdown: {
    ...esther('2026-08').breakdown,
    components: {
      ...esther('2026-08').breakdown.components,
      closure_completion_bonus: { amount: 3525, days: [], dates: [], deduction: 0, unapproved_days: [] },
    },
  },
});
// September: no bonus, no הבראה.
const septemberSource = buildExportSource('2026-09', [esther('2026-09')]);

// What the 28.09 trial download left behind: September, under the old shape.
const trialSnapshot = { employee_number: '31', month: '2026-09', components: [{ code: 1, table: 1 }, { code: 3, table: 1 }] };

console.log('which month counts as "previous"');
ok('a snapshot of the SAME month is never taken for the previous one', () => {
  assert.strictEqual(mh.filedIn(trialSnapshot, '2026-08'), null);
  assert.deepStrictEqual(mh.filedIn(trialSnapshot, '2026-09'), [{ code: 1, table: 1 }, { code: 3, table: 1 }]);
});
ok('re-downloading September replaces September and leaves August alone', () => {
  const withAug = { employee_number: '31', history: mh.withMonth(null, '2026-08', [{ code: 35, table: 1 }]) };
  const again = { ...withAug, history: mh.withMonth(withAug, '2026-09', [{ code: 1, table: 1 }]) };
  const twice = { ...again, history: mh.withMonth(again, '2026-09', [{ code: 3, table: 1 }]) };
  assert.deepStrictEqual(mh.filedIn(twice, '2026-08'), [{ code: 35, table: 1 }]);
  assert.deepStrictEqual(mh.filedIn(twice, '2026-09'), [{ code: 3, table: 1 }]);
  assert.strictEqual(twice.history.length, 2);
});
ok('a snapshot with no month is not guessed into one', () => {
  assert.deepStrictEqual(mh.historyOf({ components: [{ code: 35, table: 1 }] }), []);
});
ok('the history keeps twelve months', () => {
  let snap = null;
  for (let m = 1; m <= 14; m += 1) {
    const month = `2026-${String(m).padStart(2, '0')}`.replace('2026-13', '2027-01').replace('2026-14', '2027-02');
    snap = { history: mh.withMonth(snap, month, [{ code: m, table: 1 }]) };
  }
  assert.strictEqual(snap.history.length, mh.KEEP_MONTHS);
  assert.strictEqual(snap.history[snap.history.length - 1].month, '2027-02');
});

console.log('אסתר הרוניאן — August keyed by hand, September filed by us');
const prev = mh.previousMonthComponents({
  numbers: ['31'], snapshots: [trialSnapshot], prevMonth: '2026-08', prevRows: [augustRow],
});
ok('the rebuilt August holds the bonus and the הבראה', () => {
  const keys = (prev.get('31') || []).map((c) => `${c.table}:${c.code}`);
  assert.ok(keys.includes('1:35'), 'בונוס אוגוסט, code 35');
  assert.ok(keys.includes('1:4'), 'הבראה, code 4');
});
ok('September\'s file zeroes both', () => {
  const { rows } = shkulit.buildMovements(septemberSource, prev);
  const z = (code) => rows.find((r) => r[2] === 1 && r[3] === code);
  assert.deepStrictEqual(z(35)?.slice(4), [0, 0], 'the bonus is switched off');
  assert.deepStrictEqual(z(4)?.slice(4), [0, 0], 'the הבראה is switched off');
});
ok('and nothing September does file is zeroed beside it', () => {
  const { rows } = shkulit.buildMovements(septemberSource, prev);
  const base = rows.filter((r) => r[2] === 1 && r[3] === 1);
  assert.strictEqual(base.length, 1);
  assert.notStrictEqual(base[0][4], 0);
});
ok('an employee who failed last month\'s audit is still rebuilt — she still got a payslip', () => {
  const noBank = { ...augustRow, bank_account: '' };
  const p = mh.previousMonthComponents({ numbers: ['31'], snapshots: [], prevMonth: '2026-08', prevRows: [noBank] });
  assert.ok((p.get('31') || []).some((c) => c.code === 35));
});
ok('when last month cannot be fetched, what we filed still counts', () => {
  const snap = { employee_number: '31', history: [{ month: '2026-08', components: [{ code: 33, table: 1 }] }] };
  const p = mh.previousMonthComponents({ numbers: ['31'], snapshots: [snap], prevMonth: '2026-08', prevRows: null });
  assert.deepStrictEqual(p.get('31'), [{ code: 33, table: 1 }]);
});
ok('filed and rebuilt are combined, each code once', () => {
  const snap = { employee_number: '31', history: [{ month: '2026-08', components: [{ code: 35, table: 1 }, { code: 33, table: 1 }] }] };
  const p = mh.previousMonthComponents({ numbers: ['31'], snapshots: [snap], prevMonth: '2026-08', prevRows: [augustRow] });
  const keys = p.get('31').map((c) => `${c.table}:${c.code}`);
  assert.strictEqual(keys.filter((k) => k === '1:35').length, 1);
  assert.ok(keys.includes('1:33'), 'the filed-only code survives');
  assert.ok(keys.includes('1:4'), 'the rebuilt-only code is added');
});
ok('employees not in this month\'s file are left out', () => {
  const p = mh.previousMonthComponents({ numbers: ['99'], snapshots: [trialSnapshot], prevMonth: '2026-08', prevRows: [augustRow] });
  assert.strictEqual(p.size, 0);
});

console.log('גלאם רות — September filed twice, the first with 2 ימי חופשה');
{
  const first = [{ code: 1, table: 1 }, { code: 8, table: 1 }, { code: 1, table: 4 }, { code: 5, table: 4 }];
  const second = [{ code: 1, table: 1 }, { code: 5, table: 4 }];
  const afterFirst = { employee_number: '96', history: mh.withMonth(null, '2026-09', first) };
  ok('the second September file is told what the first one sent', () => {
    const p = mh.previousMonthComponents({ numbers: ['96'], snapshots: [afterFirst], prevMonth: '2026-08', prevRows: null, month: '2026-09' });
    const keys = (p.get('96') || []).map((c) => `${c.table}:${c.code}`);
    assert.ok(keys.includes('1:8'), 'תמורת חופשה');
    assert.ok(keys.includes('4:1'), 'ניצול חופשה');
  });
  const afterSecond = { employee_number: '96', history: mh.withMonth(afterFirst, '2026-09', second) };
  ok('and still remembers it after the second file is recorded', () => {
    assert.deepStrictEqual(mh.filedIn(afterSecond, '2026-09'), second, 'filedIn is the latest file');
    const keys = mh.sentIn(afterSecond, '2026-09').map((c) => `${c.table}:${c.code}`);
    assert.ok(keys.includes('1:8') && keys.includes('4:1'));
  });
  ok('without the month, only the previous month counts (as before)', () => {
    const p = mh.previousMonthComponents({ numbers: ['96'], snapshots: [afterSecond], prevMonth: '2026-08', prevRows: null });
    assert.strictEqual(p.size, 0);
  });
  ok('October looks at September\'s full sent set', () => {
    const p = mh.previousMonthComponents({ numbers: ['96'], snapshots: [afterSecond], prevMonth: '2026-09', prevRows: null, month: '2026-10' });
    assert.ok((p.get('96') || []).some((c) => c.table === 1 && c.code === 1));
  });
}

console.log(`\nAll movement-history tests passed (${passed} checks).`);
