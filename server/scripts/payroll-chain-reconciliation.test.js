#!/usr/bin/env node
/**
 * THE CHAIN, RECONCILED — payroll table → accountant card → שקלולית file.
 *
 * Three separate consumers read the same payroll row, and each one used to be
 * able to drop a component on its own without anything noticing:
 *
 *   - the accountant CARD showed a total that none of its printed fields added
 *     up to (אסתר גוטליב's ₪955 one-off had no field at all — 29.09.2026);
 *   - the שקלולית FILE left money out entirely (ליאור מחפוד's ₪1,829 of
 *     approved extra hours — 29.09.2026);
 *   - and silence in the file is not neutral: שקלולית keeps a component that
 *     is missing from this month at last month's value and pays it AGAIN
 *     (גלאם רות was paid דמי חגים she is not entitled to — 29.09.2026).
 *
 * Each of those was found by a human reading one payslip. This file is the
 * machine that reads all of them, on every run, and states the invariant the
 * three bugs broke:
 *
 *   1. MONEY CLOSES. Everything the file pays, plus everything it deliberately
 *      hands to the accountant as a note instead of a row, equals the total
 *      the table shows. No third answer, no silent remainder.
 *   2. NOTHING VANISHES. Every nonzero component on the row is NAMED on the
 *      accountant's card and is either a row or a note in the file.
 *   3. QUANTITIES AGREE. Hours and days say the same number in all three.
 *
 * The employees below are built through the REAL engine (punches, commitments,
 * manual fields → fetchMonthData), not hand-written breakdowns, so the numbers
 * being reconciled are the ones production computes.
 *
 *   node scripts/payroll-chain-reconciliation.test.js
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

const RECORD = { SALARY: 1, IMPUTED: 2, VOLUNTARY: 3, ATTENDANCE: 4 };

async function main() {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'chain_reconciliation' } });
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'x';
  process.env.DISABLE_JOBS = '1';

  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);

  const { Branch, Amuta, Employee, PayrollMonth, Punch } = require('../src/models');
  const { fetchMonthData, buildAccountantHtml } = require('../src/controllers/payrollMonth.controller');
  const { buildExportSource } = require('../src/services/payrollExport/sourceLayer');
  const shkulit = require('../src/services/payrollExport/shkulitAdapter');

  const month = '2026-09';
  const branch = await Branch.create({ name: 'סניף בדיקה', address: 'כתובת' });
  const amuta = await Amuta.create({ name: 'עמותת בדיקה' });

  // A worked day = an in punch and an out punch. Sundays–Thursdays only, so the
  // commitment logic sees an ordinary working week.
  let sn = 5000;
  const workDay = async (emp, day, fromH, toH) => {
    for (const h of [fromH, toH]) {
      const ts = new Date(Date.UTC(2026, 8, day, h - 3, 0, 0)); // Israel = UTC+3
      await Punch.create({
        branch_id: branch._id, employee_id: emp._id, israeli_id: emp.israeli_id,
        device_user_sn: sn++, timestamp: ts, approval_status: 'auto',
      });
    }
  };
  // 01–04 and 07–11 September 2026 are Tue–Fri / Mon–Fri; the engine only cares
  // that a punch pair exists on a day inside the month.
  const SEP_WORKDAYS = [1, 2, 3, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 20, 22, 23, 24];

  // ── the cast ──────────────────────────────────────────────────────────────
  const hourly = await Employee.create({
    full_name: 'שעתית — תמהיל מלא', israeli_id: '300000001', employee_number: '901',
    branch_id: branch._id, salary_type: 'hourly', hourly_rate: 45, is_active: true,
    start_date: new Date('2023-01-01'), work_days: [0, 1, 2, 3, 4],
    amuta_distribution: [{ amuta_id: amuta._id, hourly_rate: 45 }],
    bank_number: '11', bank_branch: '44', bank_account: '17128',
    vacation_balance_opening: 10, vacation_monthly_accrual: 1,
  });
  const teken = await Employee.create({
    full_name: 'תקן — תמהיל מלא', israeli_id: '300000002', employee_number: '902',
    branch_id: branch._id, salary_type: 'global', global_salary: 10300,
    required_hours: 162.5, is_active: true,
    start_date: new Date('2023-01-01'), work_days: [0, 1, 2, 3, 4],
    // The rate the engine actually prices from lives on the distribution entry,
    // not on the top-level field (payrollCalc.js:183 picks the first entry that
    // carries one). A teken employee configured only at the top level computes
    // a base salary of ZERO — which still reconciles perfectly across all three
    // layers, and is why the sanity check below exists.
    amuta_distribution: [{ amuta_id: amuta._id, global_salary: 10300, required_hours: 162.5 }],
    bank_number: '10', bank_branch: '742', bank_account: '2280976',
    vacation_balance_opening: 10, vacation_monthly_accrual: 1,
  });
  // The גלאם רות case: started this month, so no holiday seniority.
  const fresh = await Employee.create({
    full_name: 'שעתית חדשה — ללא ותק לחגים', israeli_id: '300000003', employee_number: '903',
    branch_id: branch._id, salary_type: 'hourly', hourly_rate: 42, is_active: true,
    start_date: new Date('2026-09-01'), work_days: [0, 1, 2, 3, 4],
    amuta_distribution: [{ amuta_id: amuta._id, hourly_rate: 42 }],
    bank_number: '12', bank_branch: '123', bank_account: '999111',
  });

  for (const day of SEP_WORKDAYS) {
    await workDay(hourly, day, 8, 16);
    await workDay(teken, day, 8, 16);
    await workDay(fresh, day, 8, 14);
  }

  await PayrollMonth.create({
    employee_id: hourly._id, branch_id: branch._id, month,
    manual: {
      vacation_days: 2, sick_days: 0,
      gift_card: { kind: 'number', amount: 150 },
      cibus: { kind: 'number', amount: 250 },
      one_time_salary_completion: { amount: 955, note: 'השלמה על שעות 08.2026' },
    },
  });
  await PayrollMonth.create({
    employee_id: teken._id, branch_id: branch._id, month,
    manual: {
      vacation_days: 1,
      gift_card: { kind: 'number', amount: 250 },
      one_time_bonus: { amount: 400, note: 'בונוס חד פעמי' },
    },
  });
  await PayrollMonth.create({
    employee_id: fresh._id, branch_id: branch._id, month, manual: {},
  });

  const data = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });
  const rows = (data.rows || []).filter((x) => !x.is_freelancer);
  assert.strictEqual(rows.length, 3, 'all three employees must reach the table');

  const source = buildExportSource(month, rows);
  assert.strictEqual((source.blocked || []).length, 0,
    `no employee may be blocked from the export: ${JSON.stringify(source.blocked)}`);
  assert.strictEqual(source.ready.length, 3);
  const { rows: fileRows, notes } = shkulit.buildMovements(source);

  // ── 1. MONEY CLOSES ───────────────────────────────────────────────────────
  //
  // Everything the file PAYS (salary + imputed rows; attendance rows carry a
  // rate of 0 and are counts, not money) plus everything we deliberately keep
  // OFF the file as a note — הבראה, loan repayment and meal vouchers, whose
  // שקלולית codes are still unconfirmed — has to come back to the table's own
  // total. A remainder means a component fell out of the chain.
  console.log('1. money closes — the file plus its notes equals the table');
  for (const ce of source.ready) {
    const empNo = String(ce.employee.employee_number);
    const row = rows.find((x) => String(x.employee_number) === empNo);
    const mine = fileRows.filter((x) => String(x[1]) === empNo);
    const sum = (t) => mine.filter((x) => x[2] === t)
      .reduce((s, x) => s + (Number(x[4]) || 0) * (Number(x[5]) || 0), 0);
    // CASH. What the employee is actually paid: salary rows, less any voluntary
    // deduction. הכנסות זקופות (table 2) are deliberately NOT here — see below.
    const cash = sum(RECORD.SALARY) + sum(RECORD.VOLUNTARY);
    // Deliberately note-only, and therefore real money the file does not carry:
    // הבראה and תווי מזון (codes unconfirmed) and loan repayment (no code of
    // its own). The table's total already counts them, so the reconciliation
    // has to add them back or they read as a hole in the file.
    const offFile = (Number(ce.earnings.recreation) || 0)
      + (Number(ce.earnings.meal_vouchers) || 0)
      - (Number(ce.deductions.loans) || 0);
    const total = Number(row.breakdown?.estimated_total) || 0;
    const delta = r2(cash + offFile - total);
    console.log(`     ${ce.employee.full_name}: שכר ${r2(cash)} + מחוץ לקובץ ${r2(offFile)} = ${r2(cash + offFile)} · טבלה ${r2(total)} · פער ${delta} · זקופות ${r2(sum(RECORD.IMPUTED))}`);
    assert.ok(Math.abs(delta) <= 1.5,
      `${ce.employee.full_name}: the file's pay (${r2(cash)}) plus its notes (${r2(offFile)}) must equal the table's ${r2(total)} — off by ${delta}`);

    // הכנסות זקופות are a BENEFIT, not cash, and the table's "סה״כ משוער" is a
    // cash figure — so they are absent from it on purpose. That is only safe
    // while the two stay separate: the moment an imputed component starts
    // landing in the salary table, an employee is paid the value of her meal
    // card. So the imputed rows are reconciled to their own fields instead.
    assert.strictEqual(r2(sum(RECORD.IMPUTED)),
      r2((Number(ce.earnings.gift_card) || 0) + (Number(ce.earnings.cibus) || 0)),
      `${ce.employee.full_name}: the imputed rows must be exactly שי לחג + סיבוס`);
  }
  ok('every employee\'s pay rows reconcile to the total the table shows');
  ok('הכנסות זקופות stay out of the cash total and reconcile to their own fields');

  // Agreement between three layers is not the same as being RIGHT. All three
  // read the same row, so all three are wrong together when the engine hands
  // them a wrong number — a teken employee whose rate was configured in the
  // wrong place computed a base salary of zero and reconciled to the shekel.
  // So the chain is also checked against something outside it: the salary the
  // employee was actually promised.
  console.log('2. the reconciled number is also a sane one');
  for (const ce of source.ready) {
    if (ce.employee.salary_type !== 'global') continue;
    const agreed = Number(ce.earnings.teken_salary) || 0;
    assert.ok(agreed > 0, `${ce.employee.full_name}: a teken employee must carry her agreed salary into the export`);
    const empNo = String(ce.employee.employee_number);
    const tekenPay = fileRows
      .filter((x) => String(x[1]) === empNo && x[2] === RECORD.SALARY && [1, 32, 33, 47].includes(x[3]))
      .reduce((s, x) => s + x[4] * x[5], 0);
    console.log(`     ${ce.employee.full_name}: שכר תקן מוסכם ${r2(agreed)} · נשלח ${r2(tekenPay)}`);
    assert.strictEqual(r2(tekenPay), r2(agreed),
      `${ce.employee.full_name}: the teken components must add up to the agreed salary — ₪${r2(agreed)} promised, ₪${r2(tekenPay)} filed`);
  }
  ok('a תקן employee\'s filed components add up to exactly her agreed salary');

  // ── 2. NOTHING VANISHES ───────────────────────────────────────────────────
  //
  // Component by component: if the row carries money, the card must NAME it
  // and the file must either pay it or hand it over as a note. A total that
  // happens to add up can still hide a component paid under the wrong code.
  console.log('3. nothing vanishes — each component reaches the card and the file');
  const html = buildAccountantHtml(month, rows, new Map([[String(branch._id), branch.name]]));
  const cardOf = (name) => {
    const i = html.indexOf(`data-emp-name="${name}"`);
    assert.ok(i >= 0, `the card for ${name} must exist`);
    const j = html.indexOf('data-emp-name=', i + 1);
    return j > i ? html.slice(i, j) : html.slice(i);
  };

  // key → { amount, pdf: label that must appear, code: שקלולית code or null for note-only }
  const componentsOf = (ce) => ({
    'השלמת שכר (מעסיק)': { amount: ce.earnings.salary_completion, pdf: 'השלמת שכר', code: 47 },
    'השלמת שכר חד פעמית': { amount: ce.earnings.one_time_salary_completion, pdf: 'השלמת שכר חד פעמית', code: 38 },
    'תוספת שעות מעל התקן': { amount: ce.earnings.extra_hours_pay, pdf: 'תוספת שעות', code: 31 },
    'נסיעות': { amount: ce.earnings.travel, pdf: 'נסיעות', code: 3 },
    'דמי חגים': { amount: ce.earnings.holiday_pay, pdf: 'דמי חגים', code: 44 },
    'דמי מחלה': { amount: ce.earnings.sick_pay, pdf: 'מחלה', code: 34 },
    'תמורת חופשה': { amount: ce.earnings.vacation_pay, pdf: 'חופשה', code: 8 },
    'מילואים': { amount: ce.earnings.miluim, pdf: 'מילואים', code: 42 },
    'שי לחג': { amount: ce.earnings.gift_card, pdf: 'GIFT CARD', code: 22 },
    'סיבוס': { amount: ce.earnings.cibus, pdf: 'סיבוס', code: 21 },
  });

  for (const ce of source.ready) {
    const empNo = String(ce.employee.employee_number);
    const card = cardOf(ce.employee.full_name);
    const mine = fileRows.filter((x) => String(x[1]) === empNo);
    const myNotes = notes.filter((n) => String(n.employee_number) === empNo);
    for (const [name, spec] of Object.entries(componentsOf(ce))) {
      const amount = Number(spec.amount) || 0;
      if (!amount) continue;
      assert.ok(card.includes(spec.pdf),
        `${ce.employee.full_name}: ₪${amount} of ${name} is on the row and its field "${spec.pdf}" is absent from the accountant's card`);
      const filedRow = mine.find((x) => x[3] === spec.code && Math.abs(x[4] * x[5]) > 0);
      const noted = myNotes.some((n) => n.subject.includes(name.split(' ')[0]));
      assert.ok(filedRow || noted,
        `${ce.employee.full_name}: ₪${amount} of ${name} reaches neither a שקלולית row (code ${spec.code}) nor a note`);
      if (filedRow) {
        assert.strictEqual(r2(filedRow[4] * filedRow[5]), r2(amount),
          `${ce.employee.full_name}: ${name} is ₪${r2(amount)} on the row and ₪${r2(filedRow[4] * filedRow[5])} in the file`);
      }
    }
  }
  ok('every nonzero component is named on the card and carried by the file, at the same amount');

  // The bonus line is the one place two row fields legitimately become ONE
  // שקלולית row, so it is checked as a sum rather than per component.
  console.log('4. the combined בונוס row is exactly its parts');
  for (const ce of source.ready) {
    const empNo = String(ce.employee.employee_number);
    const want = r2((Number(ce.earnings.bonus) || 0)
      + (Number(ce.earnings.one_time_bonus) || 0)
      + (Number(ce.earnings.august_bonus) || 0));
    const got = fileRows.filter((x) => String(x[1]) === empNo && x[2] === RECORD.SALARY && x[3] === 35)
      .reduce((s, x) => s + x[4] * x[5], 0);
    assert.strictEqual(r2(got), want,
      `${ce.employee.full_name}: בונוס filed ₪${r2(got)} against ₪${want} of standing + one-off + August bonus`);
  }
  ok('בונוס קבוע + בונוס חד פעמי + בונוס אוגוסט arrive as one row worth exactly their sum');

  // ── 3. QUANTITIES AGREE ───────────────────────────────────────────────────
  console.log('5. hours and days say the same number everywhere');
  for (const ce of source.ready) {
    const empNo = String(ce.employee.employee_number);
    const row = rows.find((x) => String(x.employee_number) === empNo);
    const att = (code) => {
      const f = fileRows.find((x) => String(x[1]) === empNo && x[2] === RECORD.ATTENDANCE && x[3] === code);
      return f ? Number(f[5]) : 0;
    };
    assert.strictEqual(r2(att(5)), r2(row.breakdown?.hours?.total),
      `${ce.employee.full_name}: שעות בפועל — table ${row.breakdown?.hours?.total}, file ${att(5)}`);
    const daysPaid = att(4);
    const daysActual = att(7) || daysPaid;
    assert.strictEqual(r2(daysActual), r2(row.breakdown?.hours?.days_worked),
      `${ce.employee.full_name}: ימי עבודה בפועל — table ${row.breakdown?.hours?.days_worked}, file ${daysActual}`);
    assert.ok(daysPaid >= daysActual,
      `${ce.employee.full_name}: paid days (${daysPaid}) cannot be fewer than worked days (${daysActual})`);
  }
  ok('worked hours and worked days match the table exactly; paid days never undercount them');

  // ── 4. SILENCE IS NOT NEUTRAL ─────────────────────────────────────────────
  //
  // שקלולית keeps last month's value for a component missing from this month's
  // file. So "not entitled" has to be SAID, with a zero — not left out.
  console.log('6. a denied entitlement is stated, not left unsaid');
  {
    const ce = source.ready.find((x) => x.employee.full_name.includes('ללא ותק לחגים'));
    assert.ok(ce, 'the no-seniority employee must be in the export');
    assert.strictEqual(Number(ce.earnings.holiday_pay) || 0, 0, 'she is owed no דמי חגים');
    assert.ok((ce.employee_raw_ineligible || ce.flags.holiday_pay_denied) === true
      || ce.flags.holiday_pay_denied === true,
      'and the engine must record that it was ASKED and answered no');
    const zero = fileRows.find((x) => String(x[1]) === String(ce.employee.employee_number)
      && x[2] === RECORD.SALARY && x[3] === 44);
    assert.deepStrictEqual(zero?.slice(4), [0, 0],
      'code 44 must go out at 0 × 0 so last month\'s figure cannot be paid again');
  }
  ok('an employee with no holiday seniority is switched off explicitly, at 0 × 0');

  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\nAll payroll-chain reconciliation tests passed (${passed} checks).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
