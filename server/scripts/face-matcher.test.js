/**
 * The matching rules, on made-up vectors so the assertions are about the logic
 * and not about a model's opinion of a photograph.
 *
 * The rule worth testing hardest is the one-to-one assignment. Two faces in a
 * photograph are two different children — a child cannot stand twice in one
 * frame — so if both look like דני only the better one can be him. That is the
 * same fact the thresholds were measured with, and here it is load-bearing:
 * without it, a photograph of a child next to their lookalike sibling tags
 * both faces with one name and a parent sees a stranger labelled as their son.
 */
const assert = require('assert');
const { assign, expandTwins, cosine } = require('../src/services/face/matcher');
const { MATCH_THRESHOLD } = require('../src/services/face/constants');

/**
 * Fixtures with arithmetic we can state rather than hope for.
 *
 * Each child is a different axis, so two children are exactly 0 alike; a
 * weaker likeness of a child is that axis tilted towards another by `drift`,
 * which puts its cosine at 1/sqrt(1 + drift²) — a number this file can assert
 * on instead of discovering. An earlier version generated vectors from sin()
 * and two supposedly different children came out 0.6 alike, which made the
 * test lie rather than fail.
 */
const DIMS = 8;

function axis(i) {
  const v = new Array(DIMS).fill(0);
  v[i] = 1;
  return v;
}

/** `base` tilted towards `other`; larger drift = less alike. */
function tilt(base, other, drift) {
  const v = base.map((b, i) => b + other[i] * drift);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

const DANI = axis(0);
const MAYA = axis(1);
const OTHER = axis(2);

/** A poorer likeness of דני — still recognisably him, but not the best match. */
const vec = (_seed, drift = 0) => (drift ? tilt(DANI, OTHER, drift) : DANI);
const failures = [];

function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name} — ${e.message}`);
  }
}

console.log('face matcher:');

check('a face that clears the threshold is tagged', () => {
  const faces = [{ bbox: [0, 0, 10, 10], det_score: 0.9, embedding: DANI }];
  const [d] = assign(faces, [{ child_id: 'dani', embedding: DANI }]);
  assert.strictEqual(d.child_id, 'dani');
  assert.ok(d.confidence > MATCH_THRESHOLD, `confidence ${d.confidence}`);
  assert.strictEqual(d.decided_by, 'system');
});

check('a face below the threshold is left for a human', () => {
  const faces = [{ bbox: [0, 0, 10, 10], det_score: 0.9, embedding: MAYA }];
  assert.ok(cosine(DANI, MAYA) < MATCH_THRESHOLD, 'fixtures must be dissimilar');
  const [d] = assign(faces, [{ child_id: 'dani', embedding: DANI }]);
  assert.strictEqual(d.child_id, null);
  assert.strictEqual(d.confidence, null);
});

check('one child cannot be tagged on two faces in one photograph', () => {
  // Both faces look like דני; the first is the better likeness.
  const faces = [
    { bbox: [0, 0, 10, 10], det_score: 0.9, embedding: DANI },
    { bbox: [20, 0, 30, 10], det_score: 0.9, embedding: vec(1, 0.35) },
  ];
  const out = assign(faces, [{ child_id: 'dani', embedding: DANI }]);
  const tagged = out.filter((d) => d.child_id === 'dani');
  assert.strictEqual(tagged.length, 1, `דני tagged ${tagged.length} times`);
  assert.strictEqual(out[0].child_id, 'dani', 'the better likeness should win');
  assert.strictEqual(out[1].child_id, null);
});

check('one face cannot be two children', () => {
  const faces = [{ bbox: [0, 0, 10, 10], det_score: 0.9, embedding: DANI }];
  const out = assign(faces, [
    { child_id: 'dani', embedding: DANI },
    { child_id: 'lookalike', embedding: vec(1, 0.3) },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].child_id, 'dani');
});

check('a child is matched on their best reference, not their first', () => {
  const faces = [{ bbox: [0, 0, 10, 10], det_score: 0.9, embedding: DANI }];
  const [d] = assign(faces, [
    { child_id: 'dani', embedding: vec(1, 0.5) },   // an older, weaker likeness
    { child_id: 'dani', embedding: DANI },          // today's
  ]);
  assert.strictEqual(d.child_id, 'dani');
  assert.ok(d.confidence > 0.99, `should use the best reference, got ${d.confidence}`);
});

check('two children in one photograph both get tagged', () => {
  const faces = [
    { bbox: [0, 0, 10, 10], det_score: 0.9, embedding: DANI },
    { bbox: [20, 0, 30, 10], det_score: 0.9, embedding: MAYA },
  ];
  const out = assign(faces, [
    { child_id: 'dani', embedding: DANI },
    { child_id: 'maya', embedding: MAYA },
  ]);
  assert.deepStrictEqual(out.map((d) => d.child_id), ['dani', 'maya']);
});

check('no references means no tags, not a crash', () => {
  const faces = [{ bbox: [0, 0, 10, 10], det_score: 0.9, embedding: DANI }];
  const [d] = assign(faces, []);
  assert.strictEqual(d.child_id, null);
});

check('bbox and det_score survive the decision', () => {
  const faces = [{ bbox: [1, 2, 3, 4], det_score: 0.77, embedding: DANI }];
  const [d] = assign(faces, [{ child_id: 'dani', embedding: DANI }]);
  assert.deepStrictEqual(d.bbox, [1, 2, 3, 4]);
  assert.strictEqual(d.det_score, 0.77);
});

console.log('\nface twins:');

check('tagging one twin tags the other', () => {
  const twins = new Map([['a', ['b']], ['b', ['a']]]);
  assert.deepStrictEqual(expandTwins(['a'], twins).sort(), ['a', 'b']);
});

check('a child with no twin is unaffected', () => {
  assert.deepStrictEqual(expandTwins(['solo'], new Map()), ['solo']);
});

check('triplets all come along', () => {
  const twins = new Map([['a', ['b', 'c']], ['b', ['a', 'c']], ['c', ['a', 'b']]]);
  assert.deepStrictEqual(expandTwins(['b'], twins).sort(), ['a', 'b', 'c']);
});

if (failures.length) {
  console.error(`\nFAIL face-matcher — ${failures.length} of the rules are wrong:`);
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('\nPASS face-matcher');
