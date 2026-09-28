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

  await mongoose.disconnect();
  await mongod.stop();

  console.log(`\nAll one-time-salary-completion tests passed (${passed} checks).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
