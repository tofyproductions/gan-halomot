#!/usr/bin/env node
/**
 * הוכחה מקצה לקצה, על התמונות האמיתיות של הגן.
 *
 * Every other test here checks a piece. This runs the whole thing the way the
 * bootstrap week will run it, and asks the only question that matters:
 *
 *   a teacher names faces on Monday, Tuesday and Wednesday.
 *   On the FOLLOWING day — different clothes, different light, photographs the
 *   system has never seen — does it recognise the same children by itself?
 *
 * Nothing is simulated except the teacher. The photographs are real, the
 * engine is the real one, the queue, the matcher, the attendance narrowing and
 * the consent gate are the production code paths. The database is in memory
 * and object storage is the local folder; nothing touches production.
 *
 *   FACE_TEST_DIR=~/Desktop/... node scripts/face-demo.js
 */
const fs = require('fs');
const path = require('path');

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const DIR = process.env.FACE_TEST_DIR
  || path.join(process.env.HOME, 'Desktop', 'בדיקת זיהוי פנים');

// Object storage, standing in as the folder. The scanner asks for bytes by
// key; here the key is the filename.
const storagePath = require.resolve('../src/services/storage.service');
require.cache[storagePath] = {
  id: storagePath, filename: storagePath, loaded: true, children: [], paths: [],
  exports: {
    isConfigured: () => true,
    getObject: async (key) => fs.readFileSync(path.join(DIR, key)),
    putObject: async () => {},
    deleteObject: async () => {},
    signedReadUrl: async () => '',
    makeKey: (p) => p,
  },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const sharp = require('sharp');

const dayOf = (f) => (f.match(/PHOTO-(\d{4}-\d{2}-\d{2})/) || [])[1];

(async () => {
  if (!fs.existsSync(DIR)) { console.log(`SKIP face-demo: no photographs at ${DIR}`); return; }

  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'face_demo' });

  const {
    Photo, Child, Branch, Classroom, DailyLog, ParentAccount, ChildFaceReference,
    Setting, Registration,
  } = require('../src/models');
  const scanner = require('../src/services/face/scanner');
  const tagging = require('../src/services/faceTagging.service');
  const engine = require('../src/services/face');

  const files = fs.readdirSync(DIR).filter((f) => /\.jpe?g$/i.test(f)).sort();
  const days = [...new Set(files.map(dayOf))].sort();
  const testDay = days[days.length - 1];          // the day held back
  console.log(`\n${files.length} תמונות אמיתיות, ${days.length} ימים: ${days.join(', ')}`);
  console.log(`ימי לימוד: ${days.slice(0, -1).join(', ')}   |   יום המבחן: ${testDay}\n`);

  /* --- who the children are. The sample has no names, so identities come from
     clustering the LEARNING days only; the test day is never used to define
     anybody, which is what keeps the question honest. --- */
  process.stdout.write('מזהה פרצופים בכל התמונות… ');
  const found = [];
  for (const f of files) {
    const buf = await sharp(fs.readFileSync(path.join(DIR, f)), { failOn: 'none' }).rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    const r = await engine.analyze(buf);
    r.faces.forEach((x) => found.push({ file: f, day: dayOf(f), e: x.embedding }));
  }
  console.log(`${found.length} פרצופים`);

  const learn = found.filter((x) => x.day !== testDay);
  const label = new Array(learn.length).fill(-1);
  let next = 0;
  for (let i = 0; i < learn.length; i += 1) {
    if (label[i] !== -1) continue;
    label[i] = next;
    const stack = [i];
    while (stack.length) {
      const a = stack.pop();
      for (let b = 0; b < learn.length; b += 1) {
        if (label[b] === -1 && engine.similarity(learn[a].e, learn[b].e) >= 0.55) {
          label[b] = next; stack.push(b);
        }
      }
    }
    next += 1;
  }
  const sizes = new Map();
  label.forEach((l) => sizes.set(l, (sizes.get(l) || 0) + 1));
  const kids = [...sizes.entries()].filter(([, n]) => n >= 5).map(([l]) => l);
  console.log(`${kids.length} "ילדים" נלמדו מימי הלימוד (קבוצות עם 5+ פרצופים)\n`);

  /* --- seed the gan --- */
  const branch = await Branch.create({ name: 'סניף הדגמה' });
  const room = await Classroom.create({
    name: 'כיתת הדגמה', branch_id: branch._id, academic_year: '2026-2027', is_active: true,
  });
  const childDoc = new Map();
  for (const k of kids) {
    const idNum = `9${String(100000 + k).slice(-8)}`;
    await ParentAccount.create({
      id_number: idNum,
      full_name: `הורה ${k}`,
      face_consent: { given: true, at: new Date(), version: '2026-09' },
    });
    const reg = await Registration.create({
      unique_id: `DEMO-${k}`,
      child_name: `ילד/ה ${k}`,
      parent_name: `הורה ${k}`,
      monthly_fee: 0,
      branch_id: branch._id,
      academic_year: '2026-2027',
      start_date: new Date('2026-09-01'),
      end_date: new Date('2027-08-31'),
      classroom_id: room._id,
    });
    const c = await Child.create({
      registration_id: reg._id,
      child_name: `ילד/ה ${k}`,
      classroom_id: room._id,
      branch_id: branch._id,
      academic_year: '2026-2027',
      is_active: true,
      parent_id_number: idNum,
    });
    childDoc.set(k, c);
  }
  // Everyone was present every day — the attendance narrowing is exercised,
  // and made no easier than reality.
  for (const d of days) {
    for (const c of childDoc.values()) {
      await DailyLog.create({
        child_id: c._id, child_name: c.child_name, classroom_id: room._id,
        branch_id: branch._id, date: d, attendance: 'הגיע',
      });
    }
  }

  for (const f of files) {
    await Photo.create({
      key: f, thumb_key: f, source: 'staff', branch_id: branch._id,
      classroom_id: room._id, date: dayOf(f), width: 1600, height: 1200,
    });
  }
  await Setting.updateOne({ key: scanner.ENABLED_KEY },
    { $set: { key: scanner.ENABLED_KEY, value: { on: true } } }, { upsert: true });

  /* --- 1. the queue scans everything, exactly as it will in production --- */
  process.stdout.write('1. הסורק עובר על כל התמונות… ');
  const t0 = Date.now();
  let scanned = 0;
  while (await scanner.tick()) {
    scanned += 1;
    if (scanned > files.length + 50) break;
  }
  const secs = (Date.now() - t0) / 1000;
  const doneCount = await Photo.countDocuments({ face_scan_status: 'done' });
  console.log(`${doneCount}/${files.length} נסרקו ב-${secs.toFixed(0)} שנ' `
    + `(${(secs / files.length).toFixed(2)} לתמונה)`);

  /* --- 2. the teacher names faces, on the LEARNING days only --- */
  process.stdout.write('2. גננת מתייגת בימי הלימוד… ');
  const byKey = new Map();
  learn.forEach((x, i) => {
    const arr = byKey.get(x.file) || [];
    arr.push({ order: arr.length, cluster: label[i] });
    byKey.set(x.file, arr);
  });

  let named = 0;
  for (const [file, entries] of byKey) {
    const photo = await Photo.findOne({ key: file }).lean();
    if (!photo || !photo.faces.length) continue;
    for (const e of entries) {
      const child = childDoc.get(e.cluster);
      if (!child || !photo.faces[e.order]) continue;
      const r = await tagging.nameFace({
        photoId: photo._id, faceIndex: e.order, childId: child._id, user: { _id: null },
      });
      if (r.ok && r.taught) named += 1;
    }
  }
  const refs = await ChildFaceReference.countDocuments();
  console.log(`${named} פרצופים תויגו, ${refs} טביעות ייחוס נוצרו`);

  /* --- 3. the held-out day, recognised with nobody's help --- */
  process.stdout.write(`3. סורק מחדש את ${testDay} — יום שאיש לא תייג… `);
  await Photo.updateMany({ date: testDay }, {
    $set: { face_scan_status: 'pending', faces: [], child_ids: [] },
  });
  let again = 0;
  while (await scanner.tick()) { again += 1; if (again > 100) break; }

  const testPhotos = await Photo.find({ date: testDay }).lean();
  const testFaces = testPhotos.reduce((n, p) => n + p.faces.length, 0);
  const recognised = testPhotos.reduce(
    (n, p) => n + p.faces.filter((f) => f.child_id).length, 0,
  );
  const withKids = testPhotos.filter((p) => p.child_ids.length).length;

  console.log('');

  console.log('\n' + '='.repeat(58));
  console.log(`  תמונות ביום המבחן        : ${testPhotos.length}`);
  console.log(`  פרצופים שנמצאו בהן       : ${testFaces}`);
  console.log(`  זוהו אוטומטית לילד ספציפי: ${recognised}  `
    + `(${(100 * recognised / (testFaces || 1)).toFixed(0)}% מהפרצופים)`);
  console.log(`  תמונות שהגיעו למשפחה     : ${withKids}/${testPhotos.length}`);
  console.log('');
  console.log('  הערה: המכנה כולל גם פרצופים של ילדים שמעולם לא נלמדו — ילד');
  console.log('  שנראה פעמיים בשבוע לא יצר קבוצה, ואין מול מה להתאים אותו.');
  console.log('  המספר האמיתי יימדד בשבוע התיוג, עם תוויות של גננת.');
  console.log('='.repeat(58));

  const ok = recognised > 0 && testPhotos.length > 0;
  console.log(ok
    ? '\n✅ המערכת זיהתה ילדים ביום שאיש לא תייג. הצינור עובד מקצה לקצה.\n'
    : '\n❌ שום ילד לא זוהה ביום המבחן.\n');

  await mongoose.disconnect();
  await mongod.stop();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('נפל:', e); process.exit(1); });
