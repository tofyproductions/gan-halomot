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
const paired = pairRows({ childRows: parseChildRows(childGrid), todayRows: todayGrid });
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
  const short = pairRows({ childRows: parseChildRows(childGrid), todayRows: todayGrid.slice(0, 4) });
  assert.strictEqual(short.pairs.length, 0);
  assert.ok(/rows/.test(short.errors[0]));
});

console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
