const crypto = require('crypto');
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
    sha256: '5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91',
  },
  recogniser: {
    file: 'w600k_r50.onnx',
    bytes: 174383860,
    sha256: '4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43',
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

/** The key a model lives under in the gan's own bucket. */
function objectKey(name) {
  return `models/buffalo_l/${MODELS[name].file}`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Get a model onto this machine, whatever it takes.
 *
 * Local first — a laptop that ran the Python feasibility test already has the
 * exact files. Otherwise from the gan's own bucket, which is where
 * scripts/face-models.js puts them: fetching from the internet at runtime
 * would make face recognition depend on a third party staying up and on a
 * download URL that has outlived two renames already.
 *
 * The hash is checked on arrival, not merely the size. These weights decide
 * which child a photograph is labelled with, and a truncated or swapped file
 * would load as a valid graph and quietly produce different answers — which is
 * the one failure mode nothing downstream could catch.
 */
async function ensure(name) {
  const local = findLocal(name);
  if (local) return local;

  const storage = require('../storage.service');
  if (!storage.isConfigured()) {
    throw new Error(
      `face: ${MODELS[name].file} is not on this machine and object storage is `
      + 'not configured. Run scripts/face-models.js --upload from a machine '
      + 'that has the models, or set FACE_MODEL_DIR.',
    );
  }

  const buffer = await storage.getObject(objectKey(name));
  const digest = sha256(buffer);
  if (digest !== MODELS[name].sha256) {
    throw new Error(
      `face: ${MODELS[name].file} does not match its pinned checksum `
      + `(got ${digest.slice(0, 12)}…). Refusing to load it.`,
    );
  }

  const target = cacheTarget(name);
  // Written beside the target and moved, so a process killed mid-download
  // cannot leave a half-file that `findLocal` would later accept on size.
  const tmp = `${target}.partial`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, target);
  return target;
}

module.exports = {
  MODELS, findLocal, cacheTarget, candidateDirs, ensure, objectKey, sha256,
};
