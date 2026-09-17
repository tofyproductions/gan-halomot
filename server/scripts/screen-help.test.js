/**
 * Every screen carries its own help, and keeps carrying it.
 *
 * The content is written once and then the system keeps moving — a screen is
 * renamed, an id changes, a new screen joins the rail. None of that breaks
 * anything visibly: the "?" simply stops appearing, or appears over the wrong
 * page, and nobody notices because the people who would notice are the ones
 * who needed the help.
 *
 * So the coverage is asserted rather than assumed. A screen with no entry is
 * listed by name in the failure, which is the only way this file gets
 * finished.
 *
 *   node scripts/screen-help.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..', '..', 'client', 'src');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

/**
 * The two config files are ES modules the server cannot require, and they are
 * plain data. Reading them as text and pulling out what we need keeps this
 * suite dependency-free — the same trade the design-token ratchet makes.
 */
function tabIdsWithScreens() {
  const src = fs.readFileSync(path.join(CLIENT, 'config', 'tabs.js'), 'utf8');
  const ids = [];
  // Only tabs with a real path are screens. `path: null` entries are write
  // grants and permissions rows, and they have nothing to open help on.
  const re = /\{\s*id:\s*'([^']+)'[^}]*?path:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) ids.push({ id: m[1], path: m[2] });
  return ids;
}

function helpIds() {
  const src = fs.readFileSync(path.join(CLIENT, 'config', 'screenHelp.js'), 'utf8');
  const body = src.slice(src.indexOf('export const SCREEN_HELP'), src.indexOf('export const HELP_PENDING'));
  const ids = [];
  const re = /^\s{2}'?([a-z0-9_-]+)'?:\s*\{/gm;
  let m;
  while ((m = re.exec(body))) ids.push(m[1]);
  return ids;
}

const screens = tabIdsWithScreens();
const covered = helpIds();

console.log('\nthe registry points at real screens');

check('there are screens to document', () => assert.ok(screens.length > 10, `${screens.length}`));
check('every help entry names a screen that exists', () => {
  const known = new Set(screens.map(s => s.id));
  const strays = covered.filter(id => !known.has(id));
  assert.deepStrictEqual(strays, [], `help for screens that do not exist: ${strays.join(', ')}`);
});
check('no screen is documented twice', () =>
  assert.strictEqual(new Set(covered).size, covered.length));

console.log('\ncoverage');

const missing = screens.filter(s => !covered.includes(s.id));
console.log(`  ${covered.length} / ${screens.length} screens documented`);
if (missing.length) {
  console.log('  עוד ללא עזרה:');
  missing.forEach(s => console.log(`    ${s.id.padEnd(26)} ${s.path}`));
}
check('every screen in the rail has help', () =>
  assert.strictEqual(missing.length, 0,
    `${missing.length} screens with no help: ${missing.map(s => s.id).join(', ')}`));

console.log('\nthe content itself');

const src = fs.readFileSync(path.join(CLIENT, 'config', 'screenHelp.js'), 'utf8');

check('every summary is a sentence, not a placeholder', () => {
  const summaries = [...src.matchAll(/summary:\s*'([^']*)'/g)].map(m => m[1]);
  assert.strictEqual(summaries.length, covered.length, 'a screen has no summary');
  const short = summaries.filter(s => s.trim().length < 25);
  assert.deepStrictEqual(short, [], `summaries too short to help: ${short.join(' | ')}`);
});

check('no TODO left in the content', () =>
  assert.ok(!/TODO|TBD|להשלים/.test(src), 'placeholder text in the help'));

check('every question has an answer', () => {
  const qs = (src.match(/\bq:\s*'/g) || []).length;
  const as = (src.match(/\ba:\s*'/g) || []).length;
  assert.strictEqual(qs, as, `${qs} questions, ${as} answers`);
});

check('every named button says what it does', () => {
  const names = (src.match(/\bname:\s*'/g) || []).length;
  const whats = (src.match(/\bwhat:\s*'/g) || []).length;
  assert.strictEqual(names, whats, `${names} buttons, ${whats} explanations`);
});

// The help is read by people who are not programmers, in Hebrew, on a
// right-to-left screen. A Latin word inside a Hebrew sentence reorders on
// screen and the sentence becomes unreadable — the same rule the rest of this
// product's user-facing text follows.
check('no Latin words inside the Hebrew text', () => {
  const strings = [
    ...[...src.matchAll(/summary:\s*'([^']*)'/g)].map(m => m[1]),
    ...[...src.matchAll(/\ba:\s*'([^']*)'/g)].map(m => m[1]),
    ...[...src.matchAll(/\bwhat:\s*'([^']*)'/g)].map(m => m[1]),
  ];
  const bad = strings.filter(s => /[֐-׿]/.test(s) && /[A-Za-z]{3,}/.test(s));
  assert.deepStrictEqual(bad, [], `Hebrew sentences carrying Latin words:\n    ${bad.join('\n    ')}`);
});

console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
