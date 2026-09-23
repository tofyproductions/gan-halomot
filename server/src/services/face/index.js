const sharp = require('sharp');
const { detect } = require('./detect');
const { align, SIZE: CROP } = require('./align');
const { findLocal, MODELS } = require('./models');
const C = require('./constants');

/**
 * The face engine: a photograph in, a list of faces and their embeddings out.
 *
 * Nothing here knows what a child is. It finds faces, straightens them and
 * turns each into 512 numbers; deciding whose face it is belongs to the
 * matcher, and everything about consent, tagging and galleries belongs further
 * up still. Kept separate because this layer is the one that has to stay
 * byte-compatible with the Python pipeline the thresholds were measured on.
 *
 * Runs on the Render instance the gan already pays for. Children's faces never
 * leave the system — there is no third party in this path, by design, and that
 * is the difference between this and every competitor.
 */

let sessions = null;
let loading = null;

/**
 * Load both networks, once per process.
 *
 * Guarded by a shared promise rather than a boolean: the scan queue is async,
 * and two photographs arriving together would otherwise each start loading
 * 191MB of weights. The second call waits for the first instead.
 */
async function ready() {
  if (sessions) return sessions;
  if (loading) return loading;

  loading = (async () => {
    const ort = require('onnxruntime-node');
    const paths = {};
    for (const name of Object.keys(MODELS)) {
      const p = findLocal(name);
      if (!p) {
        throw new Error(
          `face: ${MODELS[name].file} not found. Set FACE_MODEL_DIR, or run `
          + 'scripts/face-fetch-models.js to download it.',
        );
      }
      paths[name] = p;
    }

    // One thread each. The box has a single CPU that also serves the app and
    // launches Chromium for PDFs; letting ONNX fan out would starve requests
    // to make one background scan marginally faster.
    //
    // Severity 3 (errors only) silences a warning per output per photograph:
    // the detector's graph declares the output shapes for its default 640px
    // input and we feed it DET_SIZE, so every run reports nine "expected shape
    // does not match" lines. The data is correct — face-parity.test.js proves
    // the embeddings match Python exactly — and left at the default the log
    // would be nine lines of noise for every photo the gan ever takes.
    const opts = { intraOpNumThreads: 1, interOpNumThreads: 1, logSeverityLevel: 3 };
    sessions = {
      detector: await ort.InferenceSession.create(paths.detector, opts),
      recogniser: await ort.InferenceSession.create(paths.recogniser, opts),
    };
    return sessions;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/** One aligned 112x112 crop -> a unit-length 512-dimension embedding. */
async function embed(session, crop) {
  const ort = require('onnxruntime-node');
  const plane = CROP * CROP;
  const blob = new Float32Array(3 * plane);

  // (pixel - 127.5) / 127.5 — the recogniser's normalisation, which is NOT the
  // detector's (/128). The two differ by a hair and by enough to matter.
  for (let p = 0, j = 0; p < plane; p += 1, j += 3) {
    blob[p] = (crop[j] - 127.5) / 127.5;
    blob[plane + p] = (crop[j + 1] - 127.5) / 127.5;
    blob[2 * plane + p] = (crop[j + 2] - 127.5) / 127.5;
  }

  const out = await session.run({
    [session.inputNames[0]]: new ort.Tensor('float32', blob, [1, 3, CROP, CROP]),
  });
  const raw = out[session.outputNames[0]].data;

  // Unit length, so that comparing two faces is a dot product and the
  // threshold in constants.js means the same thing everywhere.
  let sum = 0;
  for (let i = 0; i < raw.length; i += 1) sum += raw[i] * raw[i];
  const inv = 1 / Math.sqrt(sum);
  const v = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) v[i] = raw[i] * inv;
  return v;
}

/**
 * Analyse one photograph.
 *
 * `minScore` defaults to the measured floor. The scanner passes the lower
 * DET_RAW_THRESHOLD when it wants the rejected boxes too, because a face the
 * engine will not tag automatically is still worth offering to a teacher in
 * the "who is this?" queue.
 */
async function analyze(buffer, { minScore = C.DET_SCORE_MIN, detSize = C.DET_SIZE } = {}) {
  const s = await ready();
  const { faces, width, height } = await detect(s.detector, buffer, {
    size: detSize,
    threshold: C.DET_RAW_THRESHOLD,
  });

  const keep = faces.filter((f) => f.score >= minScore);
  if (!keep.length) return { width, height, faces: [], rejected: faces.length };

  // The landmarks are in the coordinates of the upright original, so the
  // source pixels have to be too — read once and shared by every face rather
  // than decoding the JPEG again per person in the frame.
  const { data: rgb } = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const out = [];
  for (const f of keep) {
    const crop = align(rgb, width, height, f.kps);
    out.push({
      bbox: f.bbox.map((v) => Math.round(v)),
      det_score: Number(f.score.toFixed(4)),
      kps: f.kps,
      embedding: await embed(s.recogniser, crop),
      crop,
    });
  }

  return { width, height, faces: out, rejected: faces.length - keep.length };
}

/** Cosine similarity of two unit-length embeddings. */
function similarity(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

module.exports = { analyze, similarity, ready, embed, constants: C };
