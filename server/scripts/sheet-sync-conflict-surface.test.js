/**
 * Every field the sync can overrule is shown to somebody.
 *
 * The conflict policy is the one thing standing between this feature and a
 * silent deletion: the sheet wins the field, our value is kept on the log, and
 * a person in the room settles it by seeing both. A field whose conflict note
 * is rendered on no screen breaks that whole chain — the value is stored,
 * displayed nowhere, and dropped the next time anybody edits the field. From
 * every human's point of view it was deleted silently, which is the precise
 * failure the policy exists to prevent.
 *
 * Five of the eighteen were in exactly that state: `attendance` and the four
 * `home.*` fields the parent writes. The staff board renders the rest, so the
 * gap was invisible to every other test in this suite, which is why this one
 * reads the card's source and asks about every field `merge` can produce a
 * conflict for rather than about the thirteen somebody remembered.
 *
 *   node scripts/sheet-sync-conflict-surface.test.js
 */
const fs = require('fs');
const path = require('path');
const { FIELD_MAP } = require('./lib/nursery-history');

const CARD = path.join(__dirname, '..', '..', 'client', 'src', 'components', 'nursery', 'ChildDayCard.jsx');

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}`); }
}

const src = fs.readFileSync(CARD, 'utf8');

// The card renders three meals and two sleeps from one template each, so the
// paths are spelled `meals.${key}.amount`, not literally. Expanding them here
// is what lets this ask about a path rather than about a line of JSX.
let expanded = '';
for (const meal of ['breakfast', 'lunch', 'snack']) {
  for (const nap of ['morning', 'noon']) {
    expanded += src.split('${key}').join(meal).split('${hoursKey}').join(nap);
  }
}

const paths = Object.values(FIELD_MAP).map(def => def.path);

console.log('\nevery conflict-capable field is rendered somewhere on the staff board');
for (const p of paths) {
  const asNote = new RegExp(`conflictNote\\(['\`]${p.replace(/\./g, '\\.')}['\`]\\)`).test(expanded);
  // The four fields the parent owns are read-only on this board, so they are
  // not rendered beside an editable control — they are listed under the
  // "מההורים, מהבית" block, keyed by path.
  const asHomeLabel = new RegExp(`'${p.replace(/\./g, '\\.')}':`).test(expanded);
  ok(asNote || asHomeLabel, p);
}

console.log('\nand the parent portal is left alone — a parent is not shown the gan\'s sync mechanics');
const PORTAL = path.join(__dirname, '..', '..', 'client', 'src', 'components', 'parent-portal');
function jsxFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (
    e.isDirectory() ? jsxFiles(path.join(dir, e.name))
      : (e.name.endsWith('.jsx') ? [path.join(dir, e.name)] : [])
  ));
}
const portalMentions = jsxFiles(PORTAL).filter(f => /sync_conflicts/.test(fs.readFileSync(f, 'utf8')));
ok(portalMentions.length === 0, `no portal screen renders sync_conflicts${portalMentions.length ? ` (${portalMentions.join(', ')})` : ''}`);

console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
