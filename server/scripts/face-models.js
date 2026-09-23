#!/usr/bin/env node
/**
 * Putting the two neural networks where the server can reach them.
 *
 * They are 191MB and deliberately not in the repo: every clone, every Render
 * build and every deploy would carry them. They are also not downloaded from
 * the internet at run time, because that would make recognising a child depend
 * on a third party staying up and on a URL that has outlived two renames
 * already.
 *
 * So they live in the gan's own bucket, and this is what puts them there. Run
 * once, from a machine that has the files — either from the Python feasibility
 * test (~/.insightface/models/buffalo_l) or via FACE_MODEL_DIR.
 *
 *   node scripts/face-models.js --check     # what is where
 *   node scripts/face-models.js --upload    # local -> the gan's bucket
 *
 * The checksums are pinned in services/face/models.js. Every path in and out
 * verifies them: these weights decide which child a photograph is labelled
 * with, and a swapped file would load as a perfectly valid graph and quietly
 * start giving different answers.
 */
const fs = require('fs');
require('dotenv').config({ path: `${__dirname}/../.env` });

const {
  MODELS, findLocal, objectKey, sha256,
} = require('../src/services/face/models');
const storage = require('../src/services/storage.service');

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

async function inBucket(name) {
  try {
    const buf = await storage.getObject(objectKey(name));
    return { bytes: buf.length, sha256: sha256(buf) };
  } catch {
    return null;
  }
}

async function check() {
  console.log('\n=== מודלים של זיהוי פנים ===\n');
  console.log(`אחסון: ${storage.isConfigured() ? 'מוגדר' : 'לא מוגדר'}\n`);

  let allReady = true;
  for (const name of Object.keys(MODELS)) {
    const m = MODELS[name];
    const local = findLocal(name);
    const remote = storage.isConfigured() ? await inBucket(name) : null;

    console.log(`${m.file}  (${mb(m.bytes)})`);
    console.log(`  במחשב הזה : ${local || '—'}`);
    if (remote) {
      const good = remote.sha256 === m.sha256;
      console.log(`  בדלי       : ${mb(remote.bytes)}  ${good ? '✅ חתימה תקינה' : '🔴 חתימה שונה!'}`);
      if (!good) allReady = false;
    } else {
      console.log('  בדלי       : —');
      allReady = false;
    }
    console.log('');
  }

  if (allReady) console.log('✅ השרת יוכל למשוך את המודלים בעצמו.\n');
  else console.log('⚠️  הרץ --upload ממחשב שיש בו את הקבצים.\n');
  return allReady;
}

async function upload() {
  if (!storage.isConfigured()) throw new Error('אחסון לא מוגדר — אין לאן להעלות');

  for (const name of Object.keys(MODELS)) {
    const m = MODELS[name];
    const local = findLocal(name);
    if (!local) throw new Error(`${m.file} לא נמצא במחשב הזה`);

    const buffer = fs.readFileSync(local);
    const digest = sha256(buffer);
    // Verified BEFORE it goes up, not after. A wrong file in the bucket is a
    // wrong file on every instance that fetches it afterwards.
    if (digest !== m.sha256) {
      throw new Error(`${m.file} לא תואם לחתימה המוצמדת — לא מעלה`);
    }

    process.stdout.write(`מעלה ${m.file} (${mb(buffer.length)})… `);
    await storage.putObject({ key: objectKey(name), body: buffer, contentType: 'application/octet-stream' });
    console.log('✅');
  }
  console.log('');
  await check();
}

const wants = (f) => process.argv.includes(`--${f}`);

(async () => {
  try {
    if (wants('upload')) await upload();
    else await check();
    process.exit(0);
  } catch (e) {
    console.error(`\n❌ ${e.message}\n`);
    process.exit(1);
  }
})();
