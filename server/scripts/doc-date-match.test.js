#!/usr/bin/env node
/**
 * Dates hiding in document names — the matcher that attaches a certificate to
 * a pregnancy-exam entry by the date its FILENAME carries.
 *
 * The stakes: a wrong auto-attachment puts somebody else's medical document on
 * an exam entry. So the matcher must find real dates in the office's actual
 * naming styles, refuse ambiguous fragments ("08.26" — month.year, no day),
 * refuse digit runs that are actually a תעודת זהות, and attach only when
 * exactly ONE document matches the date.
 *
 *   node scripts/doc-date-match.test.js
 */

const { datesInText, findDocumentForDate } = require('../src/services/docDateMatch');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('datesInText — the office\'s real naming styles');
{
  check('Israeli DD.MM.YY: "אישור ביקור רופא 06.08.26"',
    eq(datesInText('הדר שם טוב-אישור ביקור רופא 06.08.26'), ['2026-08-06']));
  check('date glued to text: "רופאpdfא09.08.26"',
    eq(datesInText('הדר שם טוב-אישור ביקור רופאpdfא09.08.26'), ['2026-08-09']));
  check('ISO: "אישור בדיקת הריון 2026-07-06"',
    eq(datesInText('אישור בדיקת הריון 2026-07-06'), ['2026-07-06']));
  check('full year DD.MM.YYYY', eq(datesInText('אישור 06.08.2026'), ['2026-08-06']));
  check('slashes DD/MM/YY', eq(datesInText('ביקור 06/08/26'), ['2026-08-06']));
}

console.log('datesInText — what must NOT look like a date');
{
  check('month.year with no day ("08.26") matches nothing',
    datesInText('הדר שם טוב-אישור ביקור רופא 08.26').length === 0);
  check('a תעודת זהות is not a date', datesInText('רותם גרשון-036711315-טופס').length === 0);
  check('a phone number is not a date', datesInText('לחזור ל-0521234567').length === 0);
  check('form-101 year is not a date', datesInText('טופס 101 2026').length === 0);
  check('empty / null are quiet', datesInText('').length === 0 && datesInText(null).length === 0);
}

console.log('findDocumentForDate — attach only on a single unambiguous hit');
{
  const docs = [
    { name: 'הדר שם טוב-אישור ביקור רופא 06.08.26', file_name: 'a.pdf' },
    { name: 'הדר שם טוב-אישור ביקור רופאpdfא09.08.26', file_name: 'b.pdf' },
    { name: 'הדר שם טוב-אישור ביקור רופא 08.26', file_name: 'c.pdf' }, // no day — never a candidate
    { name: 'אישור בדיקת הריון 2026-07-06', file_name: 'd.pdf' },
  ];
  check('06.08 finds its file', findDocumentForDate(docs, '2026-08-06')?.file_name === 'a.pdf');
  check('09.08 finds its file even with the glued name', findDocumentForDate(docs, '2026-08-09')?.file_name === 'b.pdf');
  check('ISO-named July file found', findDocumentForDate(docs, '2026-07-06')?.file_name === 'd.pdf');
  check('a date no file carries → null', findDocumentForDate(docs, '2026-08-13') === null);

  const dupes = [
    { name: 'אישור 06.08.26 בוקר', file_name: '' },
    { name: 'אישור 06.08.26 צהריים', file_name: '' },
  ];
  check('TWO files with the same date → null (a human must pick)',
    findDocumentForDate(dupes, '2026-08-06') === null);
  check('empty doc list → null', findDocumentForDate([], '2026-08-06') === null);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll doc-date-match checks passed.');
