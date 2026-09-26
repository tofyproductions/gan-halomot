#!/usr/bin/env node
/**
 * When a loan stops deducting.
 *
 * Legacy loans (no payments[] schedule) ran on `installments_paid <
 * installments_total` — but nothing in the system ever increments
 * installments_paid, so a 10-installment loan deducted in month 11, 12, 13…
 * forever, and also in months BEFORE its start_month. The rule is now
 * calendar-bounded whenever start_month exists: deduct only inside
 * [start, start + total). Scheduled loans and merged loans are asserted
 * unchanged.
 *
 *   node scripts/loan-deduction.test.js
 */
const { loanDeductionForMonth } = require('../src/services/payrollCalc');

let failures = 0;
const eq = (got, want, label) => {
  const good = got === want;
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${got}, ציפינו ${want})`}`);
  if (!good) failures++;
};

console.log('\n💸 legacy loan, start_month known — the calendar bounds it\n');
const legacy = {
  total_amount: 5000, installment_amount: 500,
  installments_total: 10, installments_paid: 0,
  start_month: '2026-01', payments: [],
};
eq(loanDeductionForMonth(legacy, '2025-12'), 0, 'לפני תחילת ההלוואה — 0');
eq(loanDeductionForMonth(legacy, '2026-01'), 500, 'חודש ראשון — מנכה');
eq(loanDeductionForMonth(legacy, '2026-10'), 500, 'חודש עשירי (אחרון) — מנכה');
eq(loanDeductionForMonth(legacy, '2026-11'), 0, 'חודש 11 — נעצר (הבאג: ניכוי לנצח)');
eq(loanDeductionForMonth(legacy, '2027-06'), 0, 'חצי שנה אחרי — עדיין 0');
// Cross-year window arithmetic.
const crossYear = { ...legacy, start_month: '2026-09', installments_total: 6 };
eq(loanDeductionForMonth(crossYear, '2027-02'), 500, 'חוצה שנה: חודש 6 — מנכה');
eq(loanDeductionForMonth(crossYear, '2027-03'), 0, 'חוצה שנה: חודש 7 — נעצר');

console.log('\n💸 legacy loan, no start_month — old rule remains (nothing better to do)\n');
const noStart = { ...legacy, start_month: '' };
eq(loanDeductionForMonth(noStart, '2030-01'), 500, 'בלי תאריך התחלה — הכלל הישן');
eq(loanDeductionForMonth({ ...noStart, installments_paid: 10 }, '2030-01'), 0,
  'מונה ידני שהושלם — 0');

console.log('\n💸 scheduled + merged loans — untouched\n');
const scheduled = {
  ...legacy,
  payments: [{ month: '2026-03', amount: 700 }, { month: '2026-04', amount: 0 }],
};
eq(loanDeductionForMonth(scheduled, '2026-03'), 700, 'לוח תשלומים — הסכום המתוזמן');
eq(loanDeductionForMonth(scheduled, '2026-04'), 0, 'חודש מושהה — 0');
eq(loanDeductionForMonth(scheduled, '2026-05'), 0, 'חודש שלא בלוח — 0');
eq(loanDeductionForMonth({ ...legacy, merged_at_month: '2026-05' }, '2026-06'), 0,
  'הלוואה שאוחדה — 0 מחודש האיחוד');
eq(loanDeductionForMonth({ ...legacy, merged_at_month: '2026-05' }, '2026-04'), 500,
  '…אבל עוד מנכה לפני האיחוד');

console.log('');
if (failures) { console.log(`❌ ${failures} נכשלו`); process.exit(1); }
console.log('✅ הכל עבר');
