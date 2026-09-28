#!/usr/bin/env node
/**
 * דמי חגים prices a day at an hourly employee's average hours/day — and that
 * average must come from her last 3 months of history, not from whatever the
 * current month's punches happen to show. A employee who works 4h/day all
 * year but took a light week the month a חג falls in was being paid a
 * shrunken holiday day for it; a heavy week inflated it the same way.
 *
 * holidayAvgHoursByEmp is the one place this average is computed — both
 * fetchMonthData's live table and the applyAutoHolidays batch route call it,
 * so a fix here fixes both at once.
 *
 *   node scripts/holiday-avg-hours.test.js
 */

/* Nothing may read server/.env — stub dotenv before config/env loads it. */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const assert = require('assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
const ok = (label) => { console.log('  ✓ ' + label); passed += 1; };

async function main() {
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'holiday_avg_hours_test' } });
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'x';
  process.env.DISABLE_JOBS = '1';

  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);

  const { PayrollMonth } = require('../src/models');
  const { holidayAvgHoursByEmp } = require('../src/controllers/payrollMonth.controller');

  const empA = new mongoose.Types.ObjectId();
  const empB = new mongoose.Types.ObjectId();

  // עובדת א': three months of real history, 6-8-7 hours/day averaging 7h/day
  // across the window — the month being paid (2026-09) is NOT in this list,
  // so if the window ever included it the average would shift.
  await PayrollMonth.create([
    { employee_id: empA, branch_id: new mongoose.Types.ObjectId(), month: '2026-06',
      pay_summary: { recorded_at: new Date(), days_for_payslip: 20, paid_hours: 120 } }, // 6h/day
    { employee_id: empA, branch_id: new mongoose.Types.ObjectId(), month: '2026-07',
      pay_summary: { recorded_at: new Date(), days_for_payslip: 20, paid_hours: 160 } }, // 8h/day
    { employee_id: empA, branch_id: new mongoose.Types.ObjectId(), month: '2026-08',
      pay_summary: { recorded_at: new Date(), days_for_payslip: 20, paid_hours: 140 } }, // 7h/day
    // A month OUTSIDE the 3-month window (2026-05) — must not affect the average.
    { employee_id: empA, branch_id: new mongoose.Types.ObjectId(), month: '2026-05',
      pay_summary: { recorded_at: new Date(), days_for_payslip: 20, paid_hours: 20 } }, // 1h/day — an outlier
    // עובדת ב': no recorded pay_summary at all — brand new employee.
  ]);

  console.log('holidayAvgHoursByEmp — averages the 3 months before the paid month');
  {
    const map = await holidayAvgHoursByEmp([empA, empB], '2026-09');
    // (120+160+140) / (20+20+20) = 420/60 = 7
    assert.strictEqual(map.get(String(empA)), 7, `expected 7h/day, got ${map.get(String(empA))}`);
    ok('שלושה חודשים (יוני-אוגוסט) → ממוצע 7 שעות ליום, בדיוק');

    assert.strictEqual(map.has(String(empB)), false, 'an employee with no history must be absent from the map, not 0');
    ok('עובדת בלי היסטוריה בכלל — לא מופיעה במפה (לא 0)');
  }

  console.log('the month being paid, and months outside the window, are excluded');
  {
    // Add a current-month (2026-09) row with a wildly different rate — if the
    // window ever included the paid month itself, this would change the result.
    await PayrollMonth.create({
      employee_id: empA, branch_id: new mongoose.Types.ObjectId(), month: '2026-09',
      pay_summary: { recorded_at: new Date(), days_for_payslip: 20, paid_hours: 400 }, // 20h/day, absurd
    });
    const map = await holidayAvgHoursByEmp([empA], '2026-09');
    assert.strictEqual(map.get(String(empA)), 7, 'the paid month itself must not enter its own average');
    ok('החודש המשולם עצמו לא נכנס לממוצע של עצמו — עדיין 7');
  }

  console.log('a window with zero recorded days yields no usable average (null-like: absent from the map)');
  {
    const empC = new mongoose.Types.ObjectId();
    await PayrollMonth.create({
      employee_id: empC, branch_id: new mongoose.Types.ObjectId(), month: '2026-08',
      pay_summary: { recorded_at: new Date(), days_for_payslip: 0, paid_hours: 0 },
    });
    const map = await holidayAvgHoursByEmp([empC], '2026-09');
    assert.strictEqual(map.get(String(empC)), null, 'zero days on file → the caller must fall back, not divide by zero');
    ok('אפס ימים בהיסטוריה → null, לא חלוקה באפס ולא 0 שעות');
  }

  await mongoose.disconnect();
  await mongod.stop();

  console.log(`\nAll holiday-avg-hours tests passed (${passed} checks).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
