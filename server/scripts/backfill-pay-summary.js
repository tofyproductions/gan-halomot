#!/usr/bin/env node
/**
 * Fill PayrollMonth.pay_summary for months that already exist.
 *
 * An hourly employee's day of חופשה or מחלה is averaged over her last twelve
 * months. The summary those averages read is written when a month is SAVED, so
 * every month recorded before that code existed has none — and without this the
 * new rates would sit dormant until a year had passed.
 *
 * The figures are not re-derived by hand here: each month is recomputed through
 * fetchMonthData, the same path that produces the summary live. One source, one
 * arithmetic, no second implementation to drift.
 *
 *   node scripts/backfill-pay-summary.js                 # report only
 *   node scripts/backfill-pay-summary.js --write         # actually write
 *   node scripts/backfill-pay-summary.js --write --from 2025-09 --to 2026-08
 *
 * It is READ-ONLY without --write. Run it once and read the report before
 * letting it touch anything: it is filling the history that everybody's leave
 * pay will be averaged from.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const argOf = (name) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : null;
};

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI חסר — הריצו מול הסביבה הנכונה.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const { PayrollMonth, Employee } = require('../src/models');
  const ctrl = require('../src/controllers/payrollMonth.controller');
  const fetchMonthData = ctrl.__fetchMonthData || null;
  if (!fetchMonthData) {
    console.error('fetchMonthData לא נחשף מהקונטרולר — ראו את ההערה בתחתית הקובץ.');
    process.exit(1);
  }

  const months = (await PayrollMonth.distinct('month')).filter(Boolean).sort();
  const from = argOf('--from');
  const to = argOf('--to');
  const scope = months.filter((m) => (!from || m >= from) && (!to || m <= to));

  console.log(`חודשים במסד: ${months.length} · בטווח: ${scope.length}${WRITE ? '' : '  (הרצת בדיקה — לא נכתב כלום)'}`);
  if (scope.length === 0) { await mongoose.disconnect(); return; }

  // A system user with full visibility: the summary must not be truncated by
  // branch scoping, or a month would be filled for some employees and not
  // others and the average would silently differ between two people.
  const systemUser = { role: 'system_admin', _id: null };

  let written = 0;
  let skipped = 0;
  let unsaved = 0;
  const miluimGaps = [];
  const unsavedMonths = [];

  for (const month of scope) {
    let data;
    try {
      data = await fetchMonthData({ month, branch: 'all' }, systemUser);
    } catch (e) {
      console.log(`  ${month}  ✗ חישוב נכשל: ${e.message}`);
      continue;
    }
    const rows = data.rows || [];
    let monthWrote = 0;
    for (const r of rows) {
      const s = r.pay_summary;
      if (!s) { skipped += 1; continue; }

      // מילואים are paid as an amount and their DAY COUNT is not stored
      // anywhere in this system — so a month of reserve duty contributes its
      // money to the average and none of its days. That makes the daily value
      // too HIGH, which is the safe direction, but it is still wrong and it is
      // reported here by name rather than left to be discovered in a payslip.
      if (Number(r.manual?.miluim?.amount) > 0) {
        miluimGaps.push({ month, employee: r.full_name, amount: r.manual.miluim.amount });
      }

      // fetchMonthData answers for every employee on the payroll, whether or
      // not the month was ever SAVED. An update with no upsert matches nothing
      // for the unsaved ones — and counting the attempt rather than the effect
      // is how a run reported 467 records while writing 373. Count what the
      // database actually changed.
      const res = WRITE
        ? await PayrollMonth.updateOne(
          { employee_id: r.employee_id, month },
          { $set: { pay_summary: { ...s, recorded_at: new Date() } } },
        )
        : { matchedCount: await PayrollMonth.countDocuments({ employee_id: r.employee_id, month }) };

      if (!res.matchedCount) {
        // No PayrollMonth document: this month was never run for her. It is
        // therefore absent from her average — and when it carried real pay,
        // that is a month of her history going missing, so it is named.
        unsaved += 1;
        const paid = (Number(s.base_salary) || 0) + (Number(s.vacation_pay) || 0)
          + (Number(s.sick_pay) || 0) + (Number(s.miluim_pay) || 0) + (Number(s.holiday_pay) || 0);
        if (paid > 0) {
          unsavedMonths.push({
            month, employee: r.full_name,
            pay: Math.round(paid), days: Number(s.days_for_payslip) || 0,
          });
        }
        continue;
      }
      monthWrote += 1;
    }
    written += monthWrote;
    console.log(`  ${month}  ${String(monthWrote).padStart(3)} עובדים`);
  }

  console.log(`\n${WRITE ? 'נכתבו' : 'יכתבו'}: ${written} רשומות · ללא נתונים: ${skipped} · חודשים שלא נשמרו מעולם: ${unsaved}`);

  if (unsavedMonths.length) {
    console.log(`\n⚠️  ${unsavedMonths.length} חודשי־עובד עם תשלום אמיתי שאין להם רשומת שכר שמורה:`);
    for (const g of unsavedMonths.sort((x, y) => y.pay - x.pay).slice(0, 20)) {
      console.log(`    ${g.month}  ${g.employee}  ₪${g.pay}  ${g.days} ימים`);
    }
    if (unsavedMonths.length > 20) console.log(`    ...ועוד ${unsavedMonths.length - 20}`);
    console.log('    החודשים האלה אינם נכנסים לממוצע — לא ניתן לכתוב אליהם.');
    console.log('    כדי לכלול אותם צריך לפתוח את החודש בטבלת השכר ולשמור אותו.');
  }

  if (miluimGaps.length) {
    console.log(`\n⚠️  ${miluimGaps.length} חודשי־עובד עם תשלום מילואים וללא ספירת ימים:`);
    for (const g of miluimGaps.slice(0, 20)) {
      console.log(`    ${g.month}  ${g.employee}  ₪${g.amount}`);
    }
    if (miluimGaps.length > 20) console.log(`    ...ועוד ${miluimGaps.length - 20}`);
    console.log('    ימי המילואים אינם נשמרים במערכת, ולכן הם לא נספרים ב"ימים לתלוש".');
    console.log('    התוצאה: ערך יום החופשה יוצא גבוה מדי אצל העובדות האלה.');
  }

  if (!WRITE) console.log('\nלכתיבה בפועל: הוסיפו --write');
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('נכשל:', err.message);
  console.error(err.stack);
  process.exit(1);
});
