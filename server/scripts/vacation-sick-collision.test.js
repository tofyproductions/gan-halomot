#!/usr/bin/env node
/**
 * A day inside the gan's closure calendar must NOT be auto-charged as a
 * vacation day when the employee was ALSO approved sick that same day.
 *
 * computeKindergartenVacationDays already excluded the August-bonus window
 * and days she actually clocked in — but had no idea sick requests existed
 * at all, so an overlap between an approved sick certificate and a gan
 * closure silently drew a vacation day she never took (double-charged: the
 * day is already accounted for as sick).
 *
 *   node scripts/vacation-sick-collision.test.js
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
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'vacation_sick_collision_test' } });
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'x';
  process.env.DISABLE_JOBS = '1';

  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);

  const { Branch, Amuta, Employee, EmployeeRequest, Holiday } = require('../src/models');
  const { fetchMonthData } = require('../src/controllers/payrollMonth.controller');

  const branch = await Branch.create({ name: 'סניף בדיקה', address: 'כתובת' });
  const amuta = await Amuta.create({ name: 'עמותת בדיקה' });
  const month = '2026-09';

  // A 3-day gan closure, 2026-09-06 (Sun) .. 2026-09-08 (Tue).
  await Holiday.create({
    branch_id: branch._id, academic_year: '2026-2027', name: 'סגירה לבדיקה',
    start_date: new Date('2026-09-06'), end_date: new Date('2026-09-08'), kind: 'closure',
  });

  const emp = await Employee.create({
    full_name: 'עובדת התנגשות לבדיקה',
    israeli_id: '999555444',
    branch_id: branch._id,
    salary_type: 'hourly',
    is_active: true,
    start_date: new Date('2024-01-01'),
    work_days: [0, 1, 2, 3, 4],
    amuta_distribution: [{ amuta_id: amuta._id, hourly_rate: 50 }],
  });

  console.log('a sick spell that overlaps the closure is excluded from auto-vacation');
  {
    // Approved sick 2026-09-06 .. 2026-09-07 — the FIRST two days of the
    // 3-day closure. Only 2026-09-08 should be left for auto-vacation.
    await EmployeeRequest.create({
      employee_id: emp._id, branch_id: branch._id, type: 'sick',
      from_date: '2026-09-06', to_date: '2026-09-07', status: 'approved',
    });

    const data = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });
    const row = (data.rows || []).find(r => String(r.employee_id) === String(emp._id));
    assert.ok(row, 'the row must exist');
    // vacation_eff_days is capped by balance (likely 0, no opening balance
    // configured) — read the auto SUGGESTION instead, which is what would be
    // billed if the manager clicked "חופשה מלוח".
    const autoTotal = row.vacation_days_auto?.total_days;
    assert.strictEqual(autoTotal, 1, `expected exactly 1 day (09-08 only, 09-06/07 excluded as sick), got ${autoTotal}`);
    ok('the auto-vacation suggestion excludes the 2 days that were also approved sick — only 1 day left');
  }

  await mongoose.disconnect();
  await mongod.stop();

  console.log(`\nAll vacation-sick-collision tests passed (${passed} checks).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
