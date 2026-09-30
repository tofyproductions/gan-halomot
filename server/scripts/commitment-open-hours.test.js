#!/usr/bin/env node
/**
 * The commitment total, and how much of it fell on days the gan was open.
 *
 * committed_hours counts every committed weekday on the calendar, holidays
 * included. That is right for pricing — a monthly salary pays for חגים, and
 * dividing it by open days only would nearly double the hourly value in any
 * holiday month — and wrong as a reading of "the hours she was expected to
 * work". Asked on 30.09.2026: the card said התחייבות 198 for אפרת משעלי, who
 * worked 123.6, and 79 of those 198 were ראש השנה, כיפור and סוכות.
 *
 * Pinned here:
 *   1. hours_by_date adds up to committed_hours exactly, so a split taken from
 *      it cannot drift from the total.
 *   2. The card shows "מתוכן X בימים פתוחים" in a month with closures, and
 *      says nothing extra in a month without — a second number that always
 *      equals the first is noise.
 *
 *   node scripts/commitment-open-hours.test.js
 */
const { analyzeCommitment } = require('../src/services/commitmentAnalysis');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

// אפרת משעלי's actual schedule: Sun–Wed 07:00–17:00, Thu off, Fri 07:30–12:00.
const schedule = {
  days: [
    { day: 0, is_off: false, start_hhmm: '07:00', end_hhmm: '17:00' },
    { day: 1, is_off: false, start_hhmm: '07:00', end_hhmm: '17:00' },
    { day: 2, is_off: false, start_hhmm: '07:00', end_hhmm: '17:00' },
    { day: 3, is_off: false, start_hhmm: '07:00', end_hhmm: '17:00' },
    { day: 4, is_off: true, start_hhmm: '', end_hhmm: '' },
    { day: 5, is_off: false, start_hhmm: '07:30', end_hhmm: '12:00' },
  ],
};

console.log('\n📅  שעות לפי תאריך\n');
{
  const a = analyzeCommitment(schedule, [], '2026-09');
  const sum = Object.values(a.hours_by_date).reduce((s, h) => s + h, 0);
  eq(a.committed_hours, 198, 'ספטמבר: 198 שעות התחייבות');
  eq(a.committed_weighted_hours, 207, 'ו-207 משוקללות');
  eq(sum, a.committed_hours, 'hours_by_date מסתכם בדיוק לסה״כ');
  eq(Object.keys(a.hours_by_date).length, a.committed_dates.length, 'שורה לכל יום התחייבות');
  eq(a.hours_by_date['2026-09-13'], 10, 'יום א׳ ארוך — 10 שעות');
  eq(a.hours_by_date['2026-09-11'], 4.5, 'יום ו׳ — 4.5 שעות');
  ok(!('2026-09-10' in a.hours_by_date), 'יום ה׳ (חופש) לא נכנס');
  ok(!('2026-09-12' in a.hours_by_date), 'שבת לא נכנסת');

  // The split getMonth takes: the branch's September closures.
  const closures = new Set(['2026-09-11', '2026-09-13', '2026-09-20', '2026-09-21',
    '2026-09-25', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']);
  const closureHours = a.committed_dates.filter(d => closures.has(d))
    .reduce((s, d) => s + a.hours_by_date[d], 0);
  eq(closureHours, 79, 'ראש השנה + כיפור + סוכות = 79 שעות');
  eq(a.committed_hours - closureHours, 119, 'נשארות 119 שעות בימים שהגן פתוח');
}

console.log('\n🚫  בלי התחייבות\n');
{
  const a = analyzeCommitment(null, [], '2026-09');
  eq(a.hours_by_date, {}, 'מפה ריקה, לא undefined');
}

console.log('\n🧾  הכרטיס\n');
{
  process.env.DISABLE_JOBS = '1';
  const { buildAccountantHtml } = require('../src/controllers/payrollMonth.controller');
  const base = (commitment) => ({
    full_name: 'אפרת', salary_type: 'global', is_active: true, branch_id: 'b',
    breakdown: { rates: { global_salary: 9000 }, hours: { total: 123.6 }, deductions: {},
      components: { teken_breakdown: { teken_salary: 9000, required_hours: 198, hourly_value: 43.48, regular_pay: 4539 } } },
    commitment, manual: {},
  });
  const text = (row) => buildAccountantHtml('2026-09', [row], new Map()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  const holidayMonth = text(base({ committed_hours: 198, closure_hours: 79, open_hours: 119 }));
  ok(holidayMonth.includes('התחייבות: 198 ש׳'), 'חודש חגים: הסה״כ נשאר');
  ok(holidayMonth.includes('מתוכן 119 בימים פתוחים'), 'ולידו — כמה מהן בימים שהגן פתוח');

  const plainMonth = text(base({ committed_hours: 198, closure_hours: 0, open_hours: 198 }));
  ok(plainMonth.includes('התחייבות: 198 ש׳'), 'חודש בלי חגים: הסה״כ');
  ok(!plainMonth.includes('בימים פתוחים'), 'ובלי שורה שנייה שחוזרת על אותו מספר');

  const oldRow = text(base(null));
  ok(!oldRow.includes('בימים פתוחים'), 'שורה ישנה בלי commitment לא נשברת');
}

console.log(failures ? `\n❌  ${failures} כשלונות\n` : '\n✅  הכל עבר\n');
process.exit(failures ? 1 : 0);
