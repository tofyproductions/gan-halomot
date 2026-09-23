/**
 * The recall measurement, on vectors we control.
 *
 * This is the machinery that will produce the one number the project has never
 * had, so it has to be right before the teachers' week feeds it real data —
 * a measurement that flatters itself is worse than no measurement, because it
 * would be believed and acted on.
 *
 * The rule it must never break: a face is scored against its child's OTHER
 * faces, never its own. Score a face against itself and every child matches
 * perfectly, recall reads 100%, and the number is a tautology. That mistake
 * was made once already with clustering-derived labels — it reported 99.4% on
 * the sample photographs, which was arithmetic, not evidence.
 */
const assert = require('assert');
const { evaluate } = require('../src/services/face/recall');
const { MATCH_THRESHOLD } = require('../src/services/face/constants');

const DIMS = 16;
const axis = (i) => { const v = new Array(DIMS).fill(0); v[i] = 1; return v; };
/** `base` tilted towards `other`: cosine is 1/sqrt(1 + drift²). */
const tilt = (base, other, drift) => {
  const v = base.map((b, i) => b + other[i] * drift);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};

const A = axis(0);
const B = axis(1);
const C = axis(2);

const failures = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name} — ${e.message}`);
  }
};

console.log('recall measurement:');

check('a child with several similar faces is recognised', () => {
  const faces = [0.05, 0.08, 0.1, 0.12].map((d) => ({ child: 'a', embedding: tilt(A, C, d) }));
  const r = evaluate(faces);
  assert.strictEqual(r.total, 4);
  assert.strictEqual(r.matched, 4, `matched ${r.matched}`);
  assert.strictEqual(r.wrong, 0);
  assert.strictEqual(r.recall, 1);
});

check('a face is never scored against itself', () => {
  // Two faces of one child that are nothing alike. Scored honestly this is a
  // miss; scored against itself it would be a perfect match.
  const r = evaluate([
    { child: 'a', embedding: A },
    { child: 'a', embedding: B },
  ]);
  assert.strictEqual(r.matched, 0, 'self-matching has leaked in');
  assert.strictEqual(r.missed, 2);
});

check('a child seen only once is not counted as a miss', () => {
  const r = evaluate([
    { child: 'a', embedding: A },
    { child: 'a', embedding: tilt(A, C, 0.1) },
    { child: 'lonely', embedding: B },
  ]);
  assert.strictEqual(r.unscoreable, 1, 'the single appearance must be excluded');
  assert.strictEqual(r.total - r.unscoreable, 2);
  assert.strictEqual(r.missed, 0, 'it must not be scored as a failure');
});

check('being matched to the WRONG child is counted separately', () => {
  // דני's second face looks more like מאיה's than like his own first.
  const r = evaluate([
    { child: 'dani', embedding: A },
    { child: 'dani', embedding: tilt(B, C, 0.02) },
    { child: 'maya', embedding: B },
    { child: 'maya', embedding: tilt(B, C, 0.05) },
  ]);
  assert.ok(r.wrong >= 1, `expected a wrong match, got ${JSON.stringify(r)}`);
  assert.ok(r.error_rate > 0);
});

check('two different children are not confused', () => {
  const r = evaluate([
    { child: 'a', embedding: A },
    { child: 'a', embedding: tilt(A, C, 0.1) },
    { child: 'b', embedding: B },
    { child: 'b', embedding: tilt(B, C, 0.1) },
  ]);
  assert.strictEqual(r.wrong, 0);
  assert.strictEqual(r.matched, 4);
});

check('candidates are narrowed by the group, as in production', () => {
  // Same face twice under two children, separated only by the day they were
  // seen. Without the narrowing they compete; with it, neither can be the
  // other, because the daily board says they were not in the same room.
  const shared = tilt(A, C, 0.01);
  const faces = [
    { child: 'mon', embedding: A, group: 'monday' },
    { child: 'mon', embedding: shared, group: 'monday' },
    { child: 'tue', embedding: A, group: 'tuesday' },
    { child: 'tue', embedding: shared, group: 'tuesday' },
  ];
  const narrowed = evaluate(faces);
  assert.strictEqual(narrowed.wrong, 0, 'the group must keep them apart');
  assert.strictEqual(narrowed.matched, 4);

  const open = evaluate(faces.map((f) => ({ ...f, group: null })));
  assert.ok(open.wrong > 0, 'without the group they should collide');
});

check('the reference set is capped, newest kept', () => {
  // Twenty-one faces: one ancient and unlike the rest, twenty recent ones. The
  // cap must drop the ancient one rather than a recent one.
  const faces = [{ child: 'a', embedding: B, at: 1 }];
  for (let i = 0; i < 20; i += 1) {
    faces.push({ child: 'a', embedding: tilt(A, C, 0.02 * i), at: 100 + i });
  }
  const r = evaluate(faces, { perChild: 20 });
  assert.strictEqual(r.wrong, 0);
  // The ancient face is the one that cannot be found from the recent twenty,
  // which is exactly the real-world case this cap exists for.
  assert.ok(r.missed <= 1, `expected at most the stale face to miss, got ${r.missed}`);
});

check('nothing at all is a zero, not a crash', () => {
  const r = evaluate([]);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.recall, 0);
});

check('the threshold used is the measured one', () => {
  // Just below the threshold is a miss; just above is a match. Guards against
  // the report quietly scoring at a different threshold from the live system.
  const justUnder = 1 / Math.sqrt(1 + 1.55 ** 2);
  assert.ok(justUnder < MATCH_THRESHOLD, 'fixture must sit under the threshold');
  const r = evaluate([
    { child: 'a', embedding: A },
    { child: 'a', embedding: tilt(A, C, 1.55) },
  ]);
  assert.strictEqual(r.matched, 0, 'a pair below the threshold must not match');
});

if (failures.length) {
  console.error(`\nFAIL face-recall — ${failures.length} wrong:`);
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('\nPASS face-recall');
