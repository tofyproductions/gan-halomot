/**
 * Does the JavaScript engine produce the same faces as the Python one?
 *
 * Every threshold the feature depends on — 0.65 to accept a detection, 0.55 to
 * accept an identity — was measured with InsightFace under Python, on 200 real
 * photographs from a class WhatsApp group. The server runs Node. If the port
 * drifts even slightly, those numbers quietly stop describing the thing they
 * were measured on: the system keeps working and starts being wrong, which is
 * the worst failure available here.
 *
 * So this compares them face by face against that recorded run. An embedding
 * is a direction in 512 dimensions, and two implementations of the same model
 * should point the same way to within floating-point noise — anything below
 * 0.99 means the preprocessing, the alignment or the normalisation differs.
 *
 * Needs the sample photographs and the recorded Python output, neither of
 * which belongs in the repo (187MB of other people's children). It skips,
 * loudly, when they are absent:
 *
 *   FACE_TEST_DIR=... FACE_TRUTH=.../faces.json node scripts/face-parity.test.js
 */
const fs = require('fs');
const path = require('path');

const PHOTOS = process.env.FACE_TEST_DIR
  || path.join(process.env.HOME, 'Desktop', 'בדיקת זיהוי פנים');
const TRUTH = process.env.FACE_TRUTH;
const SAMPLE = Number(process.env.FACE_SAMPLE || 12);

const MIN_PARITY = 0.99;     // cosine between the two implementations
const MIN_BBOX_IOU = 0.9;    // the same face, not merely a nearby one

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter);
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

async function main() {
  if (!TRUTH || !fs.existsSync(TRUTH) || !fs.existsSync(PHOTOS)) {
    console.log('SKIP face-parity: needs FACE_TEST_DIR and FACE_TRUTH');
    console.log('  photos:', PHOTOS, fs.existsSync(PHOTOS) ? '(ok)' : '(missing)');
    console.log('  truth :', TRUTH || '(unset)');
    return;
  }

  const { analyze, constants } = require('../src/services/face');

  // The recorded run kept every face above the detector's raw threshold; group
  // it by file so each photograph can be compared on its own.
  const truthByFile = new Map();
  for (const f of JSON.parse(fs.readFileSync(TRUTH, 'utf8'))) {
    if (!truthByFile.has(f.file)) truthByFile.set(f.file, []);
    truthByFile.get(f.file).push(f);
  }

  // Busiest photographs first: a frame with six children exercises the
  // detector, the landmark regression and the alignment far harder than a
  // portrait does, and it is where a porting mistake shows up first.
  const files = [...truthByFile.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, SAMPLE)
    .map(([file]) => file);

  let compared = 0;
  let unmatched = 0;
  let worst = 1;
  const parities = [];

  for (const file of files) {
    const buffer = fs.readFileSync(path.join(PHOTOS, file));
    const { faces } = await analyze(buffer, { minScore: constants.DET_SCORE_MIN });
    const truth = truthByFile.get(file).filter((t) => t.det_score >= constants.DET_SCORE_MIN);

    for (const got of faces) {
      const hit = truth
        .map((t) => ({ t, o: iou(got.bbox, t.bbox) }))
        .sort((a, b) => b.o - a.o)[0];

      if (!hit || hit.o < MIN_BBOX_IOU) { unmatched += 1; continue; }

      const p = cosine(got.embedding, Float32Array.from(hit.t.embedding));
      parities.push(p);
      worst = Math.min(worst, p);
      compared += 1;
    }

    console.log(
      `  ${file.padEnd(34)} node ${String(faces.length).padStart(2)} `
      + `| python ${String(truth.length).padStart(2)}`,
    );
  }

  const mean = parities.reduce((a, b) => a + b, 0) / (parities.length || 1);
  console.log(`\n  faces compared : ${compared}`);
  console.log(`  unmatched      : ${unmatched}`);
  console.log(`  mean agreement : ${mean.toFixed(5)}`);
  console.log(`  worst          : ${worst.toFixed(5)}`);

  const problems = [];
  if (!compared) problems.push('no faces were compared at all');
  if (worst < MIN_PARITY) problems.push(`worst agreement ${worst.toFixed(4)} < ${MIN_PARITY}`);
  // One stray box is a boundary case on the detector's own threshold; several
  // mean the port finds different faces, which is not a rounding difference.
  if (unmatched > 1) problems.push(`${unmatched} node faces had no Python counterpart`);

  if (problems.length) {
    console.error(`\nFAIL face-parity:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\nPASS face-parity — the Node engine reproduces the measured pipeline');
}

main().catch((e) => { console.error('FAIL face-parity:', e); process.exit(1); });
