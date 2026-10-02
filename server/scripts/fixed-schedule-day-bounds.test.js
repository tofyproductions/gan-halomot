#!/usr/bin/env node
/**
 * Day-scoped punch writes must touch EXACTLY one Israel day (אורלי, 02.10.2026).
 *
 * Three code paths used a `day 00:00 + 36h` window — which reaches into the
 * NEXT day until noon — for punch writes, so acting on one day also hit the
 * following morning:
 *   1. setFixedScheduleException (editing a day's fixed hours) deleted the
 *      next day's generated IN punch; rematerialize then skipped the
 *      half-occupied day, leaving it one punch short. The reported case.
 *   2. deletePunch on a generated punch deleted the next day's pair too.
 *   3. resolveFixedConflict('fixed') marked the next morning's REAL clock
 *      punches ignored — silently dropping them from pay.
 *
 *   node scripts/fixed-schedule-day-bounds.test.js
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

const mockRes = () => {
  const res = { code: 200, body: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const adminReq = (over) => ({ user: { id: null, role: 'system_admin', full_name: 'בדיקה' }, params: {}, body: {}, query: {}, ...over });
const fail = (e) => { throw e; };

async function main() {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'fixed_day_bounds_test' } });
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'x';
  process.env.DISABLE_JOBS = '1';

  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);

  const { Branch, Amuta, Employee, Punch } = require('../src/models');
  const fixedSchedule = require('../src/services/fixedSchedule');
  const payrollC = require('../src/controllers/payroll.controller');
  const payrollMonthC = require('../src/controllers/payrollMonth.controller');

  const branch = await Branch.create({ name: 'סניף בדיקה', address: 'כתובת' });
  const amuta = await Amuta.create({ name: 'עמותת בדיקה' });
  const month = '2026-09';

  const ILK = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(d));
  const genFor = (empId, date) => Punch.find({
    employee_id: empId, timestamp_source: 'fixed_schedule',
  }).lean().then(list => list.filter(p => ILK(p.timestamp) === date));

  console.log('ilDayBounds spans exactly one Israel day');
  {
    const b = fixedSchedule.ilDayBounds('2026-09-02');
    assert.strictEqual(b.from.toISOString(), '2026-09-01T21:00:00.000Z');
    assert.strictEqual(b.to.toISOString(), '2026-09-02T21:00:00.000Z');
    ok('[from, to) = [02.09 00:00, 03.09 00:00) שעון ישראל');
  }

  console.log('editing one day\'s fixed hours leaves the next day intact (the reported case)');
  const emp = await Employee.create({
    full_name: 'אורלי בדיקה', israeli_id: '222333444', branch_id: branch._id,
    salary_type: 'hourly', hourly_rate: 50, is_active: true,
    start_date: new Date('2024-01-01'), work_days: [0, 1, 2, 3, 4],
    amuta_distribution: [{ amuta_id: amuta._id, hourly_rate: 50 }],
    fixed_schedule: {
      enabled: true,
      days: [0, 1, 2, 3, 4].map(w => ({ weekday: w, in: '08:00', out: '16:00' })),
      start_date: '2026-09-01',
    },
  });
  await fixedSchedule.materializeMonth(month, { employeeIds: [emp._id] });
  {
    // 02.09 is a Wednesday, 03.09 a Thursday — both workdays with a pair each.
    assert.strictEqual((await genFor(emp._id, '2026-09-02')).length, 2, 'baseline: 02.09 has its pair');
    assert.strictEqual((await genFor(emp._id, '2026-09-03')).length, 2, 'baseline: 03.09 has its pair');

    const res = mockRes();
    await payrollC.setFixedScheduleException(adminReq({
      params: { employeeId: String(emp._id) },
      body: { date: '2026-09-02', off: false, in: '08:00', out: '12:00' },
    }), res, fail);
    assert.strictEqual(res.code, 200, `exception saved (got ${res.code}: ${JSON.stringify(res.body)})`);

    const d2 = await genFor(emp._id, '2026-09-02');
    assert.strictEqual(d2.length, 2, '02.09 regenerated as a pair with the new hours');
    const d3 = await genFor(emp._id, '2026-09-03');
    assert.strictEqual(d3.length, 2, '03.09 still has BOTH its punches — nothing spilled over');
    ok('שינוי שעות ליום אחד לא מוחק החתמה מהיום שאחריו');
  }

  console.log('deleting one generated punch clears only that day');
  {
    const d8 = await genFor(emp._id, '2026-09-08');
    assert.strictEqual(d8.length, 2, 'baseline: 08.09 has its pair');
    const res = mockRes();
    await payrollC.deletePunch(adminReq({ params: { id: String(d8[0]._id) } }), res, fail);
    assert.strictEqual(res.code, 200, `delete ok (got ${res.code}: ${JSON.stringify(res.body)})`);
    assert.strictEqual((await genFor(emp._id, '2026-09-08')).length, 0, '08.09 cleared (pair + day off)');
    assert.strictEqual((await genFor(emp._id, '2026-09-09')).length, 2, '09.09 untouched');
    ok('מחיקת החתמה מיוצרת מנקה רק את היום שלה');
  }

  console.log("resolveFixedConflict('fixed') ignores only that day's clock punches");
  {
    const il = (date, hhmm) => fixedSchedule.ilDateTime(date, hhmm);
    const mkDevice = (date, hhmm, state) => Punch.create({
      branch_id: branch._id, employee_id: emp._id, israeli_id: emp.israeli_id,
      device_user_sn: Math.floor(Math.random() * 1e9),
      timestamp: il(date, hhmm), timestamp_source: 'device', state,
      approval_status: 'auto',
    });
    await mkDevice('2026-09-14', '08:10', 0); await mkDevice('2026-09-14', '15:40', 1);
    await mkDevice('2026-09-15', '08:05', 0); await mkDevice('2026-09-15', '15:50', 1);

    const res = mockRes();
    await payrollMonthC.resolveFixedConflict(adminReq({
      body: { employee_id: String(emp._id), date: '2026-09-14', decision: 'fixed' },
    }), res, fail);
    assert.strictEqual(res.code, 200, `conflict resolved (got ${res.code}: ${JSON.stringify(res.body)})`);

    const real = await Punch.find({ employee_id: emp._id, timestamp_source: 'device' }).lean();
    const d14 = real.filter(p => ILK(p.timestamp) === '2026-09-14');
    const d15 = real.filter(p => ILK(p.timestamp) === '2026-09-15');
    assert.ok(d14.every(p => p.ignored === true), '14.09: both clock punches ignored, as decided');
    assert.ok(d15.every(p => !p.ignored), '15.09: the next day\'s REAL punches are NOT ignored');
    ok('החלטת "לפי שעות קבועות" לא מעלימה החתמות אמת מהיום שאחריה');
  }

  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\nAll fixed-schedule day-bounds tests passed (${passed} checks).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
