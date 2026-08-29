#!/usr/bin/env node
/**
 * Which box is which day.
 *
 * The gantt draws six columns, ראשון to שישי, and stores its cells against
 * `day_index` — an offset counted from the week's `start_date`. Those two are
 * the same number only when the week starts on a Sunday, and the FIRST week of
 * a month does not: generateWeeks starts it on the 1st.
 *
 * September 2026 begins on a Tuesday. The editor drew that first week from
 * start_date across six columns labelled ראשון..שישי, so 1.9 appeared under
 * ראשון and the entire week was read two days early. A gananet planning
 * around a holiday, or a parent reading Tuesday's plan on Sunday, is looking
 * at the wrong day.
 *
 * The month ends ragged too — September 2026 ends on a Wednesday — and the
 * last week's Thursday and Friday columns showed October dates as if they were
 * September's.
 *
 *   node scripts/gantt-weekdays.test.js
 */

const { generateWeeks } = require('../src/controllers/gantt.controller');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'];

/**
 * The rule the editor and the parent portal both apply, stated once here:
 * a cell stored at `dayIndex` sits in the column `start_date.getDay() + dayIndex`.
 */
const columnOf = (week, dayIndex) => new Date(week.start_date).getDay() + dayIndex;

/** And the reverse: what the column at `di` holds, and on what date. */
function columnDate(week, di) {
  const d = new Date(week.start_date);
  d.setDate(d.getDate() - d.getDay() + di);
  return d;
}

console.log('\n📅  חודש שמתחיל באמצע השבוע — ספטמבר 2026 מתחיל בשלישי\n');
{
  const weeks = generateWeeks(9, 2026);
  const first = weeks[0];

  eq(new Date(first.start_date).getDate(), 1, 'השבוע הראשון מתחיל ב-1 בחודש');
  eq(DAYS[new Date(first.start_date).getDay()], 'שלישי', 'וה-1 בספטמבר 2026 הוא יום שלישי');

  // The bug, stated as the assertion that would have caught it: the cell the
  // gan writes first is not Sunday's box.
  eq(columnOf(first, 0), 2, 'התא הראשון של השבוע יושב בעמודת שלישי, לא ראשון');
  eq(DAYS[columnOf(first, 0)], 'שלישי', 'ושמו של היום הוא שלישי');

  // Every column carries its true date.
  eq(columnDate(first, 2).getDate(), 1, 'עמודת שלישי היא ה-1 בספטמבר');
  eq(columnDate(first, 3).getDate(), 2, 'רביעי הוא ה-2');
  eq(columnDate(first, 5).getDate(), 4, 'שישי הוא ה-4');

  // The two columns before it are August, and belong to nobody's September.
  ok(columnDate(first, 0).getMonth() === 7, 'עמודת ראשון נופלת באוגוסט');
  ok(columnDate(first, 1).getMonth() === 7, 'ועמודת שני גם');
}

console.log('\n📅  חודש שנגמר באמצע השבוע — ספטמבר 2026 נגמר ברביעי\n');
{
  const weeks = generateWeeks(9, 2026);
  const last = weeks[weeks.length - 1];

  eq(DAYS[new Date(last.start_date).getDay()], 'ראשון', 'השבוע האחרון מתחיל בראשון');
  eq(columnOf(last, 0), 0, 'ולכן ההיסט שלו אפס');

  const sept30 = weeks.flatMap((w, wi) => [0, 1, 2, 3, 4, 5]
    .map(di => ({ wi, di, d: columnDate(w, di) })))
    .filter(x => x.d.getMonth() === 8 && x.d.getDate() === 30);
  eq(sept30.length, 1, 'ה-30 בספטמבר מופיע פעם אחת בדיוק בכל החודש');
  eq(DAYS[sept30[0].di], 'רביעי', 'והוא יום רביעי');

  ok(columnDate(last, 4).getMonth() === 9, 'עמודת חמישי של השבוע האחרון היא כבר אוקטובר');
  ok(columnDate(last, 5).getMonth() === 9, 'וכך גם שישי');
}

console.log('\n📅  חודש שמתחיל בראשון — אין מה לתקן\n');
{
  // November 2026 begins on a Sunday.
  const weeks = generateWeeks(11, 2026);
  const first = weeks[0];
  eq(DAYS[new Date(first.start_date).getDay()], 'ראשון', '1 בנובמבר 2026 הוא ראשון');
  eq(columnOf(first, 0), 0, 'ההיסט אפס, והמיפוי הוא זהות');
  for (let di = 0; di < 6; di += 1) {
    eq(columnDate(first, di).getDate(), di + 1, `עמודה ${di} היא ה-${di + 1} בחודש`);
  }
}

console.log('\n📅  כל חודש בשנתיים הקרובות\n');
{
  let bad = 0;
  let checked = 0;
  for (let y = 2026; y <= 2027; y += 1) {
    for (let m = 1; m <= 12; m += 1) {
      const weeks = generateWeeks(m, y);
      const lastDay = new Date(y, m, 0).getDate();
      const seen = new Map();

      for (const w of weeks) {
        for (let di = 0; di < 6; di += 1) {
          const d = columnDate(w, di);
          if (d.getMonth() !== m - 1 || d.getFullYear() !== y) continue;
          checked += 1;
          // The column a date lands in must be that date's real weekday.
          if (d.getDay() !== di) bad += 1;
          // And no date may be drawn twice.
          const key = d.getDate();
          if (seen.has(key)) bad += 1;
          seen.set(key, true);
        }
      }
      // Every day of the month has a box somewhere, Saturdays excepted.
      for (let day = 1; day <= lastDay; day += 1) {
        if (new Date(y, m - 1, day).getDay() === 6) continue;
        if (!seen.has(day)) bad += 1;
      }
    }
  }
  ok(checked > 500, `נבדקו ${checked} תאי-יום`);
  eq(bad, 0, 'בכל חודש: כל יום מופיע פעם אחת, בעמודה של היום שלו');
}

console.log(failures === 0 ? '\n✅  הכל עבר\n' : `\n❌  ${failures} בדיקות נכשלו\n`);
process.exit(failures === 0 ? 0 : 1);
