#!/usr/bin/env node
/**
 * "אישור הנה״ח: שלם גם ללא יתרת ימים" (עתי טדלה, 28.09.2026) — before this
 * fix, the flag changed only a note sentence on the accountant PDF. The
 * actual vacation_pay, estimated_total, and the שקלולית export all still
 * silently capped an hourly employee's paid days at her balance — so
 * approving payment "anyway" paid nothing extra anywhere. Confirmed with the
 * user: the flag must actually lift the cap for that one employee, one month.
 *
 *   node scripts/vacation-pay-override.test.js
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
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'vacation_pay_override_test' } });
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'x';
  process.env.DISABLE_JOBS = '1';

  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);

  const { Branch, Amuta, Employee, PayrollMonth } = require('../src/models');
  const { fetchMonthData } = require('../src/controllers/payrollMonth.controller');
  const { buildExportSource } = require('../src/services/payrollExport/sourceLayer');
  const shkulit = require('../src/services/payrollExport/shkulitAdapter');

  const branch = await Branch.create({ name: 'סניף בדיקה', address: 'כתובת' });
  const amuta = await Amuta.create({ name: 'עמותת בדיקה' });
  const month = '2026-09';

  const mkEmp = (name, idNum) => Employee.create({
    full_name: name, israeli_id: idNum, branch_id: branch._id,
    salary_type: 'hourly', hourly_rate: 60, is_active: true,
    start_date: new Date('2024-01-01'), work_days: [0, 1, 2, 3, 4],
    amuta_distribution: [{ amuta_id: amuta._id, hourly_rate: 60 }],
    // No accrual on file this month → available balance is 0.
    vacation_balance_opening: { days: 0, as_of_month: month },
    vacation_monthly_accrual: 0,
    bank_number: '10', bank_branch: '001', bank_account: '123456',
  });

  console.log('without the override, an hourly employee over her balance is paid 0 (existing behavior, unchanged)');
  {
    const emp = await mkEmp('עתי בדיקה (ללא אישור)', '111333555');
    await PayrollMonth.create({
      employee_id: emp._id, branch_id: branch._id, month,
      manual: { vacation_days: 5, vacation_pay_confirmed: false },
    });
    const data = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });
    const row = (data.rows || []).find(r => String(r.employee_id) === String(emp._id));
    assert.strictEqual(row.vacation_usage.capped, true, 'still capped without the override');
    assert.strictEqual(row.vacation_pay, 0, 'paid nothing beyond the (zero) balance');
    ok('capped at 0 — matches the balance, no override requested');

    // The DAY COUNT, not just the money — an hourly employee with 0 balance
    // who asked for 5 days must be shown/credited 0, not 5. Before this fix
    // vacation_eff_days was always the raw request, uncapped, for every
    // employee — the day count (and the balance it draws down) never
    // reflected the cap the money already respected.
    assert.strictEqual(row.vacation_eff_days, 0, 'the credited/shown day count is capped too, not just the ₪');
    assert.strictEqual(row.vacation_days_requested, 5, 'the raw request is preserved separately, for audit');
  }

  console.log('with the override, the same employee is paid in full — and it reaches estimated_total, the row, and the שקלולית export');
  {
    const emp = await mkEmp('עתי בדיקה (עם אישור)', '111333556');
    await PayrollMonth.create({
      employee_id: emp._id, branch_id: branch._id, month,
      manual: { vacation_days: 5, vacation_pay_confirmed: true, employee_number: '' },
    });
    await Employee.updateOne({ _id: emp._id }, { $set: { employee_number: '77' } });

    const data = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });
    const row = (data.rows || []).find(r => String(r.employee_id) === String(emp._id));

    assert.strictEqual(row.manual.vacation_pay_confirmed, true, 'the confirmed flag round-trips on row.manual (was missing entirely before this fix)');
    ok('manual.vacation_pay_confirmed is exposed on the row');

    assert.strictEqual(row.vacation_usage.capped, false, 'override lifts the cap');
    assert.strictEqual(row.vacation_usage.paid, 5, 'all 5 days now paid, not capped to the balance');
    assert.strictEqual(row.vacation_usage.override_applied, true);
    assert.strictEqual(row.vacation_eff_days, 5, 'the override lifts the shown/credited day count too, not just the ₪');
    ok('vacation_usage reflects the override: paid=5, capped=false');

    assert.ok(row.vacation_pay > 0, `vacation_pay must be nonzero, got ${row.vacation_pay}`);
    ok(`vacation_pay is nonzero (₪${row.vacation_pay}) — the approval actually pays, not just a PDF note`);

    // This fetch returns BOTH employees at once — the exact shape of the bug
    // report ("לכל העובדים נוצלו ימי החופשה באופן מלא"): confirm the OTHER,
    // unconfirmed employee from the block above is still correctly capped in
    // the SAME batch, not accidentally uncapped by sitting next to a
    // confirmed one.
    const otherRow = (data.rows || []).find(r => r.full_name === 'עתי בדיקה (ללא אישור)');
    assert.ok(otherRow, 'the unconfirmed employee from the earlier block must still be in this fetch');
    assert.strictEqual(otherRow.vacation_eff_days, 0, 'a DIFFERENT, unconfirmed employee stays capped in the same batch');
    assert.strictEqual(otherRow.vacation_pay, 0);
    ok('an unrelated, unconfirmed employee in the same fetch is unaffected by this one\'s override');

    // The שקלולית export must read the SAME override — not recompute its own
    // (uncapped) answer independently and disagree with the row.
    const source = buildExportSource(month, [row]);
    const ce = source.ready.find(x => x.employee.employee_number === '77');
    assert.ok(ce, 'the export employee must exist');
    assert.strictEqual(ce.quantities.vacation_days, 5, 'שקלולית quantity is uncapped too');
    assert.ok(ce.earnings.vacation_pay > 0, 'שקלולית money is uncapped too');
    ok('the שקלולית export layer reads the same override (via row.vacation_usage), not a second independent cap');

    const { rows: shkulitRows, notes } = shkulit.buildMovements(source);
    assert.ok(shkulitRows.some(r => r[3] === 8 && r[4] > 0), 'a nonzero vacation-pay row (code 8) must be filed');
    assert.ok(notes.some(n => n.subject === 'ימי חופשה — אישור הנה״ח'), 'the override note is filed under its own subject');
    ok('the shkulit file carries the paid amount AND a note explaining why the cap was lifted');

    // The accountant PDF (buildAccountantHtml) used to recompute vacation
    // usage a SECOND time, independently — from scratch, via its own
    // vacationUsageForMonth call — which both ignored this override AND fed
    // it the already-capped vacation_eff_days, re-capping an already-capped
    // number. Caught live: אתי טדלה's card showed "0" days used despite the
    // override, right next to a note saying accounting approved paying her
    // in full anyway — the two halves of the same card disagreeing.
    const { buildAccountantHtml } = require('../src/controllers/payrollMonth.controller');
    const html = buildAccountantHtml(month, [row]);
    assert.ok(html.includes('5 ימים'), 'the accountant PDF must show the overridden day count (5), not a re-capped 0');
    assert.ok(!/חופשה[^<]*>\s*0(?!\d)/.test(html.replace(/\s+/g, ' ')), 'the vacation cell must not read "0" for an overridden employee');
    ok('the accountant PDF shows the same overridden figure as the row and the שקלולית export — not a second, disagreeing recompute');
  }

  console.log('partial approval: pay beyond the balance only up to an approved day limit (01.10.2026)');
  {
    const emp = await Employee.create({
      full_name: 'עובדת בדיקה (אישור חלקי)', israeli_id: '111333558',
      branch_id: branch._id, salary_type: 'hourly', hourly_rate: 60, is_active: true,
      start_date: new Date('2024-01-01'), work_days: [0, 1, 2, 3, 4],
      amuta_distribution: [{ amuta_id: amuta._id, hourly_rate: 60 }],
      // 2 days in hand this month.
      vacation_balance_opening: { days: 2, as_of_month: month },
      vacation_monthly_accrual: 0,
      bank_number: '10', bank_branch: '001', bank_account: '444444',
      employee_number: '78',
    });
    await PayrollMonth.create({
      employee_id: emp._id, branch_id: branch._id, month,
      // Asked 7, holds 2, accounting approved paying up to 5.
      manual: { vacation_days: 7, vacation_pay_approved_days: 5 },
    });

    const data = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });
    const row = (data.rows || []).find(r => String(r.employee_id) === String(emp._id));

    assert.strictEqual(row.manual.vacation_pay_approved_days, 5, 'the limit round-trips on row.manual for the dialog');
    assert.strictEqual(row.vacation_usage.paid, 5, 'paid up to the approved limit, not the balance (2) and not the full request (7)');
    assert.strictEqual(row.vacation_usage.unpaid, 2, 'the 2 days past the limit stay unpaid');
    assert.strictEqual(row.vacation_usage.capped, true, 'still capped — the limit did not cover the whole request');
    assert.strictEqual(row.vacation_usage.override_applied, true);
    assert.strictEqual(row.vacation_usage.approved_days_limit, 5);
    assert.strictEqual(row.vacation_eff_days, 5, 'the credited/shown day count follows the limit');
    assert.strictEqual(row.vacation_days_requested, 7, 'the raw request is preserved for audit');
    ok('partial approval pays min(request, limit): 5 of 7, with 2 unpaid');

    // The שקלולית export reads the same partial figure and files its own note.
    const source = buildExportSource(month, [row]);
    const ce = source.ready.find(x => x.employee.employee_number === '78');
    assert.ok(ce, 'the export employee must exist');
    assert.strictEqual(ce.quantities.vacation_days, 5, 'שקלולית quantity follows the partial limit');
    const { notes } = shkulit.buildMovements(source);
    const note = notes.find(n => n.subject === 'ימי חופשה — אישור הנה״ח חלקי');
    assert.ok(note, 'the partial approval is filed under its own subject, not the full-approval one');
    assert.ok(!notes.some(n => n.subject === 'ימי חופשה — אישור הנה״ח' && n.employee_number === '78'),
      'the full-approval note ("שולמו במלואם") must NOT fire for a partial lift');
    ok('the שקלולית export files a partial-approval note and not the false "paid in full" one');

    // The accountant PDF names the limit instead of "מוגבל ליתרה".
    const { buildAccountantHtml } = require('../src/controllers/payrollMonth.controller');
    const html = buildAccountantHtml(month, [row]);
    assert.ok(html.includes('אישור הנה״ח חלקי'), 'the accountant PDF carries the partial-approval note');
    assert.ok(html.includes('אושר עד 5'), 'the vacation cell names the approved limit');
    ok('the accountant PDF explains the partial approval');
  }

  console.log('a limit below what the balance already covers is a no-op — it never reduces pay');
  {
    const emp = await Employee.create({
      full_name: 'עובדת בדיקה (מגבלה מתחת ליתרה)', israeli_id: '111333559',
      branch_id: branch._id, salary_type: 'hourly', hourly_rate: 60, is_active: true,
      start_date: new Date('2024-01-01'), work_days: [0, 1, 2, 3, 4],
      amuta_distribution: [{ amuta_id: amuta._id, hourly_rate: 60 }],
      vacation_balance_opening: { days: 3, as_of_month: month },
      vacation_monthly_accrual: 0,
      bank_number: '10', bank_branch: '001', bank_account: '555555',
    });
    await PayrollMonth.create({
      employee_id: emp._id, branch_id: branch._id, month,
      // Asked 7, holds 3, "approved" only 1 — the balance still pays its 3.
      manual: { vacation_days: 7, vacation_pay_approved_days: 1 },
    });
    const data = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });
    const row = (data.rows || []).find(r => String(r.employee_id) === String(emp._id));
    assert.strictEqual(row.vacation_usage.paid, 3, 'the balance-covered 3 days are paid regardless of the lower limit');
    assert.strictEqual(row.vacation_usage.capped, true);
    assert.strictEqual(row.vacation_usage.approved_days_limit ?? null, null, 'a no-op limit is not recorded on the row — the accountant card must not name it');
    ok('a limit under the covered days never cuts pay below what the balance covers');
  }

  console.log('no vacation_balance_opening on file — falls back to the payslip-imported balance instead of leaving the cap inert (שילו בגים, 29.09.2026)');
  {
    const emp = await Employee.create({
      full_name: 'עובדת בדיקה — יתרה מתלוש בלבד', israeli_id: '111333557',
      branch_id: branch._id, salary_type: 'hourly', hourly_rate: 60, is_active: true,
      start_date: new Date('2022-01-01'), work_days: [0, 1, 2, 3, 4],
      amuta_distribution: [{ amuta_id: amuta._id, hourly_rate: 60 }],
      bank_number: '10', bank_branch: '001', bank_account: '333333',
      // Deliberately NO vacation_balance_opening / vacation_monthly_accrual —
      // exactly שילו's real configuration.
    });
    await PayrollMonth.create({
      employee_id: emp._id, branch_id: branch._id, month,
      manual: { vacation_days: 5 },
      vacation_balance_from_payslip: 3,
      vacation_balance_recorded_at: new Date('2026-09-07'),
    });

    const data = await fetchMonthData({ month, branch: String(branch._id) }, { role: 'system_admin' });
    const row = (data.rows || []).find(r => String(r.employee_id) === String(emp._id));
    assert.ok(row, 'the row must exist');
    assert.strictEqual(row.vacation_usage.capped, true, 'the payslip balance (3) now caps the request (5), instead of the cap staying inert');
    assert.strictEqual(row.vacation_eff_days, 3, 'credited days = the payslip balance, not the full 5 requested');
    assert.strictEqual(row.vacation_days_requested, 5);
    assert.strictEqual(row.vacation_info.balance.available, 3, 'the dialog\'s own balance breakdown also reflects the payslip fallback');
    ok('an employee with no opening balance configured is capped by her payslip-imported balance instead of not being capped at all');
  }

  await mongoose.disconnect();
  await mongod.stop();

  console.log(`\nAll vacation-pay-override tests passed (${passed} checks).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
