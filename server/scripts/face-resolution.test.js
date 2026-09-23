/**
 * The thresholds were measured on the wrong pictures. This checks how much
 * that matters.
 *
 * The feasibility test ran on the originals straight off a teacher's phone —
 * around 3000px wide. The gan does not keep those: photo.service resizes every
 * upload to 1600px and throws the original away deliberately, so what the
 * scanner will actually see in production is roughly half the width and a
 * quarter of the pixels. A face 45px across in the original is 24px here, and
 * detail that thin is where a recogniser stops working.
 *
 * So the same measurement is repeated on the stored size, using the same fact
 * that needs no labels: two faces in one photograph are two different
 * children, therefore every within-photo pair the matcher accepts is a
 * definite mistake. If the error count at MATCH_THRESHOLD is still zero, the
 * numbers in FACE_RECOGNITION_PLAN.md survive the resize. If it is not, they
 * describe a pipeline the gan does not run.
 *
 *   FACE_TEST_DIR=~/Desktop/... node scripts/face-resolution.test.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PHOTOS = process.env.FACE_TEST_DIR
  || path.join(process.env.HOME, 'Desktop', 'בדיקת זיהוי פנים');
const LIMIT = Number(process.env.FACE_LIMIT || 200);

// photo.service's own settings. Imported by value rather than by require so
// this test still means something if that file is refactored — if they drift
// apart, this test is measuring a size nobody stores.
const FULL_MAX = 1600;
const FULL_QUALITY = 82;

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

async function main() {
  if (!fs.existsSync(PHOTOS)) {
    console.log(`SKIP face-resolution: no sample photographs at ${PHOTOS}`);
    return;
  }

  const { analyze, constants } = require('../src/services/face');
  const files = fs.readdirSync(PHOTOS)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .sort()
    .slice(0, LIMIT);

  console.log(`${files.length} photographs, resized to ${FULL_MAX}px as the gan stores them\n`);

  const perPhoto = [];
  let faceCount = 0;
  const widths = [];
  const t0 = Date.now();

  for (let i = 0; i < files.length; i += 1) {
    const original = fs.readFileSync(path.join(PHOTOS, files[i]));
    const stored = await sharp(original, { failOn: 'none' })
      .rotate()
      .resize({ width: FULL_MAX, height: FULL_MAX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: FULL_QUALITY, mozjpeg: true })
      .toBuffer();

    const { faces } = await analyze(stored);
    faceCount += faces.length;
    faces.forEach((f) => widths.push(f.bbox[2] - f.bbox[0]));
    if (faces.length > 1) perPhoto.push(faces.map((f) => f.embedding));

    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${files.length}  (${faceCount} faces)`);
    }
  }

  const seconds = (Date.now() - t0) / 1000;

  // Every pair that is certainly two different children.
  const pairs = [];
  for (const embeddings of perPhoto) {
    for (let a = 0; a < embeddings.length; a += 1) {
      for (let b = a + 1; b < embeddings.length; b += 1) {
        pairs.push(cosine(embeddings[a], embeddings[b]));
      }
    }
  }

  widths.sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)] || 0;

  console.log(`\n  faces found        : ${faceCount}`);
  console.log(`  median face width  : ${median}px`);
  console.log(`  time per photograph: ${(seconds / files.length).toFixed(2)}s on this machine`);
  console.log(`\n  ${pairs.length} pairs that are certainly different children\n`);

  let errorsAtThreshold = 0;
  for (const t of [0.40, 0.45, 0.50, 0.55, 0.60]) {
    const bad = pairs.filter((p) => p >= t).length;
    const mark = t === constants.MATCH_THRESHOLD ? '  <-- MATCH_THRESHOLD' : '';
    console.log(`  ${t.toFixed(2)}  ${String(bad).padStart(4)} / ${pairs.length}`
      + `  (${(100 * bad / (pairs.length || 1)).toFixed(2)}%)${mark}`);
    if (t === constants.MATCH_THRESHOLD) errorsAtThreshold = bad;
  }

  if (!pairs.length) {
    console.error('\nFAIL face-resolution: no multi-face photographs to measure with');
    process.exit(1);
  }
  if (errorsAtThreshold > 0) {
    console.error(`\nFAIL face-resolution: ${errorsAtThreshold} certain mistakes at `
      + `${constants.MATCH_THRESHOLD} on the size the gan actually stores.`);
    console.error('The measured thresholds do not survive the resize — raise '
      + 'MATCH_THRESHOLD, or scan before photo.service discards the original.');
    process.exit(1);
  }
  console.log(`\nPASS face-resolution — zero mistakes at ${constants.MATCH_THRESHOLD} `
    + 'on stored-size photographs');
}

main().catch((e) => { console.error('FAIL face-resolution:', e); process.exit(1); });
