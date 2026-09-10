/**
 * Which rooms keep which board.
 *
 * The whole of feature "היום בגן לכל הילדים" hangs on this one function: get it
 * wrong in the permissive direction and a four-year-old's parent is shown an
 * empty bottle log; wrong in the other and an infant room loses the morning
 * form its families have used for years.
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
check('בוגרים → light', nursery.boardKind({ category: 'בוגרים', name: 'תינוקייה א' }), 'light');

console.log('\nboardKind — the name decides when the category is empty');
check('"תינוקייה ב" → full', nursery.boardKind({ name: 'תינוקייה ב' }), 'full');
check('"צעירים א" → full', nursery.boardKind({ name: 'צעירים א' }), 'full');
check('"בוגרים ג" → light', nursery.boardKind({ name: 'בוגרים ג' }), 'light');

console.log('\nboardKind — anything it cannot read falls to the light board');
check('unknown name → light', nursery.boardKind({ name: 'כיתת הפרפרים' }), 'light');
check('no classroom → light', nursery.boardKind(null), 'light');
check('empty object → light', nursery.boardKind({}), 'light');

console.log('\nthe infant check itself is unchanged — צעירים is NOT a תינוקייה');
check('צעירים is not nursery', nursery.isNurseryClassroom({ category: 'צעירים' }), false);
check('תינוקייה is nursery', nursery.isNurseryClassroom({ category: 'תינוקייה' }), true);

console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
