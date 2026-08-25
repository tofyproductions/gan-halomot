#!/usr/bin/env node
/**
 * Two features that decide what a family is told.
 *
 * WHAT IS MISSING. The list is a standing state, not a diary. Re-saving the
 * same list must not restamp it: an item outstanding for three weeks that
 * looks like it was raised this morning is an item nobody chases, which is the
 * exact failure the timestamps exist to prevent.
 *
 * WHAT PARENTS SEE. Two switches with DIFFERENT defaults, and the difference
 * is the whole point:
 *
 *   gantt — off. Parents never saw it; publishing every room's plans because a
 *           feature shipped is not a decision the gan made.
 *   menu  — on. Parents see it TODAY. Defaulting it off would take something
 *           away silently, and the gan would not know it had happened.
 *
 * Both defaults are asserted here because a later refactor that "tidies" them
 * into one shared default would look harmless and would be wrong twice.
 *
 *   node scripts/supplies-visibility.test.js
 */

const supplies = require('../src/services/supplies');
const pv = require('../src/services/parentVisibility');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

console.log('\n📋  רשימת הציוד מכסה את הדף שנשלח להורים\n');
{
  const keys = supplies.CATALOGUE.map((i) => i.key);
  for (const k of ['diapers', 'cream', 'wipes', 'formula', 'bedding', 'pacifier',
    'bottles', 'water', 'clothes', 'comforter', 'thermometer']) {
    ok(keys.includes(k), `${supplies.itemFor(k).label} — קיים`);
  }
  // The board's old list must survive, or the words the staff already type vanish.
  for (const k of ['tetra', 'bibs', 'socks']) {
    ok(keys.includes(k), `${supplies.itemFor(k).label} — נשמר מהרשימה הישנה`);
  }
  ok(supplies.CATALOGUE.every((i) => i.emoji && i.color), 'לכל פריט יש אייקון וצבע');
  eq(new Set(keys).size, keys.length, 'ואין מפתחות כפולים');
}

console.log('\n⏱️  שמירה חוזרת לא מאפסת את התאריך\n');
{
  const threeWeeksAgo = new Date('2026-08-01T09:00:00.000Z');
  const existing = [{ key: 'wipes', marked_at: threeWeeksAgo, marked_by_name: 'שירה' }];

  const again = supplies.mergeMissing(existing, [{ key: 'wipes' }], { full_name: 'מאיה' });
  eq(new Date(again[0].marked_at).toISOString(), threeWeeksAgo.toISOString(),
    'מגבונים — התאריך המקורי נשמר');
  eq(again[0].marked_by_name, 'שירה', 'וגם מי שסימנה במקור');

  const added = supplies.mergeMissing(existing, [{ key: 'wipes' }, { key: 'diapers' }], { full_name: 'מאיה' });
  eq(added.length, 2, 'פריט חדש נוסף');
  eq(added[0].key, 'wipes', 'והוותיק מופיע ראשון — הוא הנשכח');
  eq(added.find((m) => m.key === 'diapers').marked_by_name, 'מאיה', 'החדש נרשם על מי שסימנה עכשיו');
}

console.log('\n🧹  הסרה ונקיון\n');
{
  const existing = [{ key: 'wipes', marked_at: new Date() }, { key: 'diapers', marked_at: new Date() }];
  eq(supplies.mergeMissing(existing, [{ key: 'diapers' }]).map((m) => m.key), ['diapers'],
    'פריט שירד מהרשימה — נמחק');
  eq(supplies.mergeMissing(existing, []), [], 'רשימה ריקה מנקה הכל');
  eq(supplies.mergeMissing(existing, [{ key: 'wipes' }, { key: 'wipes' }]).length, 1,
    'אותו פריט פעמיים נספר פעם אחת');
  eq(supplies.mergeMissing([], [{ key: 'שקיות ניילון', label: 'שקיות ניילון' }])[0].key,
    'שקיות ניילון', 'פריט חופשי שהגן הקליד מתקבל');
}

console.log('\n🎨  התצוגה נלקחת מהרשימה בזמן קריאה\n');
{
  // Stored rows carry only the key, so correcting a label fixes every child at
  // once rather than only the ones marked after the correction.
  const shown = supplies.decorate({ key: 'formula', marked_at: new Date() });
  eq(shown.label, 'תמ״ל', 'השם מגיע מהרשימה');
  ok(!!shown.emoji, 'עם האייקון');
  const custom = supplies.decorate({ key: 'שקיות', label: 'שקיות', marked_at: new Date() });
  eq(custom.label, 'שקיות', 'ופריט חופשי שומר את מה שהוקלד');
}

console.log('\n📆  מפתח השבוע מתחיל בראשון\n');
{
  eq(pv.weekStart('2026-09-16'), '2026-09-13', 'רביעי שייך לראשון שלפניו');
  eq(pv.weekStart('2026-09-13'), '2026-09-13', 'וראשון הוא תחילת השבוע של עצמו');
  eq(new Set(pv.weekDates('2026-09-16').map(pv.weekKey)).size, 1,
    'כל שבעת הימים מקבלים מפתח אחד');
  eq(new Set(['2026-12-31', '2027-01-01', '2027-01-02'].map(pv.weekKey)).size, 1,
    'ושבוע שחוצה שנה לא נשבר לשניים');
  eq(pv.weekKey('2026-09-19') === pv.weekKey('2026-09-20'), false,
    'שבת וראשון אחריה הם שבועות שונים');
}

console.log('\n🔀  ברירות המחדל שונות בכוונה\n');
{
  // The real defaulting function, with the row a missing record produces.
  const none = pv.applyDefaults(null, '2026-W38');
  ok(none.gantt === false, 'גאנט — מוסתר כברירת מחדל (ההורים מעולם לא ראו אותו)');
  ok(none.menu === true, 'תפריט — מוצג כברירת מחדל (ההורים רואים אותו כבר היום)');
  ok(none.is_default === true, 'ומסומן שזו ברירת מחדל, לא החלטה');

  const decided = pv.applyDefaults({ gantt: true, menu: false, set_by_name: 'רונית' }, '2026-W38');
  ok(decided.gantt === true, 'החלטה לפרסם גאנט גוברת');
  ok(decided.menu === false, 'והחלטה להסתיר תפריט גוברת גם היא');
  ok(decided.is_default === false, 'ומסומנת כהחלטה');
  eq(decided.set_by_name, 'רונית', 'עם השם של מי שהחליטה');
}

console.log('\n🛡️  תאריך מה-URL לא נסמך עליו\n');
{
  const today = pv.ymdOf(new Date());
  eq(pv.normalizeRequestedDate('2026-09-14'), '2026-09-14', 'תאריך תקין עובר');
  eq(pv.normalizeRequestedDate('nonsense'), today, 'זבל נופל להיום');
  eq(pv.normalizeRequestedDate(''), today, 'ריק נופל להיום');
  eq(pv.normalizeRequestedDate('2026-13-45'), today, 'תאריך לא קיים נופל להיום');
}

console.log(`\n${failures ? `❌  ${failures} בדיקות נכשלו\n` : '✅  הכל עבר\n'}`);
process.exit(failures ? 1 : 0);
