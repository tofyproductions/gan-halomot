#!/usr/bin/env node
/**
 * A sick certificate that crosses a month boundary.
 *
 * The statutory brackets follow the SPELL: day 1 unpaid, days 2-3 at 50%,
 * day 4+ at 100%. A cert of 27.08–03.09 used to be August's alone — its
 * September days were never paid (while still draining the balance). Now each
 * month takes its own days and `prior_days` carries the bracket position, so
 * the spell's arithmetic comes out identical to the same spell inside one
 * month — just split across two payslips.
 *
 *   node scripts/sick-cross-month.test.js
 */
const { computeSickPay } = require('../src/services/sickPay');

let failures = 0;
const eq = (got, want, label) => {
  const good = Math.abs(got - want) < 1e-9;
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${got}, ציפינו ${want})`}`);
  if (!good) failures++;
};

const DAILY = 400;

console.log('\n🤒 the whole spell in one month — the baseline\n');
{
  // 7 work-days: 0 + 0.5 + 0.5 + 1 + 1 + 1 + 1 = 5 paid days.
  const r = computeSickPay([{ work_days: 7 }], { dailyValue: DAILY });
  eq(r.total_paid_days, 5, '7 ימי מחלה → 5 ימי תשלום');
  eq(r.total_amount, 5 * DAILY, 'הסכום בהתאם');
}

console.log('\n🤒 the same spell split across a month boundary\n');
{
  // August holds days 1-4 of the spell (0 + 0.5 + 0.5 + 1 = 2 paid),
  // September holds days 5-7 (1 + 1 + 1 = 3 paid). Together: the baseline 5.
  const aug = computeSickPay([{ work_days: 4, prior_days: 0 }], { dailyValue: DAILY });
  const sep = computeSickPay([{ work_days: 3, prior_days: 4 }], { dailyValue: DAILY });
  eq(aug.total_paid_days, 2, 'אוגוסט: ימים 1-4 → 2 ימי תשלום');
  eq(sep.total_paid_days, 3, 'ספטמבר: ימים 5-7 → 3 ימי תשלום (היו 0 לפני התיקון)');
  eq(aug.total_paid_days + sep.total_paid_days, 5, 'הפיצול = אותו סכום כמו רצף אחד');
}

console.log('\n🤒 bracket edge: the boundary cuts inside the 50% days\n');
{
  // Spell of 5; first month holds only day 1 (0 paid), second holds days 2-5
  // (0.5 + 0.5 + 1 + 1 = 3).
  const m1 = computeSickPay([{ work_days: 1, prior_days: 0 }], { dailyValue: DAILY });
  const m2 = computeSickPay([{ work_days: 4, prior_days: 1 }], { dailyValue: DAILY });
  eq(m1.total_paid_days, 0, 'חודש א: יום 1 בלבד — 0');
  eq(m2.total_paid_days, 3, 'חודש ב: ימים 2-5 — 3');
}

console.log('\n🤒 pay_from_first_day + balance cap keep working\n');
{
  const full = computeSickPay([{ work_days: 3, prior_days: 2, pay_from_first_day: true }], { dailyValue: DAILY });
  eq(full.total_paid_days, 3, 'תשלום מלא מהיום הראשון — כל יום 100% גם בפיצול');

  // Balance covers only 2 of the 3 second-month days (spell days 5,6 covered; 7 not).
  const capped = computeSickPay([{ work_days: 3, prior_days: 4 }], { dailyValue: DAILY, balanceAvailable: 2 });
  eq(capped.total_paid_days, 2, 'תקרת צבירה חלה על ימי החודש הזה בלבד');
  eq(capped.results[0].uncovered_days, 1, 'יום אחד לא מכוסה');
}

console.log('\n🤒 prior_days omitted — behaviour unchanged (regression)\n');
{
  const r = computeSickPay([{ work_days: 4 }], { dailyValue: DAILY });
  eq(r.total_paid_days, 2, 'בלי prior_days — כמו קודם');
}

console.log('');
if (failures) { console.log(`❌ ${failures} נכשלו`); process.exit(1); }
console.log('✅ הכל עבר');
