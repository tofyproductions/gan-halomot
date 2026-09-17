/**
 * Pairing the live tab to the roster.
 *
 * `סדר יום` carries no name, no id and no date: a row is a child only because
 * it sits at the same offset as that child in `ילדים`. A blank row is a child
 * with nothing filled in yet, and it holds the alignment for everyone below
 * it. Dropping blank rows is the bug this file exists to prevent.
 *
 *   node scripts/sheet-sync-roster.test.js
 */
const assert = require('assert');
const { parseChildRows } = require('./lib/nursery-history');
const { pairRows } = require('../src/services/sheet-sync/roster');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

const childGrid = [
  ['ילדים - משה דיין', '', '', ''],
  ['שם מלא', 'תאריך לידה', 'AccessID', 'מספר פלאפון'],
  ['נויה חגי', 45897, 'id-1', '0500000000'],
  ['עידו גבריאל דורני', 45917, 'id-2', '0500000000'],
  ['ליה לוין', 45887, 'id-3', '0500000000'],
  ['יובל ראובני', 45895, 'id-4', '0500000000'],
];

// ליה לוין's row is blank — she is at the gan and nobody has filled her in.
const todayGrid = [
  ['סדר יום - גן החלומות'],
  ['התעורר בבית', 'אכל בבית - שעה', 'אכל בבית - כמות', 'ארוחת בוקר'],
  [0.25, 0.2604166666666667, '180 מ״ל', ''],
  [0.2291666666666667, 0.2395833333333333, '210', ''],
  ['', '', '', ''],
  [0.28125, 0.25, '180', ''],
];

console.log('\nparseChildRows — the absolute row index travels with the child');
check('four children', () => assert.strictEqual(parseChildRows(childGrid).length, 4));
check('first child is on grid row 2', () => assert.strictEqual(parseChildRows(childGrid)[0].row, 2));
check('fourth child is on grid row 5', () => assert.strictEqual(parseChildRows(childGrid)[3].row, 5));
check('access ids survive', () => assert.strictEqual(parseChildRows(childGrid)[3].access_id, 'id-4'));

console.log('\npairRows — a blank middle row keeps everyone below it in place');
const paired = pairRows({ childRows: parseChildRows(childGrid), childGrid, todayRows: todayGrid });
check('no errors', () => assert.deepStrictEqual(paired.errors, []));
check('four pairs', () => assert.strictEqual(paired.pairs.length, 4));
check('ליה לוין pairs to the blank row', () => {
  const lia = paired.pairs.find(p => p.access_id === 'id-3');
  assert.strictEqual(lia.values['התעורר בבית'], '');
});
check('יובל ראובני keeps her own 06:45, not the row above', () => {
  const yuval = paired.pairs.find(p => p.access_id === 'id-4');
  assert.strictEqual(yuval.values['התעורר בבית'], 0.28125);
});

console.log('\npairRows — it refuses rather than guesses');
check('fewer day rows than children is an error, not a partial pairing', () => {
  const short = pairRows({ childRows: parseChildRows(childGrid), childGrid, todayRows: todayGrid.slice(0, 4) });
  assert.strictEqual(short.pairs.length, 0);
  assert.ok(/rows/.test(short.errors[0]));
});

// `values` is keyed by the normalized header name, so on a repeat the last
// column wins the read — while anything finding that column again by name
// lands on the first. A caller would then read one cell and write another.
// The headers are typed into wrapped cells and this normalizes whitespace, so
// the collision is one live edit away.
check('two columns that normalize to one name are refused, not resolved', () => {
  const collided = [
    ['סדר יום - גן החלומות'],
    ['התעורר בבית', 'הערות', 'הערות\n', 'ארוחת בוקר'],
    ['', '', 'ישן טוב', ''],
    ['', '', '', ''],
    ['', '', '', ''],
    ['', '', '', ''],
  ];
  const clash = pairRows({ childRows: parseChildRows(childGrid), childGrid, todayRows: collided });
  assert.strictEqual(clash.pairs.length, 0);
  assert.ok(/הערות/.test(clash.errors[0]));
});

console.log('\npairRows — the header travels with the pairs');
check('the header it keyed the values by comes back', () => {
  assert.deepStrictEqual(paired.header, ['התעורר בבית', 'אכל בבית - שעה', 'אכל בבית - כמות', 'ארוחת בוקר']);
});
check('and so does the row it was found on', () => assert.strictEqual(paired.headerIndex, 1));
check('every paired row sits below that header', () => {
  assert.ok(paired.pairs.every(p => p.row > paired.headerIndex));
});

// A gap BEFORE the first named child — an empty slot nobody has been put in
// yet, sitting between the roster header and נויה. Anchoring on the first
// named child's row instead of on the roster's own header would shift every
// child up by one and hand נויה's day to עידו — the exact bug this covers.
const childGridWithGap = [
  ['ילדים - משה דיין', '', '', ''],
  ['שם מלא', 'תאריך לידה', 'AccessID', 'מספר פלאפון'],
  ['', '', '', ''],
  ['נויה חגי', 45897, 'id-1', '0500000000'],
  ['עידו גבריאל דורני', 45917, 'id-2', '0500000000'],
];
const todayGridWithGap = [
  ['סדר יום - גן החלומות'],
  ['התעורר בבית', 'אכל בבית - שעה', 'אכל בבית - כמות', 'ארוחת בוקר'],
  ['', '', '', ''],
  [0.25, 0.2604166666666667, '180 מ״ל', ''],
  [0.2291666666666667, 0.2395833333333333, '210', ''],
];

console.log('\npairRows — a blank slot BEFORE the first named child does not shift anyone');
const gapped = pairRows({
  childRows: parseChildRows(childGridWithGap),
  childGrid: childGridWithGap,
  todayRows: todayGridWithGap,
});
check('no errors', () => assert.deepStrictEqual(gapped.errors, []));
check('two pairs', () => assert.strictEqual(gapped.pairs.length, 2));
check('נויה keeps her own 06:00, not the blank slot above her', () => {
  const noya = gapped.pairs.find(p => p.access_id === 'id-1');
  assert.strictEqual(noya.values['התעורר בבית'], 0.25);
});
check('עידו keeps his own 05:30, not נויה\'s', () => {
  const ido = gapped.pairs.find(p => p.access_id === 'id-2');
  assert.strictEqual(ido.values['התעורר בבית'], 0.2291666666666667);
});

// The roster carries two title rows above its header; the live tab carries
// only one. The two headers sit at different absolute indices on purpose —
// pairing has to anchor each tab on its OWN header, not assume they line up.
const childGridTwoTitles = [
  ['ילדים - משה דיין', '', '', ''],
  ['עוד שורת כותרת', '', '', ''],
  ['שם מלא', 'תאריך לידה', 'AccessID', 'מספר פלאפון'],
  ['נויה חגי', 45897, 'id-1', '0500000000'],
  ['עידו גבריאל דורני', 45917, 'id-2', '0500000000'],
];
const todayGridOneTitle = [
  ['סדר יום - גן החלומות'],
  ['התעורר בבית', 'אכל בבית - שעה', 'אכל בבית - כמות', 'ארוחת בוקר'],
  [0.25, 0.2604166666666667, '180 מ״ל', ''],
  [0.2291666666666667, 0.2395833333333333, '210', ''],
];

console.log('\npairRows — the two tabs\' headers do not have to sit at the same row');
const offsetHeaders = pairRows({
  childRows: parseChildRows(childGridTwoTitles),
  childGrid: childGridTwoTitles,
  todayRows: todayGridOneTitle,
});
check('no errors', () => assert.deepStrictEqual(offsetHeaders.errors, []));
check('two pairs', () => assert.strictEqual(offsetHeaders.pairs.length, 2));
check('נויה pairs to her own row despite the extra title row', () => {
  const noya = offsetHeaders.pairs.find(p => p.access_id === 'id-1');
  assert.strictEqual(noya.values['התעורר בבית'], 0.25);
});
check('עידו pairs to his own row despite the extra title row', () => {
  const ido = offsetHeaders.pairs.find(p => p.access_id === 'id-2');
  assert.strictEqual(ido.values['התעורר בבית'], 0.2291666666666667);
});

const { a1 } = require('../src/services/sheet-sync/sheets-client');
console.log('\na1 — ranges, including the Hebrew tab name');
check('first cell', () => assert.strictEqual(a1('סדר יום', 0, 0), "'סדר יום'!A1"));
check('column D, row 5', () => assert.strictEqual(a1('סדר יום', 4, 3), "'סדר יום'!D5"));
check('past Z', () => assert.strictEqual(a1('ילדים', 0, 26), "'ילדים'!AA1"));
check('the seventeenth column is Q', () => assert.strictEqual(a1('סדר יום', 1, 16), "'סדר יום'!Q2"));

console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
