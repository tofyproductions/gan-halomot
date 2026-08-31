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
const code = fs.readFileSync(SRC, 'utf8').replace(/^export /gm, '');
const sandbox = { module: {}, exports: {}, console, Date, Math, Number, String, Set, Intl };
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

console.log(`\n${failures === 0 ? '✅ הכל עבר' : `❌ ${failures} נכשלו`}\n`);
process.exit(failures === 0 ? 0 : 1);
