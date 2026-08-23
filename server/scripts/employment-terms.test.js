#!/usr/bin/env node
/**
 * A raise must not reach backwards.
 *
 * The salary shown for a month is recomputed from the employee card on every
 * read, and the card carried one rate with no date on it. So raising somebody
 * from 52₪ to 60₪ raised every open month in the past to 60₪ too — the
 * payroll screen for February would quietly start showing a February that
 * never happened. Nothing in the UI admitted it, and the only months that
 * escaped were the ones already finalized.
 *
 * That is what this suite pins down: what August pays after a September raise.
 * Everything else here exists to keep that answer trustworthy — the baseline
 * row without which the fallback re-creates the bug, and the untouched
 * behaviour of every employee who has no recorded change at all.
 *
 * No database and no server: the calculator and the resolver are both pure
 * functions of an employee object.
 *
 *   node scripts/employment-terms.test.js
 */

const { calculateMonthlySalary } = require('../src/services/payrollCalc');
const {
  termsForMonth, termsFromCard, planTermsChange, applyTermsChange, monthOf, BASELINE_MONTH,
} = require('../src/services/employmentTerms');

let failures = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
};
const eq = (actual, expected, label) => {
  const good = actual === expected;
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${actual}, ציפינו ${expected})`}`);
  if (!good) failures++;
};

const AMUTA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BRANCH = 'bbbbbbbbbbbbbbbbbbbbbbbb';

/** An hourly employee on `rate`, with no dated history at all. */
const employee = (rate) => ({
  _id: 'e1',
  full_name: 'בדיקה',
  branch_id: BRANCH,
  salary_type: 'hourly',
  start_date: new Date('2024-01-01'),
  amuta_distribution: [{ amuta_id: AMUTA, hourly_rate: rate, global_salary: null, global_ot_rate: null, required_hours: null }],
  terms_history: [],
});

/** Eight clean hours on `day` (no overtime at 8h — that is the plain case). */
const workday = (day) => ([
  { _id: `${day}i`, timestamp: new Date(`${day}T05:00:00.000Z`), branch_id: BRANCH, approval_status: 'auto' },
  { _id: `${day}o`, timestamp: new Date(`${day}T13:00:00.000Z`), branch_id: BRANCH, approval_status: 'auto' },
]);

const monthPunches = (days) => days.flatMap(workday);

console.log('\n📅  חודש הוא היחידה — פתרון תנאים לפי חודש\n');
{
  const e = employee(52);
  e.terms_history = [
    { effective_month: BASELINE_MONTH, salary_type: 'hourly', hourly_rate: 52, source: 'baseline', created_at: new Date('2026-08-01') },
    { effective_month: '2026-09', salary_type: 'hourly', hourly_rate: 60, source: 'contract', created_at: new Date('2026-08-20') },
  ];
  eq(termsForMonth(e, '2026-08')?.hourly_rate, 52, 'אוגוסט מקבל את התעריף הישן');
  eq(termsForMonth(e, '2026-09')?.hourly_rate, 60, 'ספטמבר מקבל את התעריף החדש');
  eq(termsForMonth(e, '2026-12')?.hourly_rate, 60, 'דצמבר ממשיך עם החדש');
  ok(termsForMonth(employee(52), '2026-09') === null, 'עובד בלי היסטוריה — אין שורה, נופלים לכרטיס');
}

console.log('\n🔮  שינוי עתידי לא משפיע על ההווה\n');
{
  const e = employee(60);
  e.terms_history = [
    { effective_month: BASELINE_MONTH, salary_type: 'hourly', hourly_rate: 52, source: 'baseline', created_at: new Date('2026-08-01') },
    { effective_month: '2026-11', salary_type: 'hourly', hourly_rate: 60, source: 'contract', created_at: new Date('2026-08-20') },
  ];
  eq(termsForMonth(e, '2026-09')?.hourly_rate, 52, 'ספטמבר לא רואה העלאה שמתחילה בנובמבר');
  eq(termsForMonth(e, '2026-11')?.hourly_rate, 60, 'נובמבר כן');
}

console.log('\n🧾  תיקון של אותו חודש — האחרון שנרשם מנצח\n');
{
  const e = employee(58);
  e.terms_history = [
    { effective_month: '2026-09', salary_type: 'hourly', hourly_rate: 60, source: 'contract', created_at: new Date('2026-08-20T09:00:00Z') },
    { effective_month: '2026-09', salary_type: 'hourly', hourly_rate: 58, source: 'manual', created_at: new Date('2026-08-21T09:00:00Z') },
  ];
  eq(termsForMonth(e, '2026-09')?.hourly_rate, 58, 'הרישום המאוחר גובר');
}

console.log('\n💰  זה הבאג: העלאה מספטמבר לא משנה את אוגוסט\n');
{
  // 4 workdays × 8h. אוגוסט 52₪ → 1664. ספטמבר 60₪ → 1920.
  const aug = monthPunches(['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06']);
  const sep = monthPunches(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-06']);

  // המצב הישן: הכרטיס בלבד, אחרי שהעלינו ל-60.
  const legacy = employee(60);
  eq(calculateMonthlySalary(legacy, aug, '2026-08').components.base_salary, 1920,
    'בלי היסטוריה — אוגוסט נצבע בתעריף החדש (הבאג, משומר כאן בכוונה)');

  // אותו עובד, אותו כרטיס, אחרי שהשינוי נרשם עם תאריך.
  const dated = employee(60);
  dated.terms_history = [
    { effective_month: BASELINE_MONTH, salary_type: 'hourly', hourly_rate: 52, source: 'baseline', created_at: new Date('2026-08-20') },
    { effective_month: '2026-09', salary_type: 'hourly', hourly_rate: 60, source: 'contract', created_at: new Date('2026-08-20') },
  ];
  eq(calculateMonthlySalary(dated, aug, '2026-08').components.base_salary, 1664, 'אוגוסט חוזר לשלם 52 ₪');
  eq(calculateMonthlySalary(dated, sep, '2026-09').components.base_salary, 1920, 'ספטמבר משלם 60 ₪');
  eq(calculateMonthlySalary(dated, aug, '2026-08').rates.hourly_rate, 52, 'גם התעריף המוצג הוא של אותו חודש');
}

console.log('\n🔁  מעבר משעתי לתקן מתוארך גם הוא\n');
{
  const e = employee(52);
  e.salary_type = 'global';
  e.amuta_distribution = [{ amuta_id: AMUTA, hourly_rate: null, global_salary: 9000, global_ot_rate: null, required_hours: 182 }];
  e.terms_history = [
    { effective_month: BASELINE_MONTH, salary_type: 'hourly', hourly_rate: 52, source: 'baseline', created_at: new Date('2026-08-20') },
    { effective_month: '2026-09', salary_type: 'global', global_salary: 9000, required_hours: 182, source: 'contract', created_at: new Date('2026-08-20') },
  ];
  const aug = monthPunches(['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06']);
  const r = calculateMonthlySalary(e, aug, '2026-08');
  eq(r.salary_type, 'hourly', 'אוגוסט עדיין שעתי');
  eq(r.components.base_salary, 1664, 'ולכן משלם 32 שעות × 52 ₪');
}

console.log('\n🧱  השינוי הראשון כותב גם שורת בסיס\n');
{
  const e = employee(52);
  const plan = applyTermsChange(e, {
    effective_date: '2026-09-01', salary_type: 'hourly', hourly_rate: 60, note: 'חוזה חדש',
  }, { id: 'u1', full_name: 'הנהלת חשבונות' });

  eq(plan.errors.length, 0, 'השינוי תקין');
  eq(e.terms_history.length, 2, 'נכתבו שתי שורות — בסיס וחדשה');
  eq(e.terms_history[0].effective_month, BASELINE_MONTH, 'שורת הבסיס מתוארכת לפני כל שכר');
  eq(e.terms_history[0].hourly_rate, 52, 'ושומרת את התעריף הישן');
  eq(e.terms_history[0].source, 'baseline', 'ומסומנת כמצב התחלתי');
  eq(e.amuta_distribution[0].hourly_rate, 60, 'הכרטיס עודכן לתעריף החדש');
  eq(termsForMonth(e, '2026-08').hourly_rate, 52, 'ואוגוסט עדיין מוצא 52 ₪ — בלי שורת הבסיס היה מוצא 60');

  // שינוי שני — לא נכתבת שורת בסיס נוספת.
  applyTermsChange(e, { effective_date: '2027-01-01', salary_type: 'hourly', hourly_rate: 65 }, {});
  eq(e.terms_history.length, 3, 'השינוי השני מוסיף שורה אחת בלבד');
  eq(termsForMonth(e, '2026-09').hourly_rate, 60, 'ספטמבר לא זז');
  eq(termsForMonth(e, '2027-02').hourly_rate, 65, 'פברואר הבא מקבל את החדש');
}

console.log('\n📆  תאריך באמצע חודש מזיז את כל החודש, ונאמר מראש\n');
{
  const plan = planTermsChange(employee(52), {
    effective_date: '2026-09-15', salary_type: 'hourly', hourly_rate: 60,
  });
  eq(plan.effective_month, '2026-09', 'התאריך מתורגם לחודש');
  ok(plan.mid_month === true, 'ומסומן כאמצע חודש כדי שהמסך יזהיר');
  eq(plan.previous.hourly_rate, 52, 'ההשוואה מציגה את התעריף הקודם');
  eq(plan.next.hourly_rate, 60, 'ואת החדש');
}

console.log('\n🚧  קלט לא תקין נדחה לפני שנוגעים בכרטיס\n');
{
  const noRate = planTermsChange(employee(52), { effective_date: '2026-09-01', salary_type: 'hourly', hourly_rate: '' });
  ok(noRate.errors.length > 0, 'שעתי בלי תעריף נדחה');

  const noHours = planTermsChange(employee(52), { effective_date: '2026-09-01', salary_type: 'global', global_salary: 9000 });
  ok(noHours.errors.length > 0, 'תקן בלי שעות מחויבות נדחה');

  const noDate = planTermsChange(employee(52), { salary_type: 'hourly', hourly_rate: 60 });
  ok(noDate.errors.length > 0, 'בלי תאריך נדחה');

  const e = employee(52);
  const same = applyTermsChange(e, { effective_date: '2026-09-01', salary_type: 'hourly', hourly_rate: 52 }, {});
  ok(same.nothingChanged === true, 'תנאים זהים מסומנים כ״אין מה לעדכן״');

  const noAmuta = { ...employee(52), amuta_distribution: [], terms_history: [] };
  const res = applyTermsChange(noAmuta, { effective_date: '2026-09-01', salary_type: 'hourly', hourly_rate: 60 }, {});
  ok(res.errors.length > 0, 'כרטיס בלי עמותה נדחה במקום להמציא אחת');
}

console.log('\n🌍  החודש נגזר לפי שעון ישראל\n');
{
  // 31.08 בשעה 23:00 בישראל הוא 20:00 UTC — חישוב לפי UTC היה מחזיר אוגוסט,
  // וזה נכון; אבל 01.09 ב-00:30 בישראל הוא 31.08 21:30 UTC, ושם ההבדל נשבר.
  eq(monthOf(new Date('2026-08-31T21:30:00.000Z')), '2026-09', 'חצות בישראל כבר ספטמבר');
  eq(monthOf(new Date('2026-09-01T10:00:00.000Z')), '2026-09', 'אמצע היום — ספטמבר');
}

console.log('\n🗂️  קריאת הכרטיס לא השתנתה למי שאין לו היסטוריה\n');
{
  const e = employee(52);
  const card = termsFromCard(e);
  eq(card.hourly_rate, 52, 'התעריף נקרא מהפיצול הראשון');
  eq(card.salary_type, 'hourly', 'וסוג השכר מהכרטיס');
  const sep = monthPunches(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-06']);
  eq(calculateMonthlySalary(e, sep, '2026-09').components.base_salary, 1664, 'והשכר מחושב בדיוק כמו קודם');
}

console.log(`\n${failures ? `❌  ${failures} בדיקות נכשלו\n` : '✅  הכל עבר\n'}`);
process.exit(failures ? 1 : 0);
