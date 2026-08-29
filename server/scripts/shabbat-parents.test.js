#!/usr/bin/env node
/**
 * אבא ואמא של שבת — whose turn it is.
 *
 * The rule the gan runs on is one sentence: nobody goes twice until everybody
 * has gone once. Everything worth testing here is a way that sentence goes
 * wrong quietly — a child who joined in March, a child who left, a month
 * edited after the fact, a round that runs out in the middle of a month.
 *
 *   node scripts/shabbat-parents.test.js
 */

const { rotation, planMonth } = require('../src/services/shabbatParents');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

const boy = (id, name) => ({ id, name, gender: 'boy' });
const girl = (id, name) => ({ id, name, gender: 'girl' });
const turn = (date, f, m) => ({ date, father_child_id: f, mother_child_id: m });

const KIDS = [
  boy('b1', 'איתי'), boy('b2', 'נועם'), boy('b3', 'רועי'),
  girl('g1', 'אביגיל'), girl('g2', 'הדס'),
];

console.log('\n🔁  סבב\n');
{
  const s = rotation(KIDS, []);
  eq(s.boys.round, { done: 0, total: 3 }, 'בלי היסטוריה — הסבב בתחילתו');
  eq(s.boys.waiting.length, 3, 'כל הבנים ממתינים');
  eq(s.girls.waiting.length, 2, 'וכל הבנות');
}
{
  const s = rotation(KIDS, [turn('2026-09-04', 'b1', 'g1')]);
  eq(s.boys.round, { done: 1, total: 3 }, 'אחרי שבוע אחד');
  ok(!s.boys.waiting.some(c => c.id === 'b1'), 'מי שכבר היה אינו ברשימת ההמתנה');
  ok(s.boys.children.find(c => c.id === 'b1').served_this_round, 'ומסומן כמי שהיה בסבב הזה');
}

console.log('\n♻️  סגירת סבב ופתיחת סבב חדש\n');
{
  // Every girl has gone: the girls' round closes, the boys' does not.
  const s = rotation(KIDS, [
    turn('2026-09-04', 'b1', 'g1'),
    turn('2026-09-11', 'b2', 'g2'),
  ]);
  eq(s.girls.round, { done: 0, total: 2 }, 'סבב הבנות נסגר ונפתח מחדש');
  eq(s.girls.waiting.length, 2, 'ושתיהן זמינות שוב');
  eq(s.boys.round, { done: 2, total: 3 }, 'סבב הבנים עדיין פתוח');
  eq(s.boys.waiting.map(c => c.id), ['b3'], 'ונשאר בו רק מי שלא היה');
}
{
  // A full round and one more turn: the new round has exactly that one in it.
  const s = rotation(KIDS, [
    turn('2026-09-04', 'b1', 'g1'),
    turn('2026-09-11', 'b2', 'g2'),
    turn('2026-09-18', 'b3', 'g1'),
    turn('2026-09-25', 'b1', 'g2'),
  ]);
  eq(s.boys.round, { done: 1, total: 3 }, 'הבן הראשון בסבב החדש נספר');
  ok(!s.boys.waiting.some(c => c.id === 'b1'), 'והוא לא יחזור עד שהשאר יעברו');
  eq(s.boys.waiting.map(c => c.name), ['נועם', 'רועי'], 'שני הנותרים ממתינים');
}

console.log('\n⏳  מי הבא בתור\n');
{
  const s = rotation(KIDS, [
    turn('2026-09-04', 'b1', null),
    turn('2026-09-11', 'b2', null),
    turn('2026-09-18', 'b3', null),   // round closes
    turn('2026-09-25', 'b2', null),   // new round: only נועם has gone
  ]);
  // Of the two waiting, איתי went longer ago than רועי.
  eq(s.boys.waiting.map(c => c.name), ['איתי', 'רועי'],
    'הראשון בתור הוא מי שהיה לפני הכי הרבה זמן');
}
{
  // The rule only bites once a round has closed and everybody is eligible
  // again: then a newcomer who has never gone outranks children who have.
  const s = rotation([...KIDS, boy('b4', 'תום')], [
    turn('2026-09-04', 'b1', null),
    turn('2026-09-11', 'b2', null),
    turn('2026-09-18', 'b3', null),
    turn('2026-09-25', 'b4', null),   // four boys, round closes
  ]);
  eq(s.boys.round, { done: 0, total: 4 }, 'הסבב נסגר וכולם זמינים');
  eq(s.boys.waiting.map(c => c.name), ['איתי', 'נועם', 'רועי', 'תום'],
    'והתור נקבע לפי מי היה לפני הכי הרבה זמן');

  // Now add a child who was never in any round at all.
  const s2 = rotation([...KIDS, boy('b4', 'תום'), boy('b5', 'אורי')], [
    turn('2026-09-04', 'b1', null),
    turn('2026-09-11', 'b2', null),
    turn('2026-09-18', 'b3', null),
    turn('2026-09-25', 'b4', null),
  ]);
  eq(s2.boys.waiting[0].name, 'אורי', 'ילד שמעולם לא היה קודם לכל מי שכבר היה');
}

console.log('\n🚪  ילד שהצטרף וילד שעזב\n');
{
  // A child who left still had their turn, but must not hold the round open
  // for the children who are still in the room.
  const s = rotation(KIDS, [
    turn('2026-09-04', 'b1', null),
    turn('2026-09-11', 'b2', null),
    turn('2026-09-18', 'gone', null),   // a child no longer on the roster
    turn('2026-09-25', 'b3', null),
  ]);
  eq(s.boys.round, { done: 0, total: 3 }, 'שלושת הבנים שנשארו השלימו סבב');
  eq(s.boys.waiting.length, 3, 'וכולם זמינים שוב');
}
{
  // A child who joins mid-year has never gone, so they go first.
  const later = [...KIDS, boy('b9', 'יהלי')];
  const s = rotation(later, [
    turn('2026-09-04', 'b1', null),
    turn('2026-09-11', 'b2', null),
    turn('2026-09-18', 'b3', null),
  ]);
  eq(s.boys.round, { done: 3, total: 4 }, 'הצטרפות באמצע לא סוגרת את הסבב');
  eq(s.boys.waiting.map(c => c.name), ['יהלי'], 'והמצטרף הוא הבא בתור');
}

console.log('\n❔  ילד בלי מין רשום\n');
{
  const s = rotation([...KIDS, { id: 'x', name: 'שחר', gender: '' }], []);
  eq(s.unknown_gender.map(c => c.name), ['שחר'], 'מדווח בנפרד');
  ok(!s.boys.children.some(c => c.id === 'x') && !s.girls.children.some(c => c.id === 'x'),
    'ואינו נכנס לאף סבב — לא מנחשים');
  eq(s.boys.round.total, 3, 'ואינו מנפח את גודל הסבב');
}

console.log('\n🗓️  שיבוץ חודש שלם\n');
{
  const s = rotation(KIDS, []);
  const weeks = [0, 1, 2, 3, 4].map(i => ({ index: i, has_father: false, has_mother: false }));
  const plan = planMonth(s, weeks);

  eq(plan.length, 5, 'הצעה לכל שבוע');
  const boys = plan.map(p => p.father.name);
  eq(boys.slice(0, 3), ['איתי', 'נועם', 'רועי'], 'שלושת הבנים, כל אחד פעם אחת');
  // Only three boys and five weeks: the round closes and the next one starts.
  eq(new Set(boys.slice(0, 3)).size, 3, 'בלי כפילות בתוך הסבב');
  eq(boys.slice(3), ['איתי', 'נועם'], 'ואז סבב חדש, מההתחלה');

  const girls = plan.map(p => p.mother.name);
  eq(girls, ['אביגיל', 'הדס', 'אביגיל', 'הדס', 'אביגיל'], 'שתי בנות — סבב כל שבועיים');
}
{
  // Weeks that already have somebody are left alone unless asked.
  const s = rotation(KIDS, []);
  const weeks = [
    { index: 0, has_father: true, has_mother: true },
    { index: 1, has_father: false, has_mother: false },
  ];
  const plan = planMonth(s, weeks);
  eq(plan[0], { index: 0, father: null, mother: null }, 'שבוע משובץ לא נגוע');
  eq(plan[1].father.name, 'איתי', 'והשבוע הריק מקבל את הראשון בתור');

  const forced = planMonth(s, weeks, { overwrite: true });
  eq(forced[0].father.name, 'איתי', 'עם דריסה — גם המשובץ מוחלף');
}
{
  // A room with no children of one gender must not crash or invent one.
  const s = rotation([boy('b1', 'איתי')], []);
  const plan = planMonth(s, [{ index: 0, has_father: false, has_mother: false }]);
  eq(plan[0].father.name, 'איתי', 'הבן משובץ');
  eq(plan[0].mother, null, 'ואין אמא של שבת להמציא');
}

console.log(failures === 0 ? '\n✅  הכל עבר\n' : `\n❌  ${failures} בדיקות נכשלו\n`);
process.exit(failures === 0 ? 0 : 1);
