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

const { generateWeeks, normalizeWeeks } = require('../src/controllers/gantt.controller');

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

  // The week starts where the WEEK starts, not where the month does: the gan
  // changes subject after a full week, so those borrowed days are writable.
  eq(DAYS[new Date(first.start_date).getDay()], 'ראשון', 'השבוע הראשון מתחיל ביום ראשון');
  eq(new Date(first.start_date).getMonth(), 7, 'והוא נופל עדיין באוגוסט');
  eq(new Date(first.start_date).getDate(), 30, 'ב-30 באוגוסט');
  eq(columnOf(first, 0), 0, 'ולכן day_index 0 הוא עמודת ראשון');

  // Every column carries its true date.
  eq(columnDate(first, 0).getDate(), 30, 'ראשון הוא 30.8');
  eq(columnDate(first, 2).getDate(), 1, 'שלישי הוא ה-1 בספטמבר');
  eq(columnDate(first, 5).getDate(), 4, 'שישי הוא ה-4');

  // Six writable boxes, so a week's subject covers the whole week.
  ok([0, 1, 2, 3, 4, 5].every(di => columnDate(first, di).getDay() === di),
    'כל שש העמודות יושבות על היום שלהן');
}

console.log('\n🔄  המרה של חודש שנשמר בפורמט הישן — בלי שדבר יזוז\n');
{
  // How September 2026 was stored before: the week starts on the 1st, a
  // Tuesday, and day_index is counted from there.
  const legacy = [{
    week_number: 1,
    start_date: new Date(2026, 8, 1),
    end_date: new Date(2026, 8, 5),
    topic: 'הסתגלות',
    cells: [
      { row_key: 'meeting', day_index: 0, content: 'חוקי הגן' },     // 1.9, שלישי
      { row_key: 'meeting', day_index: 2, content: 'ראש השנה' },     // 3.9, חמישי
      { row_key: 'story', day_index: 4, content: 'לא יצויר' },       // 5.9, שבת
    ],
  }];

  const [w] = normalizeWeeks(legacy);
  eq(DAYS[new Date(w.start_date).getDay()], 'ראשון', 'השבוע הומר להתחיל בראשון');
  eq(new Date(w.start_date).getDate(), 30, 'כלומר ב-30 באוגוסט');
  eq(w.topic, 'הסתגלות', 'הנושא נשמר');

  // The whole point: each cell keeps the DATE it was written for.
  const dateOfCell = (cell) => {
    const d = new Date(w.start_date);
    d.setDate(d.getDate() + cell.day_index);
    return `${d.getDate()}.${d.getMonth() + 1}`;
  };
  const meetings = w.cells.filter(c => c.row_key === 'meeting');
  eq(meetings.map(c => `${c.content} → ${dateOfCell(c)}`),
    ['חוקי הגן → 1.9', 'ראש השנה → 3.9'],
    'כל תא נשאר על אותו תאריך בדיוק');
  eq(meetings.map(c => DAYS[c.day_index]), ['שלישי', 'חמישי'], 'ובעמודה של היום הנכון');

  // The Saturday cell has no column on a ראשון–שישי grid and never had one.
  eq(w.cells.filter(c => c.content === 'לא יצויר').length, 0, 'תא של שבת נושר');

  // Running it twice must not shift anything a second time.
  eq(JSON.stringify(normalizeWeeks(normalizeWeeks(legacy))), JSON.stringify(normalizeWeeks(legacy)),
    'ההמרה אידמפוטנטית — הרצה נוספת לא מזיזה שוב');

  // A month that already starts on a Sunday is returned as it came.
  const clean = generateWeeks(11, 2026);
  eq(JSON.stringify(normalizeWeeks(clean)), JSON.stringify(clean), 'חודש תקין אינו משתנה');
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
          checked += 1;
          if (d.getDay() !== di) bad += 1;
          if (d.getMonth() !== m - 1 || d.getFullYear() !== y) continue;
          // No date of THIS month may be drawn twice.
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
