#!/usr/bin/env node
/**
 * One month for every room, as one document.
 *
 * The office prints the same month for every room in the gan. The document
 * that does it holds one sheet per room, each starting on a page of its own
 * and each fitted to its page by itself — a quiet plan must not be printed in
 * the type a crowded one needed.
 *
 * Loaded the same way as gantt-print-merge.test.js: the real client file, its
 * one import stripped and COLOR answered by a stub.
 *
 *   node scripts/gantt-multi-print.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '../../client/src/components/gantt/ganttPrint.js');
const code = fs.readFileSync(SRC, 'utf8')
  .replace(/^import[\s\S]*?;$/gm, '')
  .replace(/^export /gm, '');
const anyColor = new Proxy({}, {
  get: (_t, k) => (k === Symbol.toPrimitive || k === 'toString' ? () => '#000000' : anyColor),
});
const COLOR = anyColor;
const sandbox = { module: {}, exports: {}, console, Date, Math, Number, String, Set, Intl, COLOR };
vm.createContext(sandbox);
vm.runInContext(`${code}\n;module.exports = { buildGanttPrintHtml, buildMultiGanttPrintHtml, ganttSheetHtml, ganttPrintCss };`, sandbox);
const { buildGanttPrintHtml, buildMultiGanttPrintHtml, ganttSheetHtml, ganttPrintCss } = sandbox.module.exports;

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const count = (s, re) => (s.match(re) || []).length;

const ROWS = [
  { key: 'meeting', label: 'מפגש' },
  { key: 'activity', label: 'פעילות' },
  { key: 'story', label: 'סיפור' },
];
const sheet = (classroomName, content) => ({
  weeks: [{
    week_number: 1, topic: 'הסתגלות', start_date: '2026-08-30T00:00:00.000Z',
    cells: [{ row_key: 'meeting', day_index: 1, content, col_span: 1, row_span: 1 }],
  }],
  rows: ROWS, holidays: [], month: 9, year: 2026, classroomName, branchName: 'כפר סבא', status: 'approved',
});
const a = sheet('בוגרים', 'מפגש בוגרים');
const b = sheet('צעירים', 'מפגש צעירים');

console.log('\n🖨️  חודש אחד לכל הכיתות\n');

console.log('מסמך אחד, שני דפים');
{
  const html = buildMultiGanttPrintHtml({ sheets: [a, b] });
  ok(count(html, /<section class="sheet"/g) === 2, 'שני דפים במסמך');
  ok(count(html, /break-after: page/g) === 1, 'כלל מעבר עמוד אחד');
  ok(/section\.sheet:not\(:last-of-type\)\s*\{\s*break-after: page; page-break-after: always;/.test(html),
    'ואחרי הדף האחרון אין מעבר עמוד');
  ok(html.indexOf('מפגש בוגרים') < html.indexOf('מפגש צעירים'), 'הדפים בסדר שנמסר');
  ok(/<title>תוכניות עבודה - ספטמבר 2026 - 2 כיתות<\/title>/.test(html), 'כותרת החלון: חודש, שנה ומספר כיתות');
  ok(!/תמונה לוואטסאפ/.test(html), 'בלי כפתור וואטסאפ');
  ok(/הדפס \/ שמור כ-PDF/.test(html) && /__ganttPages/.test(html), 'יש הדפסה ומתג עמודים');
  ok(count(html, /<script>/g) === 1, 'סקריפט התאמה אחד');
  ok(/querySelectorAll\('section\.sheet'\)/.test(html) && /function fit\(sheet\)/.test(html),
    'שמתאים כל דף בנפרד');
  ok(/sheet\.style\.setProperty/.test(html) && !/documentElement/.test(html),
    'ומשנה את קנה המידה על הדף, לא על המסמך');
  ok(/BUDGET = 1/.test(html), 'עמוד אחד לכל דף כברירת מחדל');
  ok(/BUDGET = 2/.test(buildMultiGanttPrintHtml({ sheets: [a, b], pages: 2 })), 'ושניים כשמבקשים');
}

console.log('\nהדף הבודד לא השתנה');
{
  const single = buildGanttPrintHtml({ ...a, mode: 'print', pages: 1 });
  ok(count(single, /<section class="sheet"/g) === 1, 'דף אחד עטוף ב-section');
  ok(single.includes(ganttSheetHtml(a)), 'הוא אותו דף שהמסמך המרובה בונה');
  ok(single.includes(`<style>${ganttPrintCss({ image: false })}</style>`), 'עם אותו עיצוב');
  ok(/\.sheet \{ --k: 1;/.test(single), 'קנה המידה מוגדר על הדף');
  ok(/תמונה לוואטסאפ/.test(single), 'וכפתור הוואטסאפ נשאר בהדפסה של כיתה אחת');
  ok(!/break-after: page/.test(single), 'בלי מעבר עמוד');
}

console.log(`\n${failures === 0 ? '✅ הכל עבר' : `❌ ${failures} נכשלו`}\n`);
process.exit(failures === 0 ? 0 : 1);
