#!/usr/bin/env node
/**
 * The contracted week, on the page the employee signs.
 *
 * The contract could describe exactly one shape of week: "ראשון עד חמישי" from
 * X to Y, plus a line for Friday. Two pairs of fields, and no way to say that
 * אונלי is off on Wednesdays or that one day mid-week is short. A manager whose
 * employee has either of those could issue a contract that was wrong, or not
 * issue one.
 *
 * Underneath, the six-row table was already being printed — from
 * `fixed_schedule`, which is the arrangement for staff who do NOT clock in. So
 * for everybody who punches a card it printed six blank rows, while the real
 * schedule sat one field over in EmployeeCommitment: the thing attendance,
 * sick days and paid vacation are already counted against.
 *
 * What is checked here:
 *   • the sentence is written FROM the table, so the two cannot disagree
 *   • a day off is named, not left blank — blank reads as "nobody filled it in"
 *   • a short day survives instead of being averaged into the group
 *   • the commitment wins over fixed_schedule, and work_days seeds the grid
 *   • contracts written before any of this still render as they did
 *
 *   node scripts/contract-weekly-hours.test.js
 */

const tpl = require('../src/services/employmentContract');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

/** The hours clause only — the whole contract is 40kb of unrelated text. */
function hoursClause(overrides = {}) {
  const employee = { full_name: 'אונלי מור', position: 'מטפלת', amuta_distribution: [] };
  const ctx = tpl.buildContext(employee, { branch: { name: 'משה דיין' }, overrides });
  const html = tpl.render(ctx);
  const start = html.indexOf('העובדת מודעת לכך כי שעות העבודה');
  const end = html.indexOf('העובדת מתבקשת להגיע בזמן');
  return html.slice(start, end);
}

const day = (weekday, inH, outH) => ({ weekday, off: false, in: inH, out: outH, note: '' });
const off = (weekday) => ({ weekday, off: true, in: '', out: '', note: '' });

console.log('\n📄 שעות העבודה בחוזה\n');

// ---------------------------------------------------------------------------
console.log('אונלי — רביעי חופש');
{
  const clause = hoursClause({
    weekly_hours: [day(0, '07:00', '16:00'), day(1, '07:00', '16:00'), off(3),
      day(2, '07:00', '16:00'), day(4, '07:00', '16:00')],
  });
  ok(clause.includes('בימים ראשון, שני, שלישי וחמישי'),
    'ארבעת ימי העבודה מקובצים למשפט אחד, בלי רביעי');
  ok(!/ראשון עד חמישי/.test(clause),
    'המשפט הישן "ראשון עד חמישי" לא מופיע — הוא היה סותר את הטבלה');
  ok(clause.includes('יום החופש השבועי של העובדת: רביעי'),
    'יום החופש נכתב במפורש בגוף החוזה');
  ok(clause.includes('<td>רביעי</td><td colspan="2">יום חופש שבועי</td>'),
    'ובטבלה רביעי כתוב כיום חופש, לא ריק');
}

// ---------------------------------------------------------------------------
console.log('\nיום קצר באמצע השבוע');
{
  const clause = hoursClause({
    weekly_hours: [day(0, '07:00', '16:00'), day(1, '07:00', '16:00'),
      day(2, '07:00', '13:00'), day(3, '07:00', '16:00'), day(4, '07:00', '16:00')],
  });
  ok(/בימים ראשון, שני, רביעי וחמישי, החל מהשעה <span class="filled">07:00<\/span> ועד השעה <span class="filled">16:00<\/span>/.test(clause),
    'ארבעת הימים הרגילים בשורה אחת');
  ok(/ביום שלישי, החל מהשעה <span class="filled">07:00<\/span> ועד השעה <span class="filled">13:00<\/span>/.test(clause),
    'והיום הקצר בשורה משלו, ביחיד');
}

// ---------------------------------------------------------------------------
console.log('\nשני ימי חופש');
{
  const clause = hoursClause({
    weekly_hours: [day(0, '07:00', '16:00'), day(1, '07:00', '16:00'),
      day(2, '07:00', '16:00'), off(3), off(5)],
  });
  ok(clause.includes('ימי החופש השבועיים של העובדת: רביעי ושישי'),
    'ברבים, ועם ו״ו החיבור לפני האחרון');
}

// ---------------------------------------------------------------------------
console.log('\nחוזה שנכתב לפני שהטבלה קיימת');
{
  const clause = hoursClause({
    weekly_hours: [],
    weekday_start: '07:30', weekday_end: '16:30',
    friday_start: '07:30', friday_end: '13:00',
  });
  ok(/בימים ראשון עד חמישי, החל מהשעה <span class="filled">07:30<\/span>/.test(clause),
    'הנוסח הישן נשמר — טיוטה ישנה לא משנה את מה שכתוב בה');
  ok(/בימי שישי, החל מהשעה <span class="filled">07:30<\/span>/.test(clause),
    'כולל שורת שישי');
}

// ---------------------------------------------------------------------------
console.log('\nמאיפה מגיעים הימים');
{
  const employee = {
    full_name: 'אונלי מור',
    work_days: [0, 1, 2, 4],
    fixed_schedule: { days: [{ weekday: 0, in: '08:00', out: '15:00' }] },
    amuta_distribution: [],
  };
  const commitment = {
    days: [
      { day: 0, is_off: false, start_hhmm: '07:00', end_hhmm: '16:00' },
      { day: 3, is_off: true, start_hhmm: '', end_hhmm: '' },
    ],
  };

  const withCommitment = tpl.buildContext(employee, { branch: null, commitment });
  eq(withCommitment.weekly_hours, [
    { weekday: 0, off: false, in: '07:00', out: '16:00', note: '' },
    { weekday: 3, off: true, in: '', out: '', note: '' },
  ], 'ההתחייבות גוברת על משרה קבועה — שם יושב הלו״ז האמיתי');

  const noCommitment = tpl.buildContext(employee, { branch: null });
  eq(noCommitment.weekly_hours,
    [{ weekday: 0, off: false, in: '08:00', out: '15:00', note: '' }],
    'בלי התחייבות — נופלים למשרה קבועה, כמו קודם');

  const bare = tpl.buildContext(
    { full_name: 'עובדת חדשה', work_days: [0, 1, 2, 4], amuta_distribution: [] },
    { branch: null },
  );
  eq(bare.weekly_hours.filter(r => !r.off).map(r => r.weekday), [0, 1, 2, 4],
    'ובלי שניהם — הרשת נפתחת לפי ימי העבודה של העובדת');
  eq(bare.weekly_hours.filter(r => r.off).map(r => r.weekday), [3, 5],
    'והשאר מסומנים כחופש');
}

console.log(`\n${failures === 0 ? '✅ הכל עבר' : `❌ ${failures} נכשלו`}\n`);
process.exit(failures === 0 ? 0 : 1);
