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
check('צעירים → none', nursery.boardKind({ category: 'צעירים', name: 'כל דבר' }), 'none');
check('בוגרים → none', nursery.boardKind({ category: 'בוגרים', name: 'תינוקייה א' }), 'none');

console.log('\nboardKind — the name decides when the category is empty');
check('"תינוקייה ב" → full', nursery.boardKind({ name: 'תינוקייה ב' }), 'full');
check('"צעירים א" → none', nursery.boardKind({ name: 'צעירים א' }), 'none');
check('"בוגרים ג" → none', nursery.boardKind({ name: 'בוגרים ג' }), 'none');

console.log('\nboardKind — anything it cannot read falls to the light board');
// Deliberately NOT 'none'. An unlabelled room is far more likely to be one
// somebody never categorised than a בוגרים room in disguise, and hiding a
// real class over a blank field is the expensive mistake of the two.
check('unknown name → light', nursery.boardKind({ name: 'כיתת הפרפרים' }), 'light');
check('no classroom → light', nursery.boardKind(null), 'light');
check('empty object → light', nursery.boardKind({}), 'light');

console.log('\nonly תינוקייה keeps a board — צעירים joined בוגרים on 22.09.2026');
// The gan corrected this the same day צעירים had been given a full board: the
// board is a תינוקייה thing, and a פעוט whose family still wants the day is
// CARRIED on the תינוקייה board by name — see boardKindForChild below.
check('פעוטות-style name (no category) still falls to light', nursery.boardKind({ name: 'פעוטות 25' }), 'light');
check('a צעירים room has no board', nursery.boardKind({ category: 'צעירים' }), 'none');
check('"בוגרים 30" reads as בוגרים', nursery.boardKind({ name: 'בוגרים 30' }), 'none');

console.log('\nboardKindForChild — the extension wins while it runs');
const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
const nursRoom = { category: 'תינוקייה' };
const olderRoom = { category: 'צעירים' };
const carried = { board_extension: { classroom_id: 'room-x', until: tomorrow } };
const lapsed = { board_extension: { classroom_id: 'room-x', until: yesterday } };
check('פעוט carried on the board → full', nursery.boardKindForChild(carried, olderRoom), 'full');
check('פעוט whose extension lapsed → none', nursery.boardKindForChild(lapsed, olderRoom), 'none');
check('פעוט never carried → none', nursery.boardKindForChild({}, olderRoom), 'none');
check('a תינוקייה child needs no extension', nursery.boardKindForChild({}, nursRoom), 'full');
check('no child at all → the room decides', nursery.boardKindForChild(null, nursRoom), 'full');
check('extension with no date is not active', nursery.extensionActive({ board_extension: { classroom_id: 'x', until: null } }), false);
check('extension ending today is still active', nursery.extensionActive({ board_extension: { classroom_id: 'x', until: new Date() } }), true);

console.log('\nthe infant check itself is unchanged — צעירים is NOT a תינוקייה');
check('צעירים is not nursery', nursery.isNurseryClassroom({ category: 'צעירים' }), false);
check('תינוקייה is nursery', nursery.isNurseryClassroom({ category: 'תינוקייה' }), true);

console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
