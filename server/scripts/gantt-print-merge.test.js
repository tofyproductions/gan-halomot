#!/usr/bin/env node
/**
 * A merged box, on the sheet that goes home.
 *
 * The editor stores a merge as col_span/row_span on the top-right cell and
 * BLANKS the cells it swallowed. The print builder knew about neither, so it
 * drew all six: a week whose first row reads הסתגלות across five days printed
 * the word once, under Tuesday, with four blanks beside it — which reads as a
 * plan nobody finished writing, on the page sent to parents.
 *
 * The builder is client code with no imports of its own, so it is loaded here
 * by stripping the one `export` keyword. Testing the real file rather than a
 * copy is the point: a copy would agree with itself forever.
 *
 *   node scripts/gantt-print-merge.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '../../client/src/components/gantt/ganttPrint.js');
// The builder grew an import of the theme tokens after this test was written,
// and a vm context has no module loader — the file stopped parsing here while
// the app kept working. The import is stripped and COLOR answered by a stub:
// this test is about which cells a merge swallows, and a hex value cannot
// change that answer.
const code = fs.readFileSync(SRC, 'utf8')
  .replace(/^import[\s\S]*?;$/gm, '')
  .replace(/^export /gm, '');
// Nested: the builder reads COLOR.gantt.row.meeting. Any path answers, and
// any path used as a string is a valid hex.
const anyColor = new Proxy({}, {
  get: (_t, k) => (k === Symbol.toPrimitive || k === 'toString' ? () => '#000000' : anyColor),
});
const COLOR = anyColor;
const sandbox = { module: {}, exports: {}, console, Date, Math, Number, String, Set, Intl, COLOR };
vm.createContext(sandbox);
vm.runInContext(`${code}\n;module.exports = { buildGanttPrintHtml };`, sandbox);
const { buildGanttPrintHtml } = sandbox.module.exports;

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };

const ROWS = [
  { key: 'meeting', label: 'מפגש' },
  { key: 'activity', label: 'פעילות' },
  { key: 'creation', label: 'הנגשת חומרים' },
  { key: 'story', label: 'סיפור' },
  { key: 'misc', label: 'שונות' },
];

// September 2026: week 1 starts Sunday 30.8, so day_index 0 is that Sunday.
const weekWith = (cells) => ({
  week_number: 1, topic: 'הסתגלות',
  start_date: '2026-08-30T00:00:00.000Z',
  cells,
});

const build = (cells) => buildGanttPrintHtml({
  weeks: [weekWith(cells)], rows: ROWS, holidays: [],
  month: 9, year: 2026, classroomName: 'בוגרים', status: 'pending',
});

/** The <td>s of one row, by its Hebrew label. */
function rowCells(html, label) {
  const tr = html.split('<tr>').find(x => x.includes(`>${label}</th>`));
  return (tr || '').match(/<td[^>]*>/g) || [];
}

console.log('\n🖨️  איחוד תאים בייצוא\n');

console.log('הסתגלות פרוס על חמישה ימים');
{
  const html = build([
    { row_key: 'meeting', day_index: 0, content: 'הסתגלות', col_span: 5, row_span: 1 },
  ]);
  ok(/colspan="5"/.test(html), 'הפריסה יוצאת כ-colspan אמיתי');
  ok(html.includes('הסתגלות'), 'והכיתוב על הסהיט');
  const tds = rowCells(html, 'מפגש');
  ok(tds.length === 2, `שורת מפגש מציירת 2 תאים במקום 6 (קיבלנו ${tds.length})`);
  ok(/class="c[^"]*merged"/.test(html), 'ותא מאוחד מסומן, כדי שיקבל כתב גדול יותר');
}

console.log('\nאיחוד דו-ממדי');
{
  const html = build([
    { row_key: 'activity', day_index: 1, content: 'טיול', col_span: 2, row_span: 3 },
    { row_key: 'misc', day_index: 0, content: 'להביא כובע', col_span: 1, row_span: 1 },
  ]);
  ok(/colspan="2"/.test(html) && /rowspan="3"/.test(html), 'שתי הפריסות יוצאות');
  ok(rowCells(html, 'הנגשת חומרים').length === 4,
    'השורות שמתחת מדלגות על העמודות שנבלעו');
  ok(rowCells(html, 'סיפור').length === 4, 'גם השורה השלישית');
  ok(rowCells(html, 'שונות').length === 6, 'והשורה שאחרי הפריסה חוזרת למלואה');
}

console.log('\nפריסה שחורגת מהטבלה');
{
  // A row deleted after the merge was made leaves a span reaching past the
  // last row. An overrunning rowspan pulls the whole table apart, so it is
  // clamped rather than emitted as written.
  const html = build([
    { row_key: 'story', day_index: 4, content: 'x', col_span: 4, row_span: 9 },
    { row_key: 'misc', day_index: 0, content: 'להביא כובע', col_span: 1, row_span: 1 },
  ]);
  ok(!/colspan="4"/.test(html), 'colspan מוגבל לימים שנשארו בשבוע');
  ok(!/rowspan="9"/.test(html), 'ו-rowspan לשורות שנשארו בטבלה');
  ok(/rowspan="2"/.test(html), 'הערך המוגבל הוא זה שיוצא');
}

console.log('\nללא איחוד — כלום לא משתנה');
{
  const html = build([
    { row_key: 'meeting', day_index: 0, content: 'מפגש בוקר', col_span: 1, row_span: 1 },
  ]);
  ok(rowCells(html, 'מפגש').length === 6, 'שישה תאים, כמו תמיד');
  ok(!/colspan="1"|rowspan="1"/.test(html), 'ובלי תכונות מיותרות');
}

console.log('\nמצב תמונה');
{
  const opts = {
    weeks: [weekWith([])], rows: ROWS, holidays: [],
    month: 9, year: 2026, classroomName: 'בוגרים', status: 'pending',
  };
  const img = buildGanttPrintHtml({ ...opts, mode: 'image' });
  ok(/<body class="img">/.test(img), 'הגוף מסומן כתמונה');
  ok(!/הדפס \/ שמור/.test(img), 'בלי כפתורים — הם היו נצרבים לתוך התמונה');
  ok(/width: 1400px/.test(img), 'ורוחב קבוע במקום רוחב עמוד');

  const print = buildGanttPrintHtml({ ...opts, mode: 'print', pages: 1 });
  ok(/BUDGET = 1/.test(print), 'הדפסה בעמוד אחד מבקשת עמוד אחד');
  ok(/תמונה לוואטסאפ/.test(print), 'ובחלון ההדפסה יש כפתור לתמונה');
  const two = buildGanttPrintHtml({ ...opts, mode: 'print', pages: 2 });
  ok(/BUDGET = 2/.test(two), 'ושני עמודים מבקשים שניים');
}


console.log('\nשורת שונות');
{
  // Empty that week: not printed at all. Holding a note: printed, and short.
  const empty = build([
    { row_key: 'meeting', day_index: 0, content: 'מפגש בוקר', col_span: 1, row_span: 1 },
  ]);
  ok(!/>שונות<\/th>/.test(empty), 'שונות ריקה לא מודפסת');
  ok(/>מפגש<\/th>/.test(empty) && />סיפור<\/th>/.test(empty), 'והשורות האחרות כן, גם כשהן ריקות');
  const full = build([
    { row_key: 'misc', day_index: 2, content: 'להביא כובע', col_span: 1, row_span: 1 },
  ]);
  ok(/class="rl min"[^>]*>שונות<\/th>/.test(full), 'שונות עם תוכן מודפסת, מסומנת כקצרה');
  ok(rowCells(full, 'שונות').length === 6, 'עם ששת התאים שלה');
}

console.log('\nהורי שבת ושבוע סגור');
{
  const week = { ...weekWith([]), friday_parent_father: 'אבא של נועה', friday_parent_mother: 'אמא של אריאל' };
  const html = buildGanttPrintHtml({ weeks: [week], rows: ROWS, holidays: [], month: 9, year: 2026 });
  const meeting = html.split('<tr>').find(x => x.includes('>מפגש</th>')) || '';
  const fri = meeting.split('קבלת שבת')[1] || '';
  ok(/<div class="fp">אבא של נועה<\/div>/.test(fri) && /<div class="fp">אמא של אריאל<\/div>/.test(fri),
    'ההורים מתחת לקבלת שבת, כל אחד בשורה משלו');
  const strip = html.split('<tr class="strip">')[1].split('</tr>')[0];
  ok(!/אבא של נועה/.test(strip), 'ולא בשורת התאריכים');
  ok(!/אבא של שבת אבא/.test(html), 'בלי כפל "אבא של שבת אבא של"');

  const closed = buildGanttPrintHtml({
    weeks: [weekWith([])], rows: ROWS, month: 9, year: 2026,
    holidays: [{ name: 'סוכות', kind: 'closure', emoji: '🌿',
      start_date: '2026-08-30T00:00:00.000Z', end_date: '2026-09-06T00:00:00.000Z' }],
  });
  ok(/class="closedwk"/.test(closed) && /הגן סגור/.test(closed), 'שבוע שהגן סגור בו כולו יוצא כשורה אחת');
  ok(!/>מפגש<\/th>/.test(closed), 'בלי שורות התוכן');
}


console.log('\nיום מיוחד');
{
  const week = { ...weekWith([
    { row_key: 'story', day_index: 4, content: 'סיפור שלא יודפס', col_span: 1, row_span: 1 },
    { row_key: 'activity', day_index: 3, content: 'רחב', col_span: 3, row_span: 1 },
  ]), special_days: [{ day_index: 4, title: 'חגיגות ראש השנה', note: 'יש להגיע בחולצה לבנה', color: '#fef9c3' }] };
  const html = buildGanttPrintHtml({ weeks: [week], rows: ROWS, holidays: [], month: 9, year: 2026 });
  const specials = html.match(/<td class="special"[^>]*>/g) || [];
  ok(specials.length === 1 && /rowspan="4"/.test(specials[0]), 'תא אחד על כל גובה השבוע');
  ok(/<div class="st">חגיגות ראש השנה<\/div>/.test(html) && /<div class="sn">יש להגיע בחולצה לבנה<\/div>/.test(html),
    'כותרת ושורה מתחתיה');
  ok(!/סיפור שלא יודפס/.test(html), 'התיבות של היום מוסתרות');
  ok(/colspan="1"/.test(html) === false && rowCells(html, 'פעילות').length === 5,
    'איחוד שמגיע לעמודה המיוחדת נעצר לפניה');
  ok(/rowspan="1"/.test(html) === false, 'בלי תכונות מיותרות');
}

console.log(`\n${failures === 0 ? '✅ הכל עבר' : `❌ ${failures} נכשלו`}\n`);
process.exit(failures === 0 ? 0 : 1);
