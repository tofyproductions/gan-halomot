#!/usr/bin/env node
/**
 * Silence in the שקלולית file used to mean two opposite things.
 *
 * A note about חופשה was written only when something went wrong — the balance
 * capped the days, a תקן employee overdrew, accounting lifted the cap. So a
 * row with no note read as "the balance covered it", when it could equally
 * mean "there is no balance on file and nothing was checked". The accountant
 * had no way to tell those apart, and the second case pays leave nobody has
 * counted: 09.2026 filed ₪8,450 of תמורת חופשה across nine employees with no
 * note of any kind, one of them (גלאם רות, ₪402) with no opening balance at all.
 *
 * An unknown balance still must not reduce anyone's pay — that rule is
 * deliberate and stays (see services/vacationBalance.js). It only stops being
 * invisible. These tests pin both halves: the days are still paid in full, and
 * the file now says on what basis.
 *
 *   node scripts/vacation-balance-visibility.test.js
 */

const assert = require('assert');
const { buildExportSource } = require('../src/services/payrollExport/sourceLayer');
const shkulit = require('../src/services/payrollExport/shkulitAdapter');

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

// An hourly employee who took two days of leave, priced at ₪201.12 a day —
// גלאם רות's own 09.2026 figures, the row that started this.
const base = {
  employee_id: 'e-vac',
  employee_number: '96',
  israeli_id: '328192448',
  full_name: 'גלאם רות',
  salary_type: 'hourly',
  is_active: true,
  month: '2026-09',
  bank_number: '20', bank_branch: '422', bank_account: '68485', bank_account_holder: 'גלאם רות',
  breakdown: {
    components: { base_salary: 603, travel: 48 },
    deductions: {},
    hours: { total: 12.57, regular: 12.57, ot_125: 0, ot_150: 0, days_worked: 3 },
    rates: { hourly_rate: 48 },
    estimated_total: 1054,
    warnings: [],
  },
  manual: { vacation_days: 2 },
  vacation_pay: 402.24,
};

const notesFor = (row) => shkulit.buildMovements(buildExportSource('2026-09', [row])).notes;
const rowsFor = (row) => shkulit.buildMovements(buildExportSource('2026-09', [row])).rows;
const vacNote = (row) => notesFor(row).find((n) => String(n.subject).startsWith('ימי חופשה'));

console.log('\nיתרת חופשה — מה הקובץ אומר\n');

// ── 1. no balance on file ────────────────────────────────────────────────────
{
  const unknown = { ...base, vacation_balance_available: null };

  ok('an unknown balance still pays every day — the rule that must not change', () => {
    const vac = rowsFor(unknown).find((r) => r[2] === 1 && r[3] === 8);
    assert.ok(vac, 'a תמורת חופשה row is expected');
    assert.strictEqual(vac[5], 2, 'both days are filed, uncapped');
  });

  ok('...and the file now says the balance was never checked', () => {
    const n = vacNote(unknown);
    assert.ok(n, 'a vacation note is expected — this is the case that used to be silent');
    assert.strictEqual(n.subject, 'ימי חופשה — יתרה לא רשומה');
    assert.ok(/ללא בדיקת יתרה/.test(n.text), n.text);
  });
}

// ── 2. balance on file and covering ──────────────────────────────────────────
{
  const covered = { ...base, vacation_balance_available: 5.4 };

  ok('a covered balance is stated rather than left to silence', () => {
    const n = vacNote(covered);
    assert.ok(n, 'a vacation note is expected');
    assert.strictEqual(n.subject, 'ימי חופשה');
    assert.ok(/5\.4/.test(n.text), n.text);
    assert.ok(/מכסה/.test(n.text), n.text);
  });

  ok('the two cases no longer read alike', () => {
    assert.notStrictEqual(
      vacNote(covered).subject,
      vacNote({ ...base, vacation_balance_available: null }).subject,
    );
  });
}

// ── 3. the cases that already spoke keep their own wording ───────────────────
{
  const capped = { ...base, manual: { vacation_days: 7 }, vacation_balance_available: 0, vacation_pay: 0 };

  ok('a capped hourly employee keeps the existing "מוגבל ליתרה" note', () => {
    const n = vacNote(capped);
    assert.strictEqual(n.subject, 'ימי חופשה');
    assert.ok(/מוגבל ליתרה/.test(n.text), n.text);
    assert.ok(!/ללא בדיקת יתרה/.test(n.text), 'the unknown-balance wording must not leak here');
  });

  ok('...and nothing is filed for her under code 8', () => {
    assert.ok(!rowsFor(capped).some((r) => r[2] === 1 && r[3] === 8));
  });

  const teken = {
    ...base, salary_type: 'global', manual: { vacation_days: 4 },
    vacation_balance_available: 3.67, vacation_pay: 0,
  };
  ok('a תקן employee over her balance keeps the overdraft note', () => {
    const n = vacNote(teken);
    assert.ok(/מעבר ליתרה/.test(n.text), n.text);
  });
}

// ── 4. no leave, no sentence ─────────────────────────────────────────────────
{
  ok('an employee with no vacation days is not given a note about vacation', () => {
    const none = { ...base, manual: {}, vacation_pay: 0, vacation_balance_available: null };
    assert.strictEqual(vacNote(none), undefined);
  });
}

console.log(`\nAll vacation-balance visibility tests passed (${passed} checks).`);
