#!/usr/bin/env node
/**
 * syncSickDaysForMonth must count ONE employee's approved sick requests —
 * never another employee's, even when both requests overlap the same month.
 *
 * The query used to spread `ownerMatch` (itself `{ $or: [...] }` for an
 * employee with a linked self-service user_id) into the SAME object literal
 * as a second, literal `$or` key for the date-overlap check. A later key
 * silently overwrites an earlier one of the same name in a JS object literal
 * — so the owner filter vanished entirely, and the query matched every
 * employee's approved sick requests for the month, not just hers.
 *
 * Caught in production: שם טוב הדר (4 approved certs, 14 real work-days)
 * showed manual.sick_days = 26 — a stranger's 15.09–30.09 request had bled
 * into her count. This test locks the scoping in.
 *
 *   node scripts/sick-days-sync-scope.test.js
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

function fakeRes() {
  const res = {};
  res.status = (code) => { res._status = code; return res; };
  res.json = (body) => { res._body = body; return res; };
  return res;
}

async function main() {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'sick_days_sync_scope_test' } });
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'x';
  process.env.DISABLE_JOBS = '1';

  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);

  const { Branch, User, Employee, EmployeeRequest, PayrollMonth } = require('../src/models');
  const { syncSickDays } = require('../src/controllers/employeeRequests.controller');

  const branch = await Branch.create({ name: 'סניף בדיקה', address: 'כתובת' });
  const userA = await User.create({
    email: 'a@test.local', full_name: 'עובדת א', role: 'teacher',
    password_hash: 'x', password_set: true, is_active: true, branch_id: branch._id,
  });
  const empA = await Employee.create({
    full_name: 'עובדת א׳', israeli_id: '111111111', branch_id: branch._id,
    is_active: true, start_date: new Date('2024-01-01'), work_days: [0, 1, 2, 3, 4],
    user_id: userA._id,
  });
  const empB = await Employee.create({
    full_name: 'עובדת ב׳ (זרה)', israeli_id: '222222222', branch_id: branch._id,
    is_active: true, start_date: new Date('2024-01-01'), work_days: [0, 1, 2, 3, 4],
  });

  // עובדת א׳: one short approved sick spell (2 work-days: Sun+Mon 2026-09-06/07).
  await EmployeeRequest.create({
    employee_id: empA._id, branch_id: branch._id, type: 'sick',
    from_date: '2026-09-06', to_date: '2026-09-07', status: 'approved',
  });
  // עובדת ב׳ — a COMPLETELY UNRELATED employee — a long overlapping spell in
  // the SAME month. Before the fix this leaked into עובדת א׳'s count too.
  await EmployeeRequest.create({
    employee_id: empB._id, branch_id: branch._id, type: 'sick',
    from_date: '2026-09-15', to_date: '2026-09-30', status: 'approved',
  });

  console.log('syncSickDaysForMonth scopes to ONE employee, even with an overlapping stranger');
  {
    const req = { body: { employee_id: String(empA._id), month: '2026-09' } };
    const res = fakeRes();
    await syncSickDays(req, res, (err) => { if (err) throw err; });
    assert.strictEqual(res._body?.ok, true, 'sync itself must not error');

    const pm = await PayrollMonth.findOne({ employee_id: empA._id, month: '2026-09' }).lean();
    assert.strictEqual(pm.manual.sick_days, 2, `expected 2 (her own spell only), got ${pm.manual.sick_days}`);
    ok('עובדת א׳ gets exactly her own 2 sick work-days — none of עובדת ב׳\'s 12+ leaked in');
  }

  console.log('an employee with NO linked user_id (the ownerMatch $or never triggers) is unaffected either way');
  {
    await EmployeeRequest.create({
      employee_id: empB._id, branch_id: branch._id, type: 'sick',
      from_date: '2026-10-05', to_date: '2026-10-06', status: 'approved',
    });
    const req = { body: { employee_id: String(empB._id), month: '2026-10' } };
    const res = fakeRes();
    await syncSickDays(req, res, (err) => { if (err) throw err; });
    const pm = await PayrollMonth.findOne({ employee_id: empB._id, month: '2026-10' }).lean();
    assert.strictEqual(pm.manual.sick_days, 2, `expected 2, got ${pm.manual.sick_days}`);
    ok('an employee without a linked user account still syncs correctly (regression guard)');
  }

  await mongoose.disconnect();
  await mongod.stop();

  console.log(`\nAll sick-days-sync-scope tests passed (${passed} checks).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
