#!/usr/bin/env node
/**
 * "ממתינים" מול "בלי הסכמה" מול "פג תוקף" — ההבדל שהמונה הישן טישטש.
 *
 * WHY THIS EXISTS. `progress()` used to count every unnamed, non-"not a
 * child" face as "waiting" — but a face scanned in a room where no parent has
 * ticked face-recognition consent never gets an embedding
 * (services/face/scanner.js), and `queue()` requires one before it will offer
 * a face at all. The result was a badge saying "7 ממתינים" next to a tagging
 * screen saying "אין פרצופים שממתינים" — not a counting bug so much as two
 * different definitions of "waiting" living in the same feature.
 *
 * And a missing embedding is not always a consent problem: `facePurgeJob`
 * unsets it EMBEDDING_TTL_DAYS after `face_scanned_at`, same as it does for a
 * face that DID have permission. Lumping that into "no_consent" would send a
 * teacher to chase a family who already agreed.
 *
 * This asserts both splits directly: one photo with two embedded faces (one
 * named, one not), one recently-scanned photo with a face that never got an
 * embedding (no consent), and one photo scanned 40 days ago whose face also
 * has none (the purge job already ran) — and checks that `progress()` puts
 * each in the right bucket while `queue()` only ever offers the embedded one.
 *
 * It also stands in for the schema question the brief calls out: `embedding`
 * is `select: false` on Photo.faces, so an ordinary `.find()` would hide it —
 * this proves the aggregation pipeline `progress()`/`queue()` use does NOT
 * lose it, because an aggregate reads the raw document.
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL. dotenv is stubbed before anything else
 * loads it; server/.env on this machine points at production.
 *
 *   node scripts/face-tagging-progress.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks += 1;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures += 1; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label,
    `קיבלנו ${JSON.stringify(actual)}, ציפינו ${JSON.stringify(expected)}`);
}
function head(t) { console.log(`\n${t}`); }

let mongod;

async function main() {
  console.log('=== התקדמות תיוג פנים — waiting מול no_consent מול expired ===');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'face_progress_test' } });
  const uri = mongod.getUri();
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri);
  ok(/127\.0\.0\.1|localhost/.test(uri), 'מסד נתונים מקומי וזמני בלבד', uri);

  const { Photo } = require('../src/models');
  const tagging = require('../src/services/faceTagging.service');

  head('פרצוף בלי הסכמת הורים אינו "ממתין", ופרצוף שפג תוקפו אינו "בלי הסכמה"');

  const classroomId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const namedChildId = new mongoose.Types.ObjectId();
  const embedding = new Array(8).fill(0.125);
  const now = new Date();
  const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

  // תמונה א: שני פרצופים עם embedding — אחד כבר מתויג, אחד לא. נסרקה
  // עכשיו, כדי שלא תיכנס בטעות ל"פג תוקף".
  await Photo.create({
    key: 'a.jpg',
    source: 'staff',
    branch_id: branchId,
    classroom_id: classroomId,
    date: '2026-09-01',
    face_scan_status: 'done',
    face_scanned_at: now,
    faces: [
      {
        bbox: [0, 0, 10, 10], det_score: 0.95, child_id: namedChildId, embedding,
      },
      { bbox: [10, 10, 20, 20], det_score: 0.8, embedding }, // unnamed, WITH embedding
    ],
  });

  // תמונה ב: פרצוף אחד בלי embedding, נסרקה עכשיו — כיתה/יום בלי הסכמת
  // הורים (facePurgeJob לא הספיק לגעת בה).
  await Photo.create({
    key: 'b.jpg',
    source: 'staff',
    branch_id: branchId,
    classroom_id: classroomId,
    date: '2026-09-02',
    face_scan_status: 'done',
    face_scanned_at: now,
    faces: [
      { bbox: [0, 0, 10, 10], det_score: 0.7 }, // unnamed, NO embedding
    ],
  });

  // תמונה ג: פרצוף אחד בלי embedding, נסרקה לפני 40 יום — מעבר ל-
  // EMBEDDING_TTL_DAYS (30), כלומר facePurgeJob כבר מחק את המספרים. זו לא
  // בעיית הסכמה: אולי כן הייתה הסכמה, והתמונה פשוט ישנה מדי.
  await Photo.create({
    key: 'c.jpg',
    source: 'staff',
    branch_id: branchId,
    classroom_id: classroomId,
    date: '2026-08-01',
    face_scan_status: 'done',
    face_scanned_at: fortyDaysAgo,
    faces: [
      { bbox: [0, 0, 10, 10], det_score: 0.6 }, // unnamed, NO embedding, ישן
    ],
  });

  const progress = await tagging.progress({ classroomIds: [classroomId] });
  eq(progress.faces, 4, 'faces = 4');
  eq(progress.named, 1, 'named = 1');
  eq(progress.waiting, 1, 'waiting = 1 (רק הפרצוף הלא-מתויג עם embedding)');
  eq(progress.no_consent, 1, 'no_consent = 1 (הפרצוף הטרי בלי embedding)');
  eq(progress.expired, 1, 'expired = 1 (הפרצוף הישן בלי embedding)');
  eq(progress.not_a_child, 0, 'not_a_child = 0');

  const q = await tagging.queue({ classroomIds: [classroomId], limit: 12 });
  eq(q.length, 1, 'queue() מחזיר פרצוף אחד בלבד');
  if (q.length === 1) {
    eq(q[0].det_score, 0.8, 'הפרצוף בתור הוא זה שיש לו embedding');
  }

  head('סיכום');
  console.log(`${checks} בדיקות, ${failures} נכשלו`);

  await mongoose.disconnect();
  await mongod.stop();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  if (mongod) await mongod.stop();
  process.exit(1);
});
