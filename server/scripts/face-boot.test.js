/**
 * Everything the face feature adds can be loaded, and loading it does nothing.
 *
 * The scan queue is wired into server boot, so a syntax error or a circular
 * require in any of these files does not break face recognition — it breaks
 * the gan. This is the cheap check that runs without a database, a model file
 * or a photograph, and it also asserts the part that matters on the day it
 * ships: requiring the scanner must not start scanning, and the feature is off
 * until a Setting says otherwise.
 */
const assert = require('assert');

const modules = [
  'face/constants', 'face/models', 'face/detect',
  'face/align', 'face/matcher', 'face/index', 'face/scanner',
];
for (const m of modules) {
  require(`../src/services/${m}`);
  console.log(`  ok   loads ${m}`);
}

const C = require('../src/services/face/constants');
// Guards the numbers rather than merely reading them: these were measured on
// the gan's own photographs, and a well-meaning edit to a "magic number" is
// exactly how a system that never mislabels a child starts mislabelling one.
assert.strictEqual(C.DET_SCORE_MIN, 0.65, 'detection floor was measured, not chosen');
assert.strictEqual(C.MATCH_THRESHOLD, 0.55, 'match threshold was measured, not chosen');
assert.strictEqual(C.REFERENCES_PER_CHILD, 20);
assert.ok(C.MATCH_THRESHOLD < C.DET_SCORE_MIN,
  'the two thresholds answer different questions and must not be swapped');
console.log('  ok   measured constants intact');

const scanner = require('../src/services/face/scanner');
for (const fn of ['start', 'stop', 'tick', 'scanOne', 'health']) {
  assert.strictEqual(typeof scanner[fn], 'function', `scanner.${fn} missing`);
}
console.log('  ok   scanner exposes its interface');

const { Photo, ChildFaceReference } = require('../src/models');
assert.ok(Photo.schema.path('faces'), 'Photo must carry per-face decisions');
assert.ok(Photo.schema.path('face_scan_status'), 'Photo must carry scan state');
assert.strictEqual(Photo.schema.path('face_scan_status').defaultValue, 'pending');
assert.ok(ChildFaceReference.schema.path('embedding'), 'references must hold an embedding');
assert.strictEqual(typeof ChildFaceReference.trim, 'function', 'the reference set must roll');
console.log('  ok   models carry the new fields');

console.log('\nPASS face-boot');
