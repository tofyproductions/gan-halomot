#!/usr/bin/env node
/**
 * Opening a year's classrooms.
 *
 * A child absorbed with no classroom is absorbed into nothing — no rooms
 * screen, no attendance, no collections, no supplies list — so the rooms have
 * to exist before an intake can happen at all. This is the part that decides
 * WHICH rooms, and it has three ways to be quietly wrong:
 *
 *   - creating a name that already exists (a duplicate room, and children
 *     spread across both)
 *   - copying forward the names an old encoding bug mangled, reintroducing
 *     junk into a clean year
 *   - overwriting a year somebody has already started arranging
 *
 * All three are refusals rather than errors, and every refusal is reported:
 * a run that says only "created 6" cannot be checked by the person who
 * pressed the button.
 *
 *   node scripts/classroom-planner.test.js
 */

const {
  CATEGORIES, isGarbledName, nextFreeName, planCreate, planCopy,
} = require('../src/services/classroomPlanner');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

const names = (r) => r.create.map((c) => c.name);

console.log('\n🔤  שמות לפי המוסכמה של הגן\n');
{
  eq(nextFreeName('תינוקייה', new Set()), 'תינוקייה א', 'הראשונה מקבלת א');
  eq(nextFreeName('תינוקייה', new Set(['תינוקייה א'])), 'תינוקייה ב', 'השנייה מקבלת ב');
  // A branch with א and ג should get ב — not a second ג.
  eq(nextFreeName('תינוקייה', new Set(['תינוקייה א', 'תינוקייה ג'])), 'תינוקייה ב',
    'פער באמצע מתמלא, ולא נוצרת כפילות');
  eq(CATEGORIES, ['תינוקייה', 'צעירים', 'בוגרים'], 'שלוש שכבות הגיל');
}

console.log('\n➕  יצירה מאפס\n');
{
  const r = planCreate([], [
    { category: 'תינוקייה', count: 2, capacity: 12 },
    { category: 'בוגרים', count: 1, capacity: 25 },
  ]);
  eq(names(r), ['תינוקייה א', 'תינוקייה ב', 'בוגרים א'], 'שלוש כיתות בשמות הנכונים');
  eq(r.create[0].capacity, 12, 'עם התקן שהוזן');
  eq(r.create.map((c) => c.category), ['תינוקייה', 'תינוקייה', 'בוגרים'], 'ושכבת הגיל נשמרת');
  eq(r.skipped, [], 'ולא דולג על כלום');
}

console.log('\n🛑  לא נוצרת כיתה שכבר קיימת\n');
{
  // `count` is a TARGET — how many should exist — not how many to add.
  // Otherwise a second run doubles the year instead of doing nothing.
  const r = planCreate(['תינוקייה א'], [{ category: 'תינוקייה', count: 2 }]);
  eq(names(r), ['תינוקייה ב'], 'יש אחת, ביקשנו שתיים — נוצרת אחת');

  const met = planCreate(['תינוקייה א', 'תינוקייה ב'], [{ category: 'תינוקייה', count: 2 }]);
  eq(met.create, [], 'היעד כבר מושג — לא נוצר כלום');
  ok(met.skipped.some((s) => /כבר קיימות/.test(s.reason)), 'ונאמר למה');

  const fewer = planCreate(['תינוקייה א', 'תינוקייה ב', 'תינוקייה ג'], [{ category: 'תינוקייה', count: 2 }]);
  eq(fewer.create, [], 'יש יותר מהיעד — כלום לא נוצר וכלום לא נמחק');

  const full = planCreate([], [{ category: 'בוגרים', count: 99 }]);
  eq(full.create.length, 10, 'בקשה מוגזמת נחתכת למספר האותיות');
  ok(full.skipped.some((s) => /אותיות/.test(s.reason)), 'ונאמר למה');

  const bad = planCreate([], [{ category: 'לא קיים', count: 2 }]);
  eq(bad.create, [], 'שכבת גיל לא תקינה — לא נוצר כלום');
  ok(bad.skipped.some((s) => /לא תקינה/.test(s.reason)), 'ונאמר למה');

  eq(planCreate([], [{ category: 'תינוקייה', count: 0 }]).create, [], 'אפס כיתות — כלום');
}

console.log('\n📄  העתקה משנה קודמת\n');
{
  const lastYear = [
    { name: 'תינוקייה א', category: 'תינוקייה', capacity: 12 },
    { name: 'בוגרים א', category: 'בוגרים', capacity: 25 },
  ];
  const r = planCopy(lastYear, []);
  eq(names(r), ['תינוקייה א', 'בוגרים א'], 'שתי הכיתות הועתקו');
  eq(r.create[1].capacity, 25, 'עם התקן שהיה');
  eq(r.create[1].category, 'בוגרים', 'ועם שכבת הגיל');
}

console.log('\n🗑️  שמות פגומים לא עוברים לשנה חדשה\n');
{
  // The encoding bug left rooms with names like "תינ��וקייה". Copying them
  // forward would reintroduce junk into a year that starts clean.
  ok(isGarbledName('תינ��וקייה'), 'שם עם תווים פגומים מזוהה');
  ok(isGarbledName('??כיתה'), 'וגם סימני שאלה כפולים');
  ok(!isGarbledName('תינוקייה א'), 'שם תקין לא מזוהה בטעות');
  ok(!isGarbledName('בוגרים ב?'), 'וגם לא סימן שאלה בודד');

  const r = planCopy([
    { name: 'תינוקייה א', category: 'תינוקייה' },
    { name: 'תינ��וקייה', category: null },
  ], []);
  eq(names(r), ['תינוקייה א'], 'רק התקינה הועתקה');
  ok(r.skipped.some((s) => /פגום/.test(s.reason)), 'והפגומה דווחה, לא נבלעה');
}

console.log('\n✋  שנה שכבר התחילו לסדר לא נדרסת\n');
{
  const r = planCopy(
    [{ name: 'תינוקייה א' }, { name: 'בוגרים א' }],
    ['תינוקייה א'],
  );
  eq(names(r), ['בוגרים א'], 'רק מה שחסר נוצר');
  ok(r.skipped.some((s) => s.name === 'תינוקייה א' && /קיימת/.test(s.reason)),
    'והקיימת דווחה כמדולגת');

  // Running the whole thing twice must produce nothing the second time.
  const again = planCopy([{ name: 'תינוקייה א' }, { name: 'בוגרים א' }], ['תינוקייה א', 'בוגרים א']);
  eq(again.create, [], 'הרצה שנייה לא יוצרת כלום');
  eq(again.skipped.length, 2, 'ושתיהן מדווחות כקיימות');
}

console.log('\n🈳  מקורות ריקים\n');
{
  eq(planCopy([], []).create, [], 'אין שנה קודמת — אין מה להעתיק');
  eq(planCopy(null, []).create, [], 'ומקור חסר לא מפיל');
  eq(planCreate([], null).create, [], 'ותוכנית חסרה לא מפילה');
  eq(planCopy([{ name: '   ' }], []).create, [], 'שם ריק מדולג');
}

console.log(`\n${failures ? `❌  ${failures} בדיקות נכשלו\n` : '✅  הכל עבר\n'}`);
process.exit(failures ? 1 : 0);
