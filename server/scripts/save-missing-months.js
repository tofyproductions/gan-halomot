#!/usr/bin/env node
/**
 * Create the payroll rows for months that were WORKED but never saved.
 *
 * fetchMonthData answers for every employee on the payroll, computing the
 * month from her punches whether or not anybody ever opened it in the salary
 * table and saved it. A month with no PayrollMonth document is therefore not
 * an empty month — it is a month nobody wrote down. It has no pay_summary,
 * and so it is invisible to the twelve-month average that prices an hourly
 * employee's day of חופשה and מחלה.
 *
 * שרון ודש worked May, June and July 2026 — 63 days, ₪30,882 — and none of
 * the three was saved. Her vacation day came out 173.15 instead of 380.08:
 * less than half of what she is owed.
 *
 *   ⚠️  NOT every unsaved month is a month of work. 26 of them carry one or
 *   two days and a few hundred shekels — stray punches, not employment.
 *   Adding those DESTROYS the average instead of completing it: אדולה מהרט
 *   falls from 119.56 a day to 50.14, against the ₪119 her own accountant
 *   calculated by hand. That is the whole reason this script has a threshold
 *   and prints both sides of it.
 *
 * The rule: a month qualifies when it was PAID and carries at least
 * MIN_DAYS days. Everything else is listed as rejected, by name, so the
 * judgement is visible rather than buried.
 *
 * The row created is exactly what saving the month in the salary table
 * creates — branch_id, employee_id, month, status 'draft'. Nothing else is
 * invented: the figures are recomputed from the punches, as always.
 *
 *   node scripts/save-missing-months.js                  # report only
 *   node scripts/save-missing-months.js --write          # actually create
 *   node scripts/save-missing-months.js --min-days 5     # stricter threshold
 *
 * It is READ-ONLY without --write, and it never touches a month that already
 * has a row.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i > -1 && args[i + 1] != null ? args[i + 1] : fallback;
};
const MIN_DAYS = Number(argOf('--min-days', 3));

const nis = (n) => '₪' + Math.round(n).toLocaleString('en-US');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI חסר — הריצו מול הסביבה הנכונה.');
    process.exit(1);
  }
  if (!Number.isFinite(MIN_DAYS) || MIN_DAYS < 1) {
    console.error('--min-days חייב להיות מספר חיובי.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const { PayrollMonth, Employee } = require('../src/models');
  const ctrl = require('../src/controllers/payrollMonth.controller');
  const H = require('../src/services/hourlyDayRates');
  const fetchMonthData = ctrl.__fetchMonthData;
  if (!fetchMonthData) {
    console.error('fetchMonthData לא נחשף מהקונטרולר.');
    process.exit(1);
  }

  const months = (await PayrollMonth.distinct('month')).filter(Boolean).sort();
  // A system user with full visibility: a month filled for some branches and
  // not others would leave the average differing between two people.
  const systemUser = { role: 'system_admin', _id: null };

  const stored = new Set();
  for (const d of await PayrollMonth.find({ month: { $in: months } })
    .select('employee_id month').lean()) {
    stored.add(String(d.employee_id) + '|' + d.month);
  }

  // Every computed employee-month, saved or not — this is also what the
  // before/after rates are read from.
  const byEmployee = new Map();
  for (const month of months) {
    let data;
    try {
      data = await fetchMonthData({ month, branch: 'all' }, systemUser);
    } catch (e) {
      console.log(`  ${month}  ✗ חישוב נכשל: ${e.message}`);
      continue;
    }
    for (const r of (data.rows || [])) {
      if (!r.pay_summary) continue;
      const id = String(r.employee_id);
      if (!byEmployee.has(id)) {
        byEmployee.set(id, {
          name: r.full_name, number: r.employee_number,
          salary_type: r.salary_type, branch_id: r.branch_id, months: {},
        });
      }
      byEmployee.get(id).months[month] = r.pay_summary;
    }
  }

  const paidOf = (s) => (Number(s.base_salary) || 0) + (Number(s.vacation_pay) || 0)
    + (Number(s.sick_pay) || 0) + (Number(s.miluim_pay) || 0) + (Number(s.holiday_pay) || 0);

  const take = [];
  const leave = [];
  for (const [id, e] of byEmployee) {
    for (const [month, s] of Object.entries(e.months)) {
      if (stored.has(id + '|' + month)) continue;
      const pay = paidOf(s);
      if (pay <= 0) continue; // an unpaid month is nothing to record
      const days = Number(s.days_for_payslip) || 0;
      const item = { id, month, name: e.name, number: e.number, pay, days, branch_id: e.branch_id };
      (days >= MIN_DAYS ? take : leave).push(item);
    }
  }
  take.sort((a, b) => b.pay - a.pay);
  leave.sort((a, b) => b.pay - a.pay);

  console.log(`חודשים במסד: ${months.length} · סף: ${MIN_DAYS} ימים`
    + `${WRITE ? '' : '  (הרצת בדיקה — לא נכתב כלום)'}\n`);

  console.log(`✅ ${take.length} חודשי עבודה שייווצרו · ${nis(take.reduce((a, b) => a + b.pay, 0))}`);
  for (const t of take) {
    console.log(`    ${t.month}  ${t.name}  ${nis(t.pay)}  ${t.days} ימים`);
  }

  console.log(`\n⏭️  ${leave.length} חודשים שיישארו בחוץ (פחות מ-${MIN_DAYS} ימים)`
    + ` · ${nis(leave.reduce((a, b) => a + b.pay, 0))}`);
  for (const l of leave.slice(0, 12)) {
    console.log(`    ${l.month}  ${l.name}  ${nis(l.pay)}  ${l.days} ימים`);
  }
  if (leave.length > 12) console.log(`    ...ועוד ${leave.length - 12}`);
  console.log('    אלה החתמות בודדות ולא חודשי העסקה. הוספתן מורידה את הממוצע');
  console.log('    במקום להשלים אותו — ראו את ההערה בראש הקובץ.');

  // What this actually does to people's money, before anything is written.
  const nextMonth = months.length
    ? (() => {
      const [y, m] = months[months.length - 1].split('-').map(Number);
      const d = new Date(Date.UTC(y, m, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    })()
    : null;
  const win = nextMonth ? H.lookbackMonths(nextMonth) : [];
  const taking = new Set(take.map((t) => t.id + '|' + t.month));
  const moved = [];
  for (const [id, e] of byEmployee) {
    if (e.salary_type === 'global') continue; // a תקן day is not averaged
    const rowsFor = (withNew) => Object.entries(e.months)
      .filter(([m]) => win.includes(m))
      .filter(([m]) => stored.has(id + '|' + m) || (withNew && taking.has(id + '|' + m)))
      .map(([m, s]) => ({ month: m, ...s }));
    const before = H.dayRatesFrom(rowsFor(false));
    const after = H.dayRatesFrom(rowsFor(true));
    if (!after || rowsFor(true).length === rowsFor(false).length) continue;
    moved.push({
      name: e.name, number: e.number,
      vBefore: before ? before.vacation_day : null, vAfter: after.vacation_day,
      sBefore: before ? before.sick_day : null, sAfter: after.sick_day,
      mBefore: before ? before.months : 0, mAfter: after.months,
    });
  }
  moved.sort((a, b) => Math.abs(b.vAfter - (b.vBefore || 0)) - Math.abs(a.vAfter - (a.vBefore || 0)));

  if (moved.length) {
    console.log(`\n📊 תעריפים שיזוזו (חלון ${nextMonth}) — ${moved.length} עובדות:`);
    for (const m of moved) {
      const arrow = (b, a) => `${b == null ? '—' : b} → ${a}`;
      console.log(`    ${m.name}  חודשים ${m.mBefore}→${m.mAfter}`
        + `  ·  יום חופשה ${arrow(m.vBefore, m.vAfter)}`
        + `  ·  יום מחלה ${arrow(m.sBefore, m.sAfter)}`);
    }
  }

  if (!WRITE) {
    console.log('\nליצירה בפועל: הוסיפו --write');
    await mongoose.disconnect();
    return;
  }

  let created = 0;
  let failed = 0;
  for (const t of take) {
    // branch_id is required by the schema, and the employee is where it lives
    // — the same field upsertEntry copies onto a row it inserts.
    let branchId = t.branch_id;
    if (!branchId) {
      const emp = await Employee.findById(t.id).select('branch_id').lean();
      branchId = emp && emp.branch_id;
    }
    if (!branchId) {
      console.log(`    ✗ ${t.month}  ${t.name} — אין סניף לעובדת, דילוג`);
      failed += 1;
      continue;
    }
    const s = byEmployee.get(t.id).months[t.month];
    try {
      await PayrollMonth.updateOne(
        { employee_id: t.id, month: t.month },
        {
          $set: { pay_summary: { ...s, recorded_at: new Date() } },
          $setOnInsert: { branch_id: branchId, employee_id: t.id, month: t.month },
        },
        { upsert: true },
      );
      created += 1;
    } catch (e) {
      console.log(`    ✗ ${t.month}  ${t.name} — ${e.message}`);
      failed += 1;
    }
  }
  console.log(`\nנוצרו: ${created} רשומות${failed ? ` · נכשלו: ${failed}` : ''}`);
  console.log('התעריפים מתעדכנים מיד — אין צורך להריץ את הבקפיל שוב.');

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('נכשל:', err.message);
  console.error(err.stack);
  process.exit(1);
});
