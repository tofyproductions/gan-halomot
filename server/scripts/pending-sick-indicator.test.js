#!/usr/bin/env node
/**
 * When a manager files sick days for an employee, accounting has no way to
 * see WHICH employee has an update sitting in approval — they'd have to open
 * every single employee's sick dialog to find out. fetchMonthData now exposes
 * `pending_sick` per row so the table can flag it directly on the מחלה cell.
 *
 * Approved requests must NOT show up here (that's what `manual.sick_days` /
 * `sick_info` already cover) — only the true not-yet-approved ones.
 *
 *   node scripts/pending-sick-indicator.test.js
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
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'pending_sick_indicator_test' } });
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

  const empPending = await Employee.create({
    full_name: 'עובדת עם עדכון ממתין', israeli_id: '888111222', branch_id: branch._id,
    salary_type: 'hourly', is_active: true, start_date: new Date('2024-01-01'),
    work_days: [0, 1, 2, 3, 4], amuta_distribution: [{ amuta_id: amuta._id, hourly_rate: 50 }],
  });
  const empApprovedOnly = await Employee.create({
    full_name: 'עובדת עם מחלה מאושרת בלבד', israeli_id: '888333444', branch_id: branch._id,
    salary_type: 'hourly', is_active: true, start_date: new Date('2024-01-01'),
    work_days: [0, 1, 2, 3, 4], amuta_distribution: [{ amuta_id: amuta._id, hourly_rate: 50 }],
  });
  const empClean = await Employee.create({
    full_name: 'עובדת בלי כלום', israeli_id: '888555666', branch_id: branch._id,
    salary_type: 'hourly', is_active: true, start_date: new Date('2024-01-01'),
    work_days: [0, 1, 2, 3, 4], amuta_distribution: [{ amuta_id: amuta._id, hourly_rate: 50 }],
  });

  await EmployeeRequest.create({
    employee_id: empPending._id, branch_id: branch._id, type: 'sick',
    from_date: '2026-09-10', to_date: '2026-09-11', status: 'pending_accountant',
  });
  await EmployeeRequest.create({
    employee_id: empApprovedOnly._id, branch_id: branch._id, type: 'sick',
    from_date: '2026-09-06', to_date: '2026-09-07', status: 'approved',
  });

  const data = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });
  const rowFor = (id) => (data.rows || []).find(r => String(r.employee_id) === String(id));

  console.log('an employee with a pending (unapproved) sick request is flagged');
  {
    const row = rowFor(empPending._id);
    assert.ok(row, 'the row must exist');
    assert.strictEqual(row.pending_sick.length, 1, `expected 1 pending sick entry, got ${row.pending_sick.length}`);
    assert.strictEqual(row.pending_sick[0].status, 'pending_accountant');
    ok('pending_sick carries the awaiting-approval request');
  }

  console.log('an employee whose sick request is already approved is NOT flagged as pending');
  {
    const row = rowFor(empApprovedOnly._id);
    assert.strictEqual(row.pending_sick.length, 0, `expected 0 pending entries, got ${row.pending_sick.length}`);
    ok('an approved-only sick request never shows up in pending_sick');
  }

  console.log('an employee with no sick requests at all gets an empty (not missing) pending_sick array');
  {
    const row = rowFor(empClean._id);
    assert.deepStrictEqual(row.pending_sick, []);
    ok('pending_sick defaults to an empty array');
  }

  await mongoose.disconnect();
  await mongod.stop();

  console.log(`\nAll pending-sick-indicator tests passed (${passed} checks).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
