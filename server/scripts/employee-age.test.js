#!/usr/bin/env node
/**
 * גיל העובד/ת — מתאריך לידה לשנים שלמות.
 *
 * The employee card had no date of birth at all: the only "birth" on the model
 * was `gave_birth_date`, which is the date a BABY was born and belongs to
 * maternity leave. Age is now derived from a new `birth_date`, and the three
 * things that can quietly break it are pinned here:
 *
 *   - the birthday boundary. A person born on the 20th is still N-1 on the
 *     19th, and N on the 20th. Off by one here ages the whole roster by a year
 *     for eleven months of every twelve.
 *   - garbage in. The field is nullable and always will be — most of the
 *     roster has no value and never will — so `null`, `''` and an unparsable
 *     string must come back as "no age", never `NaN` or `0` on the screen.
 *   - a value outside a human lifetime. A typo'd year (2190, 1290) must read
 *     as "no age" rather than rendering a confident absurdity in the table.
 *
 * The field also has to survive the round trip: a schema path that exists but
 * is missing from the controller's write whitelist saves nothing and reports
 * success, which is the failure mode that looks like the UI is broken.
 *
 * Pure functions plus two static checks, no database.
 *
 *   node scripts/employee-age.test.js
 */

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = a === b;
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

const ROOT = path.join(__dirname, '..', '..');
const AGE_UTIL = path.join(ROOT, 'client', 'src', 'utils', 'age.js');
const EMPLOYEE_MODEL = path.join(ROOT, 'server', 'src', 'models', 'Employee.js');
const PAYROLL_CONTROLLER = path.join(ROOT, 'server', 'src', 'controllers', 'payroll.controller.js');

(async () => {
  // The util lives in the client, which is an ES module package. A CommonJS
  // test can still load it — node decides by the nearest package.json.
  const { ageFromBirthDate } = await import(pathToFileURL(AGE_UTIL).href);

  console.log('\n🎂  גבול יום ההולדת\n');
  {
    // Fixed "now" so the test does not age out. 2026-09-15, a Tuesday.
    const now = new Date(2026, 8, 15);
    eq(ageFromBirthDate('1990-09-15', now), 36, 'ביום ההולדת עצמו — 36');
    eq(ageFromBirthDate('1990-09-16', now), 35, 'יום לפני — עדיין 35');
    eq(ageFromBirthDate('1990-09-14', now), 36, 'יום אחרי — 36');
    eq(ageFromBirthDate('1990-12-31', now), 35, 'נולדה בסוף השנה — טרם חגגה');
    eq(ageFromBirthDate('1990-01-01', now), 36, 'נולדה בתחילת השנה — כבר חגגה');
  }

  console.log('\n📅  29 בפברואר\n');
  {
    // A leap-day birthday in a non-leap year: on 28/02 she has not had a
    // birthday yet, on 01/03 she has. Nobody should be a year older early.
    eq(ageFromBirthDate('1992-02-29', new Date(2026, 1, 28)), 33, '28/02 בשנה רגילה — 33');
    eq(ageFromBirthDate('1992-02-29', new Date(2026, 2, 1)), 34, '01/03 בשנה רגילה — 34');
    eq(ageFromBirthDate('1992-02-29', new Date(2028, 1, 29)), 36, '29/02 בשנה מעוברת — 36');
  }

  console.log('\n🚫  אין ערך, או ערך שאי אפשר לקרוא\n');
  {
    const now = new Date(2026, 8, 15);
    eq(ageFromBirthDate(null, now), null, 'null — אין גיל');
    eq(ageFromBirthDate(undefined, now), null, 'undefined — אין גיל');
    eq(ageFromBirthDate('', now), null, 'מחרוזת ריקה — אין גיל');
    eq(ageFromBirthDate('לא תאריך', now), null, 'טקסט חופשי — אין גיל');
    eq(ageFromBirthDate(new Date('nope'), now), null, 'Invalid Date — אין גיל');
  }

  console.log('\n🧮  מחוץ לתוחלת חיים — טעות הקלדה, לא גיל\n');
  {
    const now = new Date(2026, 8, 15);
    eq(ageFromBirthDate('2190-01-01', now), null, 'תאריך עתידי — אין גיל, לא מספר שלילי');
    eq(ageFromBirthDate('2026-09-16', now), null, 'מחר — אין גיל');
    eq(ageFromBirthDate('1290-01-01', now), null, 'לפני 700 שנה — אין גיל');
    eq(ageFromBirthDate('1899-12-31', now), null, 'לפני 1900 — אין גיל');
    eq(ageFromBirthDate('2026-09-15', now), 0, 'נולדה היום — 0, וזה ערך אמיתי ולא "אין"');
  }

  console.log('\n🗂️  השדה קיים בסכמה, nullable ולא חובה\n');
  {
    const Employee = require(EMPLOYEE_MODEL);
    const p = Employee.schema.path('birth_date');
    ok(!!p, 'Employee.birth_date קיים');
    ok(p && p.instance === 'Date', 'הטיפוס Date');
    ok(p && p.defaultValue === null, 'ברירת מחדל null — רשומות ישנות לא נוגעות');
    ok(p && !p.isRequired, 'לא required — אין מיגרציה ואין כרטיס שנחסם בשמירה');
  }

  console.log('\n🔁  הלוך ושוב דרך ה-controller\n');
  {
    const src = fs.readFileSync(PAYROLL_CONTROLLER, 'utf8');
    // updateEmployee copies only whitelisted keys off req.body. A field that is
    // in the schema but not in that list saves nothing and returns 200.
    ok(/'birth_date'/.test(src), "'birth_date' נמצא ברשימת השדות של updateEmployee");
    ok(/birth_date:\s*'[^']+'/.test(src), 'יש תווית עברית ל-birth_date בתצוגת ההשוואה של בקשות שינוי');
    // The label must not collide with gave_birth_date's, or the accountant's
    // diff shows two different fields under one name.
    const labels = [...src.matchAll(/^\s{2}([a-z_]+):\s*'([^']+)'/gm)].map(m => m[2]);
    const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
    ok(dupes.length === 0, `אין תוויות כפולות בטבלת התוויות${dupes.length ? ` (${[...new Set(dupes)].join(', ')})` : ''}`);
  }

  console.log(failures === 0 ? '\n🎉  הכל עבר\n' : `\n💥  ${failures} כשלונות\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error('\n💥 ', err);
  process.exit(1);
});
