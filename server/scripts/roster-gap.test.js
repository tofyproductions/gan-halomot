/**
 * The roster the gan keeps, against the cards here.
 *
 * `Child` is downstream of registration and it drifts: a card is created when
 * somebody gets to it, its year is stamped once and never revisited, and a
 * year later the roster has moved on without it. In קפלן that meant 31
 * registrations for the current year, four children with no card at all — two
 * of them already enrolled — and three cards nobody had registered.
 *
 * The comparison is what this screen IS, so what is asserted here is mostly
 * the ways it can be wrong: a child with a card for every year she has been
 * here is not missing one, two cards claiming the same year is not the same
 * problem as no card, and a name that nearly matches is a hint and never an
 * answer.
 *
 *   node scripts/roster-gap.test.js
 */
const assert = require('assert');
const { compareRoster, KINDS } = require('../src/services/roster-gap');
const { normalizeChildName } = require('../src/services/academic-year.service');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

const YEAR = '2026-2027';
const run = (roster, cards) => compareRoster({
  source: 'registration', roster, cards, year: YEAR, normalize: normalizeChildName,
});
const kindsOf = (r, kind) => r.findings.filter((f) => f.kind === kind);

const card = (name, year, extra = {}) => ({
  id: `c-${name}-${year}`, name, academic_year: year, classroom_name: 'צעירים', ...extra,
});
const reg = (name, extra = {}) => ({ id: `r-${name}`, name, status: 'completed', ...extra });

console.log('\nthe agreement that needs no report');

check('a registration with a card for this year is not a finding', () => {
  const r = run([reg('נדיה גרוס')], [card('נדיה גרוס', YEAR)]);
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.matched, 1);
});

check('a child with a card for EVERY year she has been here is fine', () => {
  // This was the file's first bug: it counted her as having no card, and
  // turned four genuinely missing cards in קפלן into nineteen.
  const r = run([reg('ארי טלמור')], [card('ארי טלמור', '2024-2025'), card('ארי טלמור', '2025-2026'), card('ארי טלמור', YEAR)]);
  assert.deepStrictEqual(r.findings, [], JSON.stringify(r.findings));
  assert.strictEqual(r.matched, 1);
});

check('a name spelled with a gershayim matches one without', () =>
  assert.deepStrictEqual(run([reg('ארי "טל" מור')], [card('ארי טל מור', YEAR)]).findings, []));

console.log('\nthe three disagreements');

check('no card anywhere', () => {
  const r = run([reg('אורי אדיב')], []);
  const f = kindsOf(r, KINDS.NO_CARD);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].name, 'אורי אדיב');
  assert.strictEqual(f[0].card_id, null);
});

check('a card that still says last year', () => {
  const r = run([reg('לני סטופר')], [card('לני סטופר', '2025-2026')]);
  const f = kindsOf(r, KINDS.STALE_YEAR);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].card_year, '2025-2026');
  assert.ok(f[0].card_id, 'the stale finding must carry the card it is about');
});

check('a current-year card nobody registered', () => {
  const r = run([], [card('עמליה', YEAR)]);
  const f = kindsOf(r, KINDS.ORPHAN_CARD);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].name, 'עמליה');
});

check('an OLD card nobody registered is not an orphan — it is her history', () =>
  assert.deepStrictEqual(run([], [card('מי שעזבה', '2025-2026')]).findings, []));

console.log('\ntwo cards for one year is its own problem');

check('reported as a duplicate, not as a missing card', () => {
  const r = run([reg('ינאי משה אלון')], [
    { ...card('ינאי משה אלון', YEAR), id: 'c-a' },
    { ...card('ינאי משה אלון', YEAR), id: 'c-b' },
  ]);
  assert.strictEqual(kindsOf(r, KINDS.NO_CARD).length, 0);
  const d = kindsOf(r, KINDS.DUPLICATE_CARD);
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].ambiguous.length, 2, 'both cards must be named');
});

check('neither duplicate is then also reported as an orphan', () => {
  const r = run([reg('ינאי משה אלון')], [
    { ...card('ינאי משה אלון', YEAR), id: 'c-a' },
    { ...card('ינאי משה אלון', YEAR), id: 'c-b' },
  ]);
  assert.strictEqual(kindsOf(r, KINDS.ORPHAN_CARD).length, 0);
});

check('a duplicate is not counted as matched', () => {
  const r = run([reg('ינאי משה אלון')], [
    { ...card('ינאי משה אלון', YEAR), id: 'c-a' },
    { ...card('ינאי משה אלון', YEAR), id: 'c-b' },
  ]);
  assert.strictEqual(r.matched, 0);
});

console.log('\na roster that lists one child twice');

check('is reported, and the count says how many times', () => {
  const r = run([reg('ינאי משה אלון'), { ...reg('ינאי משה אלון'), id: 'r2', status: 'link_generated' }], [card('ינאי משה אלון', YEAR)]);
  assert.strictEqual(r.duplicates.length, 1);
  assert.strictEqual(r.duplicates[0].count, 2);
});

console.log('\nthe hint, which is a hint');

check('a one-letter difference is offered', () => {
  const r = run([reg('יהונתן דויד לוי')], [card('יהונתן דוד לוי', YEAR)]);
  const f = kindsOf(r, KINDS.NO_CARD)[0];
  assert.ok(f.maybe, 'no hint offered');
  assert.strictEqual(f.maybe[0].name, 'יהונתן דוד לוי');
});

check('a full name against a short one is offered', () => {
  const r = run([reg('עמליה שקורי')], [card('עמליה', YEAR)]);
  assert.ok(kindsOf(r, KINDS.NO_CARD)[0].maybe, 'no hint offered');
});

check('but a different child is not', () => {
  const r = run([reg('אורי אדיב')], [card('רומי סבח', YEAR)]);
  assert.strictEqual(kindsOf(r, KINDS.NO_CARD)[0].maybe, undefined);
});

check('two letters apart is not a hint — that is a guess', () => {
  const r = run([reg('דניאל')], [card('דנילו', YEAR)]);
  assert.strictEqual(kindsOf(r, KINDS.NO_CARD)[0].maybe, undefined);
});

check('the hint never removes the finding — a person still decides', () => {
  const r = run([reg('יהונתן דויד לוי')], [card('יהונתן דוד לוי', YEAR)]);
  assert.strictEqual(kindsOf(r, KINDS.NO_CARD).length, 1);
  assert.strictEqual(kindsOf(r, KINDS.ORPHAN_CARD).length, 1);
});

console.log('\nthe shape the screen counts on');

check('empty everything does not throw', () => {
  const r = run([], []);
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.matched, 0);
});

check('a nameless row is skipped rather than matched to another nameless row', () => {
  const r = run([reg('')], [card('', YEAR)]);
  assert.strictEqual(kindsOf(r, KINDS.DUPLICATE_CARD).length, 0);
});

check('counts agree with the findings', () => {
  const r = run(
    [reg('אורי אדיב'), reg('לני סטופר'), reg('נדיה גרוס')],
    [card('לני סטופר', '2025-2026'), card('נדיה גרוס', YEAR), card('עמליה', YEAR)],
  );
  assert.strictEqual(r.counts[KINDS.NO_CARD], 1);
  assert.strictEqual(r.counts[KINDS.STALE_YEAR], 1);
  assert.strictEqual(r.counts[KINDS.ORPHAN_CARD], 1);
  assert.strictEqual(r.matched, 1);
});

console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
