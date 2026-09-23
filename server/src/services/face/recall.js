const { MATCH_THRESHOLD, REFERENCES_PER_CHILD } = require('./constants');

/**
 * The one number this project has never had: how often does it stay silent?
 *
 * Everything measured so far says the system is right when it speaks — zero
 * mistakes across 648 pairs that are certainly different children. None of it
 * says how often it says nothing about a child who is plainly there, and that
 * is the number the teachers' week exists to produce.
 *
 * It cannot be measured by simply asking the system, because the faces a
 * teacher named are the same faces that became references. Scoring against
 * them would be marking your own homework: every face would match itself
 * perfectly and recall would read 100%.
 *
 * So this holds each face out. For every labelled face it rebuilds that
 * child's references from their OTHER faces only, and asks what the system
 * would have said having never seen this one. That is the honest question —
 * a child walks in on Tuesday and the system has last week to go on.
 *
 * Three outcomes, and they are not equally bad:
 *
 *   matched  — the right child. What we want.
 *   missed   — nobody. Costs a photograph in a family's gallery. Survivable,
 *              and the whole product is built around it being survivable.
 *   wrong    — a DIFFERENT child. A parent sees a stranger labelled as their
 *              son. This is the number that must stay at zero.
 */

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

/**
 * @param labelled  [{ child, embedding, group?, at? }]
 *   `child` — the ground truth, from a person
 *   `group` — optional: only children seen in the same group are candidates,
 *             which mirrors production, where the daily board narrows the
 *             field to the dozen who were in the room that morning. Scoring
 *             without it measures a harder problem than the one we built.
 *   `at`    — optional timestamp; references are drawn from OTHER faces,
 *             preferring the most recent, the way the live set rolls.
 */
function evaluate(labelled, {
  threshold = MATCH_THRESHOLD,
  perChild = REFERENCES_PER_CHILD,
} = {}) {
  const byChild = new Map();
  for (const item of labelled) {
    const key = String(item.child);
    if (!byChild.has(key)) byChild.set(key, []);
    byChild.get(key).push(item);
  }

  // Which children are even in the running for a given face.
  const byGroup = new Map();
  for (const item of labelled) {
    const g = item.group == null ? '*' : String(item.group);
    if (!byGroup.has(g)) byGroup.set(g, new Set());
    byGroup.get(g).add(String(item.child));
  }

  const result = {
    total: 0, matched: 0, missed: 0, wrong: 0, unscoreable: 0, perChild: [],
  };
  const tally = new Map();

  for (const item of labelled) {
    const truth = String(item.child);
    result.total += 1;
    const t = tally.get(truth) || { total: 0, matched: 0, missed: 0, wrong: 0 };
    t.total += 1;

    // A child whose only appearance is this one face has nothing to be
    // recognised from. That is a real gap in the data, not a failure of the
    // model, and lumping it into "missed" would understate recall.
    const others = byChild.get(truth).filter((o) => o !== item);
    if (!others.length) {
      result.unscoreable += 1;
      tally.set(truth, t);
      continue;
    }

    const eligible = byGroup.get(item.group == null ? '*' : String(item.group))
      || new Set([truth]);

    let best = { child: null, score: -1 };
    for (const [child, faces] of byChild) {
      if (!eligible.has(child)) continue;
      // Hold out the face being scored, and cap the rest the way the live
      // reference set is capped — newest first.
      const pool = (child === truth ? others : faces)
        .slice()
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .slice(0, perChild);

      for (const ref of pool) {
        const score = cosine(item.embedding, ref.embedding);
        if (score > best.score) best = { child, score };
      }
    }

    if (best.score < threshold) { result.missed += 1; t.missed += 1; } else if (best.child === truth) { result.matched += 1; t.matched += 1; } else { result.wrong += 1; t.wrong += 1; }

    tally.set(truth, t);
  }

  result.perChild = [...tally.entries()]
    .map(([child, t]) => ({ child, ...t }))
    .sort((a, b) => b.total - a.total);

  const scored = result.total - result.unscoreable;
  result.recall = scored ? result.matched / scored : 0;
  result.error_rate = scored ? result.wrong / scored : 0;
  return result;
}

/** A short report a person can read, in the order the numbers matter. */
function describe(r) {
  const scored = r.total - r.unscoreable;
  const pct = (n) => `${(100 * n / (scored || 1)).toFixed(1)}%`;
  return [
    `פרצופים שתויגו בידי אדם: ${r.total}`,
    `  מתוכם ניתנים למדידה:   ${scored}` + (r.unscoreable ? `  (${r.unscoreable} ילדים שמופיעים פעם אחת בלבד)` : ''),
    '',
    `  ✅ זוהו נכון:  ${String(r.matched).padStart(5)}   ${pct(r.matched)}   ← זה אחוז ההצלחה`,
    `  ⬜ לא זוהו:   ${String(r.missed).padStart(5)}   ${pct(r.missed)}   ← תמונה שלא תגיע למשפחה`,
    `  ❌ זוהו שגוי: ${String(r.wrong).padStart(5)}   ${pct(r.wrong)}   ← חייב להישאר אפס`,
  ];
}

module.exports = { evaluate, describe, cosine };
