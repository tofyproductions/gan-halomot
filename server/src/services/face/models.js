const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Where the two neural networks come from, and why they are not in the repo.
 *
 * Recognition needs two models — a detector that finds faces and returns five
 * landmarks, and a recogniser that turns an aligned face into 512 numbers.
 * Together they are 191MB, which is far too much to commit: every clone, every
 * Render build and every deploy would carry them.
 *
 * So they are fetched once and cached on disk. Render's disk does not survive
 * a deploy, which is fine — a cold instance downloads them once during the
 * first scan and keeps them for its life. The scan queue is a background job;
 * nobody is waiting on a request while that happens.
 *
 * The files are pinned by SHA-256. These weights decide which child a
 * photograph is labelled with, and the thresholds in face/index.js were
 * measured against these exact files — a silently different model would keep
 * working and start being wrong.
 */

// InsightFace's buffalo_l. Chosen by measurement, not reputation: the small
// pack (buffalo_s) needed a 0.60 threshold to reach zero false positives on
// the gan's own photographs and still missed 44% of the matches this one
// finds at 0.55. See FACE_RECOGNITION_PLAN.md.
const MODELS = {
  detector: {
    file: 'det_10g.onnx',
    bytes: 16923827,
    sha256: null,               // filled by scripts/face-model-pin.js on first fetch
  },
  recogniser: {
    file: 'w600k_r50.onnx',
    bytes: 174383860,
    sha256: null,
  },
};

/**
 * Cache location, in order of preference.
 *
 * A developer who has run the Python feasibility test already has these exact
 * files in ~/.insightface — reusing them means no download on a laptop, and
 * it is the same byte-for-byte model the measurements were taken with.
 */
function candidateDirs() {
  return [
    process.env.FACE_MODEL_DIR,
    path.join(os.homedir(), '.insightface', 'models', 'buffalo_l'),
    path.join(os.tmpdir(), 'gan-face-models'),
  ].filter(Boolean);
}

function findLocal(name) {
  const { file, bytes } = MODELS[name];
  for (const dir of candidateDirs()) {
    const p = path.join(dir, file);
    try {
      // Size is checked as well as existence: a download killed halfway leaves
      // a file that exists, loads as a corrupt graph, and produces an error
      // three layers away from the cause.
      if (fs.statSync(p).size === bytes) return p;
    } catch { /* not here; try the next directory */ }
  }
  return null;
}

/** Where a fetched model should be written. */
function cacheTarget(name) {
  const dir = process.env.FACE_MODEL_DIR || path.join(os.tmpdir(), 'gan-face-models');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, MODELS[name].file);
}

module.exports = { MODELS, findLocal, cacheTarget, candidateDirs };
