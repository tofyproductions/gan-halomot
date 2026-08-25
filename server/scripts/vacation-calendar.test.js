#!/usr/bin/env node
/**
 * The year's calendar, and what each kind of day costs.
 *
 * The list a parent reads is one list. What it costs a member of staff is not,
 * and that is the whole reason this file exists:
 *
 *   closure   → a vacation day comes out of her balance
 *   employer  → the gan is shut because WE shut it; nothing comes out
 *   short_day → the gan RAN and finished early; she was there, she is paid for
 *               the hours she punched, and nothing comes out
 *
 * Filed as one kind when it is another, a member of staff pays a vacation day
 * for a day she worked — silently, and only visible a year later when her
 * balance is short. So the classification of all twelve published rows is
 * pinned here by name, and the calculator is run against each kind.
 *
 *   node scripts/vacation-calendar.test.js
 */

const { CALENDAR_5787, YEAR_5787, toDocument, statusOn } = require('../src/services/vacationCalendar');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const weekday = (ymd) => DAYS[new Date(`${ymd}T12:00:00.000Z`).getUTCDay()];
const byKey = (k) => CALENDAR_5787.find((e) => e.key === k);

console.log('\n🗂️  כל יום מסווג נכון — וזה מה שקובע אם יורד יום חופש\n');
{
  const expected = {
    'rosh-hashana': 'closure', 'yom-kippur': 'closure', 'sukkot': 'closure',
    'hanukkah': 'closure', 'purim': 'closure', 'pesach': 'closure',
    'yom-haatzmaut': 'closure', 'shavuot': 'closure',
    'family-day': 'employer', 'graduation': 'employer', 'staff-bonding-fri': 'employer',
    'yom-hazikaron': 'short_day', 'staff-bonding-thu': 'short_day',
  };
  for (const [key, kind] of Object.entries(expected)) {
    const e = byKey(key);
    eq(e?.kind, kind, `${e?.name || key} — ${kind}`);
  }
  eq(CALENDAR_5787.length, Object.keys(expected).length, 'ואין שורות עודפות או חסרות');
}

console.log('\n📅  התאריכים נופלים על ימי השבוע שפורסמו\n');
{
  const published = {
    'rosh-hashana': ['שישי', 'ראשון'], 'yom-kippur': ['ראשון', 'שני'],
    'sukkot': ['שישי', 'שבת'], 'hanukkah': ['חמישי', 'שישי'],
    'family-day': ['שישי', 'שישי'], 'purim': ['שלישי', 'שלישי'],
    'pesach': ['שני', 'רביעי'], 'yom-hazikaron': ['שלישי', 'שלישי'],
    'yom-haatzmaut': ['רביעי', 'רביעי'], 'shavuot': ['חמישי', 'שישי'],
    'graduation': ['שישי', 'שישי'],
    'staff-bonding-thu': ['חמישי', 'חמישי'], 'staff-bonding-fri': ['שישי', 'שישי'],
  };
  for (const [key, [from, to]] of Object.entries(published)) {
    const e = byKey(key);
    eq([weekday(e.start), weekday(e.end)], [from, to], `${e.name} ${e.start}→${e.end}`);
  }
}

console.log('\n💰  יום מקוצר לא מוריד יום חופש\n');
{
  // The real function out of the payroll controller, reached without booting a
  // server: everything it needs is passed in.
  const { execSync } = require('child_process');
  const src = require('fs').readFileSync('src/controllers/payrollMonth.controller.js', 'utf8');
  const start = src.indexOf('function computeKindergartenVacationDays');
  const body = src.slice(start, src.indexOf('\n}\n', start) + 3);
  // eslint-disable-next-line no-new-func
  const compute = new Function(`${body}; return computeKindergartenVacationDays;`)();

  const hol = (kind, name, s, e) => ({
    kind, name,
    start_date: new Date(`${s}T00:00:00.000Z`),
    end_date: new Date(`${e}T00:00:00.000Z`),
    is_half_day: false,
  });

  // Purim, a Tuesday, closed → one vacation day.
  const purim = compute([hol('closure', 'פורים', '2027-03-23', '2027-03-23')], '2027-03', null, [], []);
  eq(purim.total, 1, 'פורים (סגור) — יורד יום חופש אחד');

  // יום הזיכרון, a Tuesday, the gan ran until noon → nothing drawn.
  const zikaron = compute([hol('short_day', 'יום הזיכרון', '2027-05-11', '2027-05-11')], '2027-05', null, [], []);
  eq(zikaron.total, 0, 'יום הזיכרון (מקוצר) — לא יורד כלום');
  eq(zikaron.details.length, 0, 'ולא נרשם בפירוט ימי החופש');

  // The staff Thursday, same thing.
  const staffThu = compute([hol('short_day', 'יום גיבוש צוות', '2027-07-15', '2027-07-15')], '2027-07', null, [], []);
  eq(staffThu.total, 0, 'חמישי של הגיבוש (מקוצר) — לא יורד כלום');

  // Both together in one month: only the closure counts.
  const may = compute([
    hol('short_day', 'יום הזיכרון', '2027-05-11', '2027-05-11'),
    hol('closure', 'יום העצמאות', '2027-05-12', '2027-05-12'),
  ], '2027-05', null, [], []);
  eq(may.total, 1, 'מאי — רק יום העצמאות נספר, לא יום הזיכרון');
  eq(may.details.map((d) => d.name), ['יום העצמאות'], 'והפירוט מראה רק אותו');

  // A day she came in anyway on a real closure is still not drawn.
  const worked = compute([hol('closure', 'פורים', '2027-03-23', '2027-03-23')],
    '2027-03', null, [], ['2027-03-23']);
  eq(worked.total, 0, 'סגירה שהיא כן הגיעה אליה — לא יורד יום (התנהגות קיימת, נשמרת)');
}

console.log('\n🏷️  כל שורה נשמרת למודל הנכון\n');
{
  const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  for (const key of ['family-day', 'graduation', 'staff-bonding-fri']) {
    eq(toDocument(byKey(key), B, YEAR_5787).model, 'SpecialDay', `${byKey(key).name} → יום מיוחד`);
  }
  for (const key of ['pesach', 'yom-hazikaron']) {
    eq(toDocument(byKey(key), B, YEAR_5787).model, 'Holiday', `${byKey(key).name} → חופשה`);
  }
  const special = toDocument(byKey('graduation'), B, YEAR_5787).doc;
  ok(special.pay_global === true, 'עובדת בתקן לא מנוכה על סגירה של המעסיק');
  ok(special.pay_hourly === false, 'ועובדת שעתית לא מזוכה על יום שלא עבדה');

  const short = toDocument(byKey('yom-hazikaron'), B, YEAR_5787).doc;
  eq(short.kind, 'short_day', 'יום הזיכרון נשמר כיום מקוצר');
  eq(short.end_time, '12:00', 'עם שעת הסיום');
  ok(short.is_half_day === false, 'ולא כחצי חופשה — זה היה מוריד חצי יום');
}

console.log('\n🚪  האם הגן פתוח ביום נתון\n');
{
  const cal = { entries: CALENDAR_5787.map((e) => ({ ...e })) };
  eq(statusOn(cal, '2027-03-23').open, false, '23.3 — פורים, סגור');
  eq(statusOn(cal, '2027-05-11'), { open: true, until: '12:00', name: 'יום הזיכרון' }, '11.5 — פתוח עד 12:00');
  eq(statusOn(cal, '2027-02-19').open, false, '19.2 — יום המשפחה, סגור');
  eq(statusOn(cal, '2027-03-24').open, true, '24.3 — יום רגיל');
  eq(statusOn(cal, '2026-09-28').open, false, '28.9 — בתוך סוכות');
}

console.log(`\n${failures ? `❌  ${failures} בדיקות נכשלו\n` : '✅  הכל עבר\n'}`);
process.exit(failures ? 1 : 0);
