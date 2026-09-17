/**
 * The merge core.
 *
 * Three sides, not two: without a shadow of what the sheet held last pass, a
 * differing value is unclassifiable — "they changed it" and "we changed it"
 * look identical, and copying either way destroys a real edit silently.
 *
 *   node scripts/sheet-sync-three-way.test.js
 */
const assert = require('assert');
const { merge } = require('../src/services/sheet-sync/three-way');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

console.log('\nthe four cases');

check('nobody changed it → nothing moves', () => {
  const r = merge({ sheet: { 'diapers': '1' }, ours: { 'diapers': '1' }, shadow: { 'diapers': '1' } });
  assert.deepStrictEqual(r.toOurs, {});
  assert.deepStrictEqual(r.toSheet, {});
  assert.deepStrictEqual(r.conflicts, []);
});

check('the sheet changed it → copy in', () => {
  const r = merge({ sheet: { 'diapers': '2' }, ours: { 'diapers': '1' }, shadow: { 'diapers': '1' } });
  assert.deepStrictEqual(r.toOurs, { 'diapers': '2' });
  assert.deepStrictEqual(r.toSheet, {});
});

check('we changed it → copy out', () => {
  const r = merge({ sheet: { 'diapers': '1' }, ours: { 'diapers': '3' }, shadow: { 'diapers': '1' } });
  assert.deepStrictEqual(r.toSheet, { 'diapers': '3' });
  assert.deepStrictEqual(r.toOurs, {});
});

check('both changed it → the sheet wins, ours is kept', () => {
  const r = merge({
    sheet: { 'meals.breakfast.amount': '100%' },
    ours: { 'meals.breakfast.amount': '50%' },
    shadow: { 'meals.breakfast.amount': '' },
  });
  assert.deepStrictEqual(r.toOurs, { 'meals.breakfast.amount': '100%' });
  assert.deepStrictEqual(r.toSheet, {});
  assert.deepStrictEqual(r.conflicts, [
    { field: 'meals.breakfast.amount', sheet: '100%', ours: '50%' },
  ]);
});

console.log('\nthe first pass, when there is no shadow at all');

check('an empty shadow does not turn every field into a conflict', () => {
  const r = merge({
    sheet: { 'home.wake_time': '06:15', 'diapers': '' },
    ours: { 'home.wake_time': '', 'diapers': '' },
    shadow: {},
  });
  assert.deepStrictEqual(r.toOurs, { 'home.wake_time': '06:15' });
  assert.deepStrictEqual(r.conflicts, []);
});

console.log('\nemptiness');

check('a field the sheet cleared is a change, not an absence', () => {
  const r = merge({ sheet: { 'staff_note': '' }, ours: { 'staff_note': 'ישן טוב' }, shadow: { 'staff_note': 'ישן טוב' } });
  assert.deepStrictEqual(r.toOurs, { 'staff_note': '' });
});

check('a field absent from the sheet grid is left alone', () => {
  const r = merge({ sheet: {}, ours: { 'staff_note': 'ישן טוב' }, shadow: { 'staff_note': 'ישן טוב' } });
  assert.deepStrictEqual(r.toOurs, {});
  assert.deepStrictEqual(r.toSheet, {});
});

check('undefined and empty string are the same absence on our side', () => {
  const r = merge({ sheet: { 'diapers': '2' }, ours: {}, shadow: { 'diapers': '' } });
  assert.deepStrictEqual(r.toOurs, { 'diapers': '2' });
  assert.deepStrictEqual(r.conflicts, []);
});

console.log('\nlists');

check('missing[] compares by content, not by reference', () => {
  const r = merge({
    sheet: { 'missing': ['טיטולים', 'מגבונים'] },
    ours: { 'missing': ['טיטולים', 'מגבונים'] },
    shadow: { 'missing': ['טיטולים', 'מגבונים'] },
  });
  assert.deepStrictEqual(r.toOurs, {});
  assert.deepStrictEqual(r.toSheet, {});
});

check('a list we appended to is copied out', () => {
  const r = merge({
    sheet: { 'missing': ['טיטולים'] },
    ours: { 'missing': ['טיטולים', 'סינר'] },
    shadow: { 'missing': ['טיטולים'] },
  });
  assert.deepStrictEqual(r.toSheet, { 'missing': ['טיטולים', 'סינר'] });
});

console.log('\nmany fields at once');

check('each field is decided on its own', () => {
  const r = merge({
    sheet: { 'a': 'sheet', 'b': 'same', 'c': 'x', 'd': 'sheet' },
    ours: { 'a': 'old', 'b': 'same', 'c': 'ours', 'd': 'ours' },
    shadow: { 'a': 'old', 'b': 'same', 'c': 'x', 'd': 'old' },
  });
  assert.deepStrictEqual(r.toOurs, { 'a': 'sheet', 'd': 'sheet' });
  assert.deepStrictEqual(r.toSheet, { 'c': 'ours' });
  assert.deepStrictEqual(r.conflicts, [{ field: 'd', sheet: 'sheet', ours: 'ours' }]);
});

console.log('\nbeyond the brief — cases the four rules do not obviously pin down');

check('a field present in ours and shadow but absent from sheet is left alone', () => {
  const r = merge({
    sheet: {},
    ours: { 'home.nap_start': '13:00' },
    shadow: { 'home.nap_start': '13:00' },
  });
  assert.deepStrictEqual(r.toOurs, {});
  assert.deepStrictEqual(r.toSheet, {});
  assert.deepStrictEqual(r.conflicts, []);
});

check('a list that changed order but not content is a real change (order matters)', () => {
  const r = merge({
    sheet: { 'missing': ['מגבונים', 'טיטולים'] },
    ours: { 'missing': ['טיטולים', 'מגבונים'] },
    shadow: { 'missing': ['טיטולים', 'מגבונים'] },
  });
  assert.deepStrictEqual(r.toOurs, { 'missing': ['מגבונים', 'טיטולים'] });
  assert.deepStrictEqual(r.toSheet, {});
  assert.deepStrictEqual(r.conflicts, []);
});

check('numeric 0 is a real value, not blank — sheet changing 0 to 1 copies in', () => {
  const r = merge({ sheet: { 'count': 1 }, ours: { 'count': 0 }, shadow: { 'count': 0 } });
  assert.deepStrictEqual(r.toOurs, { 'count': 1 });
  assert.deepStrictEqual(r.toSheet, {});
});

check('boolean false is a real value, not blank — nobody moved, nothing happens', () => {
  const r = merge({ sheet: { 'napped': false }, ours: { 'napped': false }, shadow: { 'napped': false } });
  assert.deepStrictEqual(r.toOurs, {});
  assert.deepStrictEqual(r.toSheet, {});
  assert.deepStrictEqual(r.conflicts, []);
});

check('both sides moved but landed on the same value — agreement, not conflict', () => {
  const r = merge({
    sheet: { 'diapers': '5' },
    ours: { 'diapers': '5' },
    shadow: { 'diapers': '1' },
  });
  assert.deepStrictEqual(r.toOurs, {});
  assert.deepStrictEqual(r.toSheet, {});
  assert.deepStrictEqual(r.conflicts, []);
});

console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
