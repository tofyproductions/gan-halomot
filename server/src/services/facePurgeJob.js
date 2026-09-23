const { Photo } = require('../models');
const { EMBEDDING_TTL_DAYS } = require('./face/constants');

/**
 * Forgetting faces on purpose.
 *
 * A photograph is ordinary personal data; an embedding is biometric data about
 * a minor, which is a different legal category and the only part of this
 * feature worth being nervous about. The scanner keeps one per face for a
 * while because two jobs need the original numbers — a teacher naming a face
 * in the tagging queue, and back-filling a child who enrolled after the
 * photograph was taken — and then they are simply not needed. The tag is the
 * answer.
 *
 * Without this job the gan would accumulate roughly 180,000 biometric
 * templates of children a year. With it, the only ones that persist are the
 * rolling twenty references per child in ChildFaceReference: about 4,400, and
 * every one of them there for a reason someone can explain.
 *
 * `child_ids`, `faces[].child_id` and every tag survive untouched. This
 * removes the numbers, not the knowledge.
 */

// Once a day is often enough for a thirty-day window, and it deliberately does
// not run at boot: a deploy loop would otherwise sweep the collection every
// few minutes for no benefit.
const EVERY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_MS = 10 * 60 * 1000;

async function tick() {
  const cutoff = new Date(Date.now() - EMBEDDING_TTL_DAYS * 24 * 60 * 60 * 1000);

  // Only rows that still carry numbers, so a settled collection costs one
  // indexed count rather than a full scan every night.
  const res = await Photo.updateMany(
    {
      face_scanned_at: { $lt: cutoff },
      'faces.embedding': { $exists: true },
    },
    { $unset: { 'faces.$[].embedding': '' } },
  );

  return { purged: res.modifiedCount || 0, older_than: cutoff };
}

function describeTick(r) {
  if (!r.purged) return [];
  return [{
    level: 'log',
    text: `[face-purge] dropped embeddings from ${r.purged} photographs `
      + `older than ${r.older_than.toISOString().slice(0, 10)}`,
  }];
}

module.exports = { tick, describeTick, EVERY_MS, FIRST_RUN_MS };
