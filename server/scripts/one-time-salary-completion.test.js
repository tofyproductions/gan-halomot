#!/usr/bin/env node
/**
 * "השלמת שכר חד פעמית" — a manual one-off completion the accountant enters
 * for a single month (e.g. hours from a prior month that never made it into
 * that month's hours report). Independent of the automatic תקן completion:
 * separate field, separate שקלולית code (38 vs 47 — see shkulit-adapter.test.js),
 * and it must actually ADD to estimated_total, not just sit on the row unused.
 *
 *   node scripts/one-time-salary-completion.test.js
 */

/* Nothing may read server/.env — stub dotenv before config/env loads it. */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const assert = require('assert');

let passed = 0;
const ok = (label) => { console.log('  ✓ ' + label); passed += 1; };

async function main() {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'one_time_completion_test' } });
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'x';
  process.env.DISABLE_JOBS = '1';

  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);

  const { Branch, Amuta, Employee, PayrollMonth } = require('../src/models');
  const { fetchMonthData } = require('../src/controllers/payrollMonth.controller');

  const branch = await Branch.create({ name: 'סניף בדיקה', address: 'כתובת' });
  const amuta = await Amuta.create({ name: 'עמותת בדיקה' });
  const month = '2026-09';

  const emp = await Employee.create({
    full_name: 'עובדת בדיקה — השלמת שכר חד פעמית', israeli_id: '135792468',
    branch_id: branch._id, salary_type: 'hourly', hourly_rate: 50, is_active: true,
    start_date: new Date('2024-01-01'), work_days: [0, 1, 2, 3, 4],
    amuta_distribution: [{ amuta_id: amuta._id, hourly_rate: 50 }],
  });

  console.log('a one-time completion is folded into estimated_total and exposed on the row');
  {
    await PayrollMonth.create({
      employee_id: emp._id, branch_id: branch._id, month,
      manual: { one_time_salary_completion: { amount: 640, note: 'השלמה מ-08.2026' } },
    });

    const before = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });
    const rowBefore = (before.rows || []).find(r => String(r.employee_id) === String(emp._id));
    assert.ok(rowBefore, 'the row must exist');
    assert.strictEqual(rowBefore.one_time_salary_completion.amount, 640);
    assert.strictEqual(rowBefore.one_time_salary_completion.note, 'השלמה מ-08.2026');
    ok('the row exposes amount + note');

    await PayrollMonth.updateOne(
      { employee_id: emp._id, month },
      { $set: { 'manual.one_time_salary_completion': { amount: null, note: '' } } },
    );
    const after = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });
    const rowAfter = (after.rows || []).find(r => String(r.employee_id) === String(emp._id));
    assert.strictEqual(
      rowBefore.breakdown.estimated_total - rowAfter.breakdown.estimated_total, 640,
      `estimated_total must drop by exactly the completion amount once cleared, got a ${rowBefore.breakdown.estimated_total - rowAfter.breakdown.estimated_total} difference`,
    );
    ok('estimated_total is exactly 640 higher with the one-time completion set than without it');
  }

  console.log('the hours breakdown that produced the amount round-trips on the row (for the dialog to re-show and re-compute)');
  {
    const emp2 = await Employee.create({
      full_name: 'עובדת בדיקה — השלמה לפי שעות', israeli_id: '975318642',
      branch_id: branch._id, salary_type: 'hourly', hourly_rate: 60, is_active: true,
      start_date: new Date('2024-01-01'), work_days: [0, 1, 2, 3, 4],
      amuta_distribution: [{ amuta_id: amuta._id, hourly_rate: 60 }],
    });
    await PayrollMonth.create({
      employee_id: emp2._id, branch_id: branch._id, month,
      manual: {
        one_time_salary_completion: {
          amount: 585, note: '5 שעות רגילות + 2 שע"נ 125%',
          hours: { regular: 5, ot125: 2, ot150: 0 },
        },
      },
    });
    const data = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });
    const row = (data.rows || []).find(r => String(r.employee_id) === String(emp2._id));
    assert.strictEqual(row.one_time_salary_completion.amount, 585);
    assert.deepStrictEqual(row.one_time_salary_completion.hours, { regular: 5, ot125: 2, ot150: 0 });
    ok('hours {regular, ot125, ot150} round-trip exactly as stored, alongside the amount they produced');
  }

  console.log('the automatic תקן completion and the manual one-off never interact');
  {
    const global = await Employee.create({
      full_name: 'עובדת תקן — השלמת שכר', israeli_id: '246813579',
      branch_id: branch._id, salary_type: 'global', global_salary: 8000, required_hours: 182,
      is_active: true, start_date: new Date('2024-01-01'), work_days: [0, 1, 2, 3, 4],
      amuta_distribution: [{ amuta_id: amuta._id }],
    });
    await PayrollMonth.create({
      employee_id: global._id, branch_id: branch._id, month,
      manual: { one_time_salary_completion: { amount: 300, note: 'תיקון חד פעמי' } },
    });
    const data = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });
    const row = (data.rows || []).find(r => String(r.employee_id) === String(global._id));
    const autoCompletion = row.breakdown?.components?.teken_breakdown?.completion || 0;
    assert.strictEqual(row.one_time_salary_completion.amount, 300, 'the manual one-off is its own field, distinct from teken_breakdown.completion');
    assert.notStrictEqual(row.one_time_salary_completion.amount, autoCompletion, 'sanity: the two fields do not read from the same place');
    ok(`automatic completion (₪${Math.round(autoCompletion)}) and the manual one-off (₪300) coexist as separate fields, neither overwriting the other`);
  }

  // אסתר גוטליב, 09.2026: hourly, ₪955 one-off. It reached estimated_total and
  // it reached the שקלולית file — and the accountant's card never named it, so
  // the printed fields did not add up to the printed total. The card's only
  // completion line was `isGlobal && ...`, which an hourly employee can never
  // satisfy, and the one-off was absent for EVERY salary type.
  console.log('the accountant card names BOTH completions — the employer one and the one-off');
  {
    const { buildAccountantHtml } = require('../src/controllers/payrollMonth.controller');
    const data = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });

    const hourly = (data.rows || []).find(r => r.full_name === 'עובדת בדיקה — השלמה לפי שעות');
    assert.ok(hourly, 'the hourly employee with a one-off must be in the fetch');
    const hourlyHtml = buildAccountantHtml(month, [hourly]);
    assert.ok(hourlyHtml.includes('השלמת שכר חד פעמית'),
      'an HOURLY employee\'s card must carry a השלמת שכר חד פעמית field — this is the field that was missing entirely');
    assert.ok(hourlyHtml.includes('₪585'),
      'the one-off AMOUNT must be printed on the card, not only folded into the total');
    ok('an hourly employee\'s one-off completion is a named field on the accountant card');

    const teken = (data.rows || []).find(r => r.full_name === 'עובדת תקן — השלמת שכר');
    assert.ok(teken, 'the teken employee must be in the fetch');
    const tekenHtml = buildAccountantHtml(month, [teken]);
    assert.ok(tekenHtml.includes('השלמת שכר — ע״י המעסיק'),
      'the teken card must name the EMPLOYER completion apart from the one-off');
    assert.ok(tekenHtml.includes('השלמת שכר חד פעמית') && tekenHtml.includes('₪300'),
      'the teken card must ALSO carry the one-off, with its amount');
    ok('a teken employee\'s card names the two completions apart, both with amounts');

    // When the employer completion is nonzero it is printed TWICE on a teken
    // card — once inside the teken split (where it is part of סה״כ שכר תקן)
    // and once on the completions row. A number printed twice is a number that
    // can be paid twice, so the card has to say which one is already counted.
    // This fixture's employee happens to compute a ₪0 automatic completion, so
    // the assertion is tied to the value rather than assumed either way — a
    // hard-coded expectation here would be testing the fixture, not the card.
    const autoOnCard = Number(teken.breakdown?.components?.teken_breakdown?.completion) || 0;
    const warned = tekenHtml.includes('אין לשלם פעמיים');
    const splitRow = tekenHtml.includes('סה״כ שכר תקן');
    assert.strictEqual(warned, autoOnCard > 0 && splitRow,
      `the do-not-pay-twice note must appear exactly when the employer completion (₪${Math.round(autoOnCard)}) is both nonzero and repeated in the teken split`);
    ok(`the do-not-pay-twice note tracks the employer completion (₪${Math.round(autoOnCard)} here → note ${warned ? 'shown' : 'absent'})`);

    // A card with no completion at all must not grow an empty green row.
    const plain = (data.rows || []).find(r => r.full_name === 'עובדת בדיקה — השלמת שכר חד פעמית');
    assert.ok(plain, 'the cleared employee must be in the fetch');
    assert.strictEqual(Number(plain.one_time_salary_completion?.amount) || 0, 0, 'sanity: her one-off was cleared earlier');
    // Matched on the row's own background, not on the label text: this
    // fixture's employee is NAMED "עובדת בדיקה — השלמת שכר חד פעמית", and her
    // name is printed on every card, so the label alone always "appears".
    assert.ok(!buildAccountantHtml(month, [plain]).includes('background:#f0fdf4'),
      'an employee with no completion of either kind gets no completions row');
    ok('no completions row is printed when there is nothing to complete');

    // Each completion has to say what it is FOR — a bare figure labelled
    // "השלמת שכר" is a number the accountant cannot check against anything.
    assert.ok(hourlyHtml.includes('5 ש׳ רגילות') && hourlyHtml.includes('2 ש׳ שע״נ 125%'),
      'the one-off must show the HOURS it was computed from, not only the amount');
    assert.ok(hourlyHtml.includes('5 שעות רגילות + 2 שע"נ 125%'),
      'and the reason the office typed alongside them');
    ok('the one-off names the hours behind it and the reason it was entered');
  }

  await mongoose.disconnect();
  await mongod.stop();

  console.log(`\nAll one-time-salary-completion tests passed (${passed} checks).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
