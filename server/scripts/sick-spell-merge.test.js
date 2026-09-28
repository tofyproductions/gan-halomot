#!/usr/bin/env node
/**
 * Statutory sick-pay brackets (day 1 = 0%, days 2-3 = 50%, day 4+ = 100%)
 * follow the SPELL — a run of calendar dates with no gap — not the
 * certificate. Two certificates filed separately but date-adjacent (one ends
 * the day before the next starts) are the SAME spell: the second one
 * continues the bracket instead of resetting to a fresh unpaid day 1.
 *
 * Caught live: מאי יחיא — cert A (2026-09-22..23, 2 days) + cert B
 * (2026-09-24..24, 1 day), filed separately, zero gap between them. Before
 * this fix cert B priced as its own day 1 (0% — 0 of 1 day paid); it should
 * price as day 3 of the combined 3-day spell (50% — 0.5 of 1 day paid).
 *
 * A real gap (she came back, then got sick again later the same month) must
 * still start a fresh spell — that's the regression guard in the second case.
 *
 *   node scripts/sick-spell-merge.test.js
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
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'sick_spell_merge_test' } });
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'x';
  process.env.DISABLE_JOBS = '1';

  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);

  const { Branch, Amuta, Employee, EmployeeRequest } = require('../src/models');
  const { fetchMonthData } = require('../src/controllers/payrollMonth.controller');

  const branch = await Branch.create({ name: 'סניף בדיקה', address: 'כתובת' });
  const amuta = await Amuta.create({ name: 'עמותת בדיקה' });
  const month = '2026-09';

  const mkEmp = (name, idNum) => Employee.create({
    full_name: name, israeli_id: idNum, branch_id: branch._id,
    salary_type: 'hourly', hourly_rate: 50, is_active: true,
    start_date: new Date('2024-01-01'), work_days: [0, 1, 2, 3, 4],
    amuta_distribution: [{ amuta_id: amuta._id, hourly_rate: 50 }],
    sick_balance_opening: { days: 90, as_of_month: '2024-01' }, // uncapped by balance for this test
  });

  console.log('two certificates with zero calendar-day gap merge into one spell');
  {
    const emp = await mkEmp('מאי בדיקה (רצף)', '111222339');
    await EmployeeRequest.create({
      employee_id: emp._id, branch_id: branch._id, type: 'sick',
      from_date: '2026-09-22', to_date: '2026-09-23', status: 'approved',
    });
    await EmployeeRequest.create({
      employee_id: emp._id, branch_id: branch._id, type: 'sick',
      from_date: '2026-09-24', to_date: '2026-09-24', status: 'approved',
    });

    const data = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });
    const row = (data.rows || []).find(r => String(r.employee_id) === String(emp._id));
    assert.ok(row, 'the row must exist');
    const certs = row.sick_info.certs.sort((a, b) => a.from_date.localeCompare(b.from_date));
    assert.strictEqual(certs.length, 2, `expected 2 cert rows, got ${certs.length}`);
    assert.strictEqual(certs[0].paid_days, 0.5, `cert A (day 1-2 of the spell) expected 0.5 paid days, got ${certs[0].paid_days}`);
    assert.strictEqual(certs[1].paid_days, 0.5, `cert B (day 3 of the spell) expected 0.5 paid days — continuing the bracket, not resetting — got ${certs[1].paid_days}`);
    assert.strictEqual(row.sick_info.paid_days, 1, `spell total (3 days: 0+0.5+0.5) expected 1 paid day, got ${row.sick_info.paid_days}`);
    ok('cert B continues the spell at day 3 (50%) instead of resetting to its own day 1 (0%)');
  }

  console.log('a real gap between certificates starts a fresh spell (regression guard)');
  {
    const emp = await mkEmp('מאי בדיקה (פער)', '111222340');
    await EmployeeRequest.create({
      employee_id: emp._id, branch_id: branch._id, type: 'sick',
      from_date: '2026-09-02', to_date: '2026-09-03', status: 'approved',
    });
    // A real gap: she's back 09-04/05, sick again from 09-08 — not adjacent.
    await EmployeeRequest.create({
      employee_id: emp._id, branch_id: branch._id, type: 'sick',
      from_date: '2026-09-08', to_date: '2026-09-08', status: 'approved',
    });

    const data = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });
    const row = (data.rows || []).find(r => String(r.employee_id) === String(emp._id));
    const certs = row.sick_info.certs.sort((a, b) => a.from_date.localeCompare(b.from_date));
    assert.strictEqual(certs[0].paid_days, 0.5, `cert A expected 0.5, got ${certs[0].paid_days}`);
    assert.strictEqual(certs[1].paid_days, 0, `cert B, after a real gap, must reset to its own day 1 (0 paid) — got ${certs[1].paid_days}`);
    ok('a genuine gap between certificates still resets the bracket to day 1');
  }

  await mongoose.disconnect();
  await mongod.stop();

  console.log(`\nAll sick-spell-merge tests passed (${passed} checks).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
