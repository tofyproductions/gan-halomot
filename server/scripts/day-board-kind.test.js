/**
 * Which rooms keep which board.
 *
 * Everything about the daily day hangs on this one function: get it wrong in
 * the permissive direction and a four-year-old's parent is shown an empty
 * bottle log; wrong in the other and an infant room loses the morning form its
 * families have used for years.
 *
 * בוגרים RETURNED 'light' UNTIL 22.09.2026 AND NOW RETURNS 'none'. That is
 * a decision, not a regression, and it is written here so the next person to
 * see this test does not "fix" it back. The light board was extended to the
 * older rooms so their families would see something rather than nothing; in
 * practice nobody filled it, and a "היום בגן" that is permanently blank
 * reads to a parent as "the gan recorded nothing today" — a complaint about
 * staff who did nothing wrong. The staff screen was paying for it too: half
 * its dropdown was rooms nobody opens.
 *
 * Pure — no database. It reads a classroom object, and that is the only input.
 *
 *   node scripts/day-board-kind.test.js
 */

const assert = require('assert');
const nursery = require('../src/services/nursery.service');

let failures = 0;
function check(label, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
    console.log(`  ✓ ${label}`);
  } catch {
    failures += 1;
    console.log(`  ✗ ${label} — expected ${expected}, got ${actual}`);
  }
}

console.log('\nboardKind — the category decides when it is set');
check('תינוקייה → full', nursery.boardKind({ category: 'תינוקייה', name: 'כל דבר' }), 'full');
check('צעירים → full', nursery.boardKind({ category: 'צעירים', name: 'כל דבר' }), 'full');
check('בוגרים → none', nursery.boardKind({ category: 'בוגרים', name: 'תינוקייה א' }), 'none');

console.log('\nboardKind — the name decides when the category is empty');
check('"תינוקייה ב" → full', nursery.boardKind({ name: 'תינוקייה ב' }), 'full');
check('"צעירים א" → full', nursery.boardKind({ name: 'צעירים א' }), 'full');
check('"בוגרים ג" → none', nursery.boardKind({ name: 'בוגרים ג' }), 'none');

console.log('\nboardKind — anything it cannot read falls to the light board');
// Deliberately NOT 'none'. An unlabelled room is far more likely to be one
// somebody never categorised than a בוגרים room in disguise, and hiding a
// real class over a blank field is the expensive mistake of the two.
check('unknown name → light', nursery.boardKind({ name: 'כיתת הפרפרים' }), 'light');
check('no classroom → light', nursery.boardKind(null), 'light');
check('empty object → light', nursery.boardKind({}), 'light');

console.log('\nבוגרים is the ONLY category that loses its board');
check('פעוטות-style name keeps a board', nursery.boardKind({ name: 'פעוטות 25' }) !== 'none', true);
check('a צעירים room keeps its full board', nursery.boardKind({ category: 'צעירים' }), 'full');
check('"בוגרים 30" reads as בוגרים', nursery.boardKind({ name: 'בוגרים 30' }), 'none');

console.log('\nthe infant check itself is unchanged — צעירים is NOT a תינוקייה');
check('צעירים is not nursery', nursery.isNurseryClassroom({ category: 'צעירים' }), false);
check('תינוקייה is nursery', nursery.isNurseryClassroom({ category: 'תינוקייה' }), true);

console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
