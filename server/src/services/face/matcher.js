const { MATCH_THRESHOLD } = require('./constants');

/**
 * Deciding whose face this is.
 *
 * Two ideas carry the accuracy of this file, and neither of them is the neural
 * network.
 *
 * THE FIRST is that we already know who was in the room. Every photograph
 * carries a classroom and a date, and the daily board records which children
 * turned up — so a face is compared against the dozen children who were
 * actually there that morning, not against all 220 in the gan. Shrinking the
 * field by a factor of twenty is a larger accuracy gain than any model change
 * available to us, and it was built in September for something else entirely.
 *
 * THE SECOND is that a child cannot appear twice in one frame. That is the same
 * fact the thresholds were measured with, and it is worth more than a
 * measurement: it means the assignment is one-to-one. If two faces both look
 * like דני, only the better one can be him, and forcing that choice removes a
 * whole class of mistake the raw scores would otherwise make.
 */

/**
 * Who could plausibly be in this photograph.
 *
 * Prefers the attendance record; falls back to the classroom's roster when the
 * board was not filled in that day, which happens and must not mean a whole
 * day of photographs goes untagged. The fallback is wider, not wrong — it
 * simply has more children in it to be confused by.
 */
async function candidateChildIds({ DailyLog, Child }, { classroom_id, date }) {
  if (!classroom_id || !date) return [];
  // Required late so this file stays loadable without the model layer, which
  // is what lets face-matcher.test.js run as pure logic.
  const consent = require('../faceConsent.service');

  const logs = await DailyLog.find({
    classroom_id,
    date,
    attendance: { $ne: 'חסר' },     // present, or not yet marked either way
  }).select('child_id').lean();

  const present = logs.length
    ? logs.map((l) => l.child_id)
    : (await Child.find({ classroom_id, is_active: { $ne: false } })
      .select('_id').lean()).map((c) => c._id);

  // The boundary of the whole feature. A child whose parents did not tick the
  // box is not a candidate — no template is made for them, nothing is matched
  // against them, and their gallery works exactly like everyone else's minus
  // the automatic filter.
  return consent.filterConsenting(present);
}

/** Cosine of two unit-length vectors. Plain arrays from Mongo, typed from ONNX. */
function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

/**
 * Match every face in one photograph against every candidate child.
 *
 * `faces` are what the engine returned; `references` are rows of
 * { child_id, embedding }. Returns one decision per face, in the same order,
 * with `child_id: null` for anything that did not clear the threshold — those
 * are the ones a teacher gets asked about later.
 */
function assign(faces, references, { threshold = MATCH_THRESHOLD } = {}) {
  // Every (face, child) pair worth considering, best first.
  const pairs = [];
  faces.forEach((face, faceIndex) => {
    const best = new Map();       // child -> highest similarity to THIS face
    for (const ref of references) {
      const score = cosine(face.embedding, ref.embedding);
      if (score < threshold) continue;
      const key = String(ref.child_id);
      if (!best.has(key) || score > best.get(key)) best.set(key, score);
    }
    for (const [childKey, score] of best) {
      pairs.push({ faceIndex, childKey, score });
    }
  });

  pairs.sort((a, b) => b.score - a.score);

  // Greedy one-to-one: the most confident claim wins, and both the face and
  // the child are then spent. A child appearing twice in one frame is
  // impossible, so a second face claiming them is by definition the weaker,
  // wrong claim — and dropping it is free accuracy.
  const takenFace = new Set();
  const takenChild = new Set();
  const decisions = faces.map((face) => ({
    bbox: face.bbox,
    det_score: face.det_score,
    child_id: null,
    confidence: null,
    decided_by: 'system',
  }));

  for (const p of pairs) {
    if (takenFace.has(p.faceIndex) || takenChild.has(p.childKey)) continue;
    takenFace.add(p.faceIndex);
    takenChild.add(p.childKey);
    decisions[p.faceIndex].child_id = p.childKey;
    decisions[p.faceIndex].confidence = Number(p.score.toFixed(4));
  }

  return decisions;
}

/**
 * Identical twins are tagged together.
 *
 * `twins` maps a child id to every child sharing its `twin_group_id`. No
 * recogniser distinguishes identical twins, and there is nothing to gain by
 * trying: twins have the same parents, so the photograph reaches the right
 * family whichever name goes on it.
 */
function expandTwins(childIds, twins) {
  const out = new Set();
  for (const id of childIds) {
    out.add(String(id));
    for (const sibling of twins.get(String(id)) || []) out.add(String(sibling));
  }
  return [...out];
}

module.exports = { candidateChildIds, assign, expandTwins, cosine };
