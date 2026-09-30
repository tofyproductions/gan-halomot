#!/usr/bin/env node
/**
 * A תקן employee's statutory holidays are paid as דמי חגים (code 44), and her
 * leave as תמורת חופשה (code 8) — both carved out of השלמת שכר (code 47), in
 * that order, never above the agreed salary.
 *
 * Until 30.09.2026 both sat inside the completion. computeHolidayPay said so in
 * as many words — "hourly only — global is paid for holidays via the salary
 * itself" — and in every holiday month the export filed a תקן employee 44 = 0×0,
 * switching her דמי חגים off explicitly. Owner's rulings that day:
 *   - code 47 carries no social benefits; 44 and 8 do. A paid day she did not
 *     work belongs on the line that is pensioned.
 *   - statutory holidays (the law's list) → 44. Other closure days (ערב חג, חול
 *     המועד) are the gan's calendar leave → 8. The engine already splits them:
 *     calendar closures become leave days EXCLUDING the statutory ones.
 *   - no seniority condition for a תקן employee's holidays.
 *   - holidays are carved BEFORE leave.
 *
 * The September 2026 closures are the real ones of כפר סבא - משה דיין:
 *   ראש השנה 11–13.9 · יום כיפור 20–21.9 · סוכות 25.9–3.10
 * On a Sun–Thu commitment that is 7 committed days shut: 13.9 and 21.9 are
 * statutory (ראש השנה ב׳, יום כיפור); 20.9 and 27–30.9 are the gan's leave.
 * (ראש השנה א׳ and סוכות א׳ fell on Saturday; 11.9 and 25.9 are Fridays.)
 *
 *   node scripts/teken-holiday-pay.test.js
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
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function main() {
  console.log('0. the carve itself — order and ceiling');
  {
    const { carveFromCompletion, tekenHolidayDays } = require('../src/services/tekenCompletionCarve');
    const a = carveFromCompletion(1000, [
      { key: 'holiday', days: 2, want: 600 },
      { key: 'vacation', days: 3, want: 900 },
    ]);
    assert.strictEqual(a.allocations.holiday.got, 600, 'the first claim takes its full value');
    assert.strictEqual(a.allocations.vacation.got, 400, 'the second takes only what is left');
    assert.strictEqual(a.allocations.vacation.unfunded, 500, 'and the rest is reported, not lost');
    assert.strictEqual(a.remaining, 0);
    assert.strictEqual(a.carved, 1000, 'never more than the completion — never above the agreed salary');
    const b = carveFromCompletion(0, [{ key: 'holiday', days: 2, want: 600 }]);
    assert.strictEqual(b.allocations.holiday.got, 0, 'an empty completion moves nothing');
    const c = carveFromCompletion(5000, [{ key: 'holiday', days: 1, want: 400 }]);
    assert.strictEqual(c.remaining, 4600, 'and what is not claimed stays completion');
    ok('claims are taken in order, each capped at what is left, the shortfall reported');

    const holidays = [
      { date: '2026-09-12', name: "ראש השנה א'" }, { date: '2026-09-13', name: "ראש השנה ב'" },
      { date: '2026-09-21', name: 'יום כיפור' }, { date: '2026-09-26', name: "סוכות א'" },
    ];
    const committed = ['2026-09-13', '2026-09-14', '2026-09-21', '2026-09-22'];
    const days = tekenHolidayDays(holidays, committed, ['2026-09-14']);
    assert.deepStrictEqual(days.map((d) => d.date), ['2026-09-13', '2026-09-21'],
      'Saturday holidays are not working days she missed');
    const worked = tekenHolidayDays(holidays, committed, ['2026-09-21']);
    assert.ok(!worked.some((d) => d.date === '2026-09-21'), 'a holiday she worked is a worked day, not דמי חגים');
    ok('a holiday counts only on her committed day, and only if she did not work it');
  }

  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'teken_holiday' } });
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'x';
  process.env.DISABLE_JOBS = '1';
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);

  const { Branch, Amuta, Employee, PayrollMonth, Punch, EmployeeCommitment, Holiday } = require('../src/models');
  const { fetchMonthData, buildAccountantHtml, finalizeMonth } = require('../src/controllers/payrollMonth.controller');
  const { buildExportSource } = require('../src/services/payrollExport/sourceLayer');
  const shkulit = require('../src/services/payrollExport/shkulitAdapter');

  const month = '2026-09';
  const branch = await Branch.create({ name: 'כפר סבא - בדיקה', address: 'כתובת' });
  const amuta = await Amuta.create({ name: 'עמותת בדיקה' });
  const d = (s) => new Date(`${s}T00:00:00.000Z`);
  for (const [name, from, to] of [
    ['ראש השנה', '2026-09-11', '2026-09-13'],
    ['יום כיפור', '2026-09-20', '2026-09-21'],
    ['סוכות', '2026-09-25', '2026-10-03'],
  ]) {
    await Holiday.create({
      branch_id: branch._id, academic_year: '2026-2027', name,
      start_date: d(from), end_date: d(to), kind: 'closure',
    });
  }

  let sn = 7000;
  const workDay = async (emp, day, fromH, toH) => {
    for (const h of [fromH, toH]) {
      await Punch.create({
        branch_id: branch._id, employee_id: emp._id, israeli_id: emp.israeli_id,
        device_user_sn: sn++, timestamp: new Date(Date.UTC(2026, 8, day, h - 3, 0, 0)), approval_status: 'auto',
      });
    }
  };
  const SUN_THU = [1, 2, 3, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 20, 21, 22, 23, 24, 27, 28, 29, 30];
  const SHUT = new Set([13, 20, 21, 27, 28, 29, 30]);
  const OPEN = SUN_THU.filter((x) => !SHUT.has(x));

  const make = async (name, no, idn) => {
    const e = await Employee.create({
      full_name: name, israeli_id: idn, employee_number: no,
      branch_id: branch._id, salary_type: 'global', global_salary: 10300, is_active: true,
      start_date: new Date('2026-09-01'), // NEW this month — no seniority, and it must not matter
      work_days: [0, 1, 2, 3, 4],
      amuta_distribution: [{ amuta_id: amuta._id, global_salary: 10300 }],
      bank_number: '10', bank_branch: '1', bank_account: `55${no}`,
      vacation_balance_opening: 10, vacation_monthly_accrual: 1,
    });
    await EmployeeCommitment.create({
      employee_id: e._id, branch_id: branch._id,
      days: [0, 1, 2, 3, 4].map((day) => ({ day, is_off: false, start_hhmm: '08:00', end_hhmm: '16:00' })),
    });
    await PayrollMonth.create({ employee_id: e._id, branch_id: branch._id, month, manual: {} });
    return e;
  };

  // אפרת משעלי's real schedule: Sun–Wed 07:00–17:00 (10h), Thu off, Fri
  // 07:30–12:00 (4.5h). Unequal days are where pricing BY THE DAY matters: at
  // the average (₪409) her nine shut days came to ₪3,682, more than the whole
  // completion they are carved from.
  const efratDays = [
    ...[0, 1, 2, 3].map((day) => ({ day, is_off: false, start_hhmm: '07:00', end_hhmm: '17:00' })),
    { day: 4, is_off: true, start_hhmm: '', end_hhmm: '' },
    { day: 5, is_off: false, start_hhmm: '07:30', end_hhmm: '12:00' },
  ];
  const makeEfrat = async (name, no, idn) => {
    const e = await Employee.create({
      full_name: name, israeli_id: idn, employee_number: no,
      branch_id: branch._id, salary_type: 'global', global_salary: 9000, is_active: true,
      start_date: new Date('2023-01-01'), work_days: [0, 1, 2, 3, 5],
      amuta_distribution: [{ amuta_id: amuta._id, global_salary: 9000 }],
      bank_number: '10', bank_branch: '1', bank_account: `66${no}`,
      vacation_balance_opening: 20, vacation_monthly_accrual: 1,
    });
    await EmployeeCommitment.create({ employee_id: e._id, branch_id: branch._id, days: efratDays });
    await PayrollMonth.create({ employee_id: e._id, branch_id: branch._id, month, manual: {} });
    return e;
  };
  const punchAt = async (emp, day, h1, m1, h2, m2) => {
    for (const [h, m] of [[h1, m1], [h2, m2]]) {
      await Punch.create({
        branch_id: branch._id, employee_id: emp._id, israeli_id: emp.israeli_id,
        device_user_sn: sn++, timestamp: new Date(Date.UTC(2026, 8, day, h - 3, m, 0)), approval_status: 'auto',
      });
    }
  };
  const EF_LONG = [1, 2, 6, 7, 8, 9, 13, 14, 15, 16, 20, 21, 22, 23, 27, 28, 29, 30];
  const EF_FRI = [4, 11, 18, 25];
  const EF_SHUT = new Set([11, 13, 20, 21, 25, 27, 28, 29, 30]);
  // Works every open day exactly as committed.
  const efrat = await makeEfrat('תקן — ימים לא שווים', '803', '300000013');
  for (const day of EF_LONG.filter((x) => !EF_SHUT.has(x))) await punchAt(efrat, day, 7, 0, 17, 0);
  for (const day of EF_FRI.filter((x) => !EF_SHUT.has(x))) await punchAt(efrat, day, 7, 30, 12, 0);
  // The same, but away without explanation on Fri 18.9 and Tue 22.9 — a short
  // day and a long day, deducted at what EACH is worth.
  const absent = await makeEfrat('תקן — היעדרות לפי יום', '804', '300000014');
  for (const day of EF_LONG.filter((x) => !EF_SHUT.has(x) && x !== 22)) await punchAt(absent, day, 7, 0, 17, 0);
  for (const day of EF_FRI.filter((x) => !EF_SHUT.has(x) && x !== 18)) await punchAt(absent, day, 7, 30, 12, 0);

  // Worked every open day exactly: the completion is precisely the 7 shut days.
  const full = await make('תקן — ההשלמה מכסה הכל', '801', '300000011');
  for (const day of OPEN) await workDay(full, day, 8, 16);
  // Worked 10h on every open day: the overtime eats most of the completion, so
  // there is not enough for both — the holidays must be the ones paid in full.
  const short = await make('תקן — השלמה קטנה', '802', '300000012');
  for (const day of OPEN) await workDay(short, day, 8, 18);

  const data = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });
  const rows = data.rows || [];
  assert.strictEqual(rows.length, 4, 'all four employees reach the table');
  const source = buildExportSource(month, rows);
  const { rows: fileRows } = shkulit.buildMovements(source, new Map(), {});
  const DAY = r2(10300 / 22);

  const pick = (no) => ({
    row: rows.find((x) => String(x.employee_number) === no),
    ce: source.ready.find((x) => x.employee.employee_number === no),
    file: fileRows.filter((x) => String(x[1]) === no && x[2] === 1),
  });
  // Each row rounded to the agora BEFORE summing — that is what the payslip
  // shows. The תקן base goes out as salary × מקדם with the מקדם carrying six
  // decimals (10,300 × 0.681818 = 7,022.7254 → 7,022.73), so an unrounded sum
  // drifts by an agora that no line on the payslip actually holds.
  const code = (file, c) => file.filter((x) => x[3] === c).reduce((t, x) => t + r2(x[4] * x[5]), 0);

  console.log('1. statutory holidays → code 44, out of the completion — even in her first month');
  {
    const { row, ce, file } = pick('801');
    assert.ok(ce, 'she is in the export');
    assert.strictEqual(r2(ce.earnings.holiday_pay), r2(2 * DAY),
      `two statutory holidays on her working days (13.9, 21.9) × ₪${DAY}; got ₪${ce.earnings.holiday_pay}`);
    assert.strictEqual(r2(code(file, 44)), r2(2 * DAY), 'filed on code 44 at that value');
    assert.strictEqual(r2(file.filter((x) => x[3] === 44).reduce((t, x) => t + x[5], 0)), 2, 'for two days');
    assert.ok(!(ce.flags || {}).holiday_pay_denied, 'and no longer switched off with 44 = 0×0');
    ok('13.9 and 21.9 are paid as דמי חגים — no seniority condition for a תקן employee');

    const vacDays = Number(row.vacation_usage?.paid ?? row.vacation_eff_days) || 0;
    assert.strictEqual(vacDays, 5, `the gan's other closure days are leave: 20.9 and 27–30.9; got ${vacDays}`);
    assert.strictEqual(r2(ce.earnings.vacation_pay), r2(5 * DAY), 'paid as תמורת חופשה, five days');
    assert.strictEqual(r2(code(file, 8)), r2(5 * DAY), 'filed on code 8');
    ok('ערב חג and חול המועד are leave (code 8), not דמי חגים');

    const salary = code(file, 1) + code(file, 8) + code(file, 32) + code(file, 33) + code(file, 44) + code(file, 47);
    assert.strictEqual(r2(salary), 10300, `her salary lines make exactly ₪10,300; got ₪${r2(salary)}`);
    assert.ok(r2(code(file, 47)) <= 0.02, `and the completion is (to the agora) empty; got ₪${r2(code(file, 47))}`);
    ok('the seven shut days moved off code 47 whole — and not a shekel was added');
  }

  console.log('2. not enough completion for both — holidays are paid first');
  {
    const { row, ce, file } = pick('802');
    const holWant = r2(2 * DAY);
    assert.strictEqual(r2(ce.earnings.holiday_pay), holWant, 'the holidays take their FULL value');
    assert.ok(r2(ce.earnings.vacation_pay) < r2(5 * DAY), 'the leave takes only what is left');
    assert.ok(Number(row.teken_vacation_unfunded) > 0, 'and the leave that did not fit is recorded');
    const salary = code(file, 1) + code(file, 8) + code(file, 32) + code(file, 33) + code(file, 44) + code(file, 47);
    assert.strictEqual(r2(salary), 10300, `still exactly ₪10,300 — never above; got ₪${r2(salary)}`);
    assert.strictEqual(r2(code(file, 47)), 0, 'the completion is used up, not overdrawn');
    ok('holidays in full, leave from the remainder, the total unmoved');
  }

  console.log('2b. unequal days — each priced by its own hours, and it FITS');
  {
    const { row, ce, file } = pick('803');
    const hv = 9000 / 207;
    const long = r2(10.5 * hv); const fri = r2(4.5 * hv);
    assert.strictEqual(long, 456.52, 'a 10-hour day = 10.5 weighted hours × 43.48');
    assert.strictEqual(fri, 195.65, 'a Friday = 4.5 × 43.48');
    assert.strictEqual(r2(ce.earnings.holiday_pay), r2(2 * long),
      `13.9 and 21.9 are long days: 2 × ₪${long}; got ₪${ce.earnings.holiday_pay}`);
    const leave = r2(5 * long + 2 * fri); // 20, 27–30 long · 11, 25 Friday
    assert.strictEqual(r2(ce.earnings.vacation_pay), leave,
      `the seven leave days by their own hours: 5 long + 2 Fridays = ₪${leave}; got ₪${ce.earnings.vacation_pay}`);
    assert.strictEqual(row.breakdown.components.teken_breakdown.leave_priced_by, 'day', 'priced from the calendar dates');
    assert.ok(!(Number(row.teken_vacation_unfunded) > 0.02),
      `nothing left unfunded — at the average ₪95 was; got ₪${row.teken_vacation_unfunded}`);
    assert.ok(r2(code(file, 47)) <= 0.02, 'the completion is used exactly');
    const salary = code(file, 1) + code(file, 8) + code(file, 32) + code(file, 33) + code(file, 44) + code(file, 47);
    assert.strictEqual(r2(salary), 9000, `exactly ₪9,000; got ₪${r2(salary)}`);
    ok('holidays and leave priced by the day fill the completion exactly — the ₪95 gap is gone');
  }

  console.log('2c. an absent day is deducted at what THAT day is worth — and finalizing keeps it');
  {
    const { row } = pick('804');
    const hv = 9000 / 207;
    const want = r2(r2(4.5 * hv) + r2(10.5 * hv)); // Fri 18.9 + Tue 22.9
    assert.strictEqual(r2(row.absence.deduction), want,
      `a Friday and a long day: ₪195.65 + ₪456.52 = ₪${want} (the average would have said ₪818.18); got ₪${row.absence.deduction}`);

    let finalized = null;
    await finalizeMonth(
      { params: { month }, query: { branch: String(branch._id) }, user: { id: new mongoose.Types.ObjectId(), role: 'system_admin' } },
      { json: (b) => { finalized = b; }, status() { return this; } },
      (e) => { throw e; },
    );
    const frozen = await PayrollMonth.findOne({ employee_id: absent._id, month }).lean();
    assert.strictEqual(frozen.status, 'finalized', 'the month is closed');
    const frozenDeduction = Number(frozen.auto_snapshot?.deductions?.absence ?? frozen.auto_snapshot?.absence_deduction ?? NaN);
    assert.strictEqual(r2(frozenDeduction), want,
      `the frozen snapshot holds the same ₪${want} the screen showed; got ₪${frozenDeduction}`);
    ok('by the day, and the live screen and the closed month agree to the agora');
  }

  console.log('3. the card names the דמי חגים');
  {
    const html = buildAccountantHtml(month, rows, new Map([[String(branch._id), branch.name]]));
    const i = html.indexOf('data-emp-name="תקן — ההשלמה מכסה הכל"');
    const j = html.indexOf('data-emp-name=', i + 1);
    const card = (j > i ? html.slice(i, j) : html.slice(i)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.ok(card.includes('דמי חגים'), 'the field is on the card');
    assert.ok(card.includes(String(Math.round(2 * DAY)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')),
      `with its amount (₪${Math.round(2 * DAY)})`);
    ok('the accountant sees the amount the file carries on code 44');
  }

  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\nAll תקן holiday-pay tests passed (${passed} checks).`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
