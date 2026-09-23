#!/usr/bin/env node
/**
 * "מי זה?" — the teachers' tagging queue, end to end.
 *
 * The rules worth protecting here are not about recognition. They are about
 * what a teacher is offered and what her answer does:
 *
 *   - the buttons are the children who were IN THE ROOM that morning, taken
 *     from the daily board, not a list of the whole gan;
 *   - naming a face creates a reference, which is the only reason any of this
 *     gets easier instead of being data entry forever;
 *   - a teacher cannot name a child outside her own rooms, and cannot see a
 *     face from someone else's branch at all;
 *   - a face already named, or marked "not a child", never comes back.
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL. dotenv is stubbed before anything
 * loads it; server/.env on this machine points at production.
 *
 *   node scripts/face-tagging-e2e.test.js
 */
const net = require('net');
const http = require('http');

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const PASSWORD = 'test1234';
let failures = 0;
let checks = 0;

const ok = (cond, label, detail = '') => {
  checks += 1;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures += 1; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
};
const eq = (a, b, label) => ok(a === b, label, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const head = (t) => console.log(`\n${t}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let PORT = 0;

function request({
  method = 'GET', path, token, body,
}) {
  return new Promise((resolve, reject) => {
    const h = {};
    let payload = null;
    if (body !== undefined && body !== null) {
      payload = Buffer.from(JSON.stringify(body));
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = payload.length;
    }
    if (token) h.Authorization = `Bearer ${token}`;
    const req = http.request({
      host: '127.0.0.1', port: PORT, path, method, headers: h,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await request({ path: '/api/health' });
      if (r.status === 200) return true;
    } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('השרת לא ענה על /api/health');
}

async function login(fullName, idNumber) {
  const r = await request({
    method: 'POST',
    path: '/api/auth/login-password',
    body: { full_name: fullName, id_number: idNumber, password: PASSWORD },
  });
  if (r.status !== 200 || !r.body?.token) throw new Error(`התחברות נכשלה: ${r.status} ${r.text}`);
  return r.body.token;
}

/**
 * A fake embedding on a chosen axis.
 *
 * The engine is not involved here and must not be: this test is about the
 * queue's rules, and loading 191MB of weights to assert who appears on a
 * button would make it slow enough that nobody runs it.
 */
function axis(i) {
  const v = new Array(512).fill(0);
  v[i] = 1;
  return v;
}

let mongod = null;

async function main() {
  console.log('=== "מי זה?" — תור התיוג, בדיקת קצה-אל-קצה ===');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_face_e2e' } });
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'face-e2e-secret';
  process.env.PARENT_SECRET = 'face-e2e-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  delete process.env.PLATFORM_MONGODB_URI;

  const express = require('express');
  const originalListen = express.application.listen;
  express.application.listen = function patched(...args) {
    global.__server = originalListen.apply(this, args);
    return global.__server;
  };
  require('../src/index.js');
  await waitForServer();
  express.application.listen = originalListen;

  const host = String(mongoose.connection.host || '');
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
    throw new Error(`מסד הנתונים אינו מקומי (${host}) — עוצרים`);
  }
  console.log(`\nשרת עלה על :${PORT}, מסד נתונים בזיכרון (${host})`);

  const {
    User, Branch, Classroom, Child, Registration, Photo, DailyLog, ChildFaceReference,
  } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const YEAR = '2026-2027';
  const ks = await Branch.create({ name: 'כפר סבא', address: 'משה דיין 9' });
  const other = await Branch.create({ name: 'הרצליה', address: 'סוקולוב 1' });
  const room = await Classroom.create({
    name: 'תינוקייה א', branch_id: ks._id, academic_year: YEAR, is_active: true,
  });
  const otherRoom = await Classroom.create({
    name: 'תינוקייה הרצליה', branch_id: other._id, academic_year: YEAR, is_active: true,
  });

  // Consent is the boundary of the whole feature, so every child here carries
  // a parent id and the parent accounts below decide who may be recognised.
  const PARENT_ID = { 'F-1': '300000001', 'F-2': '300000002', 'F-3': '300000003', 'F-4': '300000004' };

  const mkChild = async (name, roomDoc, branch, uid) => {
    const reg = await Registration.create({
      unique_id: uid,
      child_name: name,
      parent_name: `הורה של ${name}`,
      monthly_fee: 2000,
      branch_id: branch._id,
      academic_year: YEAR,
      start_date: new Date('2026-09-01'),
      end_date: new Date('2027-08-31'),
      classroom_id: roomDoc._id,
    });
    return Child.create({
      registration_id: reg._id,
      child_name: name,
      classroom_id: roomDoc._id,
      branch_id: branch._id,
      academic_year: YEAR,
      is_active: true,
      parent_id_number: PARENT_ID[uid],
    });
  };

  const dani = await mkChild('דני לוי', room, ks, 'F-1');
  const maya = await mkChild('מאיה כהן', room, ks, 'F-2');
  const absent = await mkChild('יונתן אבן', room, ks, 'F-3');
  const herzliya = await mkChild('רוני גל', otherRoom, other, 'F-4');

  const mkUser = (o) => User.create({
    password_hash: passwordHash, password_set: true, is_active: true, ...o,
  });
  await mkUser({
    email: 'gan@e2e.local', full_name: 'שירה גננת', id_number: '910000001', role: 'teacher', branch_id: ks._id, position: 'גננת',
  });
  await mkUser({
    email: 'hz@e2e.local', full_name: 'תמר גננת', id_number: '910000002', role: 'teacher', branch_id: other._id, position: 'גננת',
  });
  const shira = await login('שירה גננת', '910000001');
  const tamar = await login('תמר גננת', '910000002');

  // דני's family agreed to face recognition; מאיה's did not. Both children are
  // in the room, both are photographed, both appear in the classroom gallery —
  // the only difference is that nothing may be learned about מאיה.
  const { ParentAccount } = require('../src/models');
  await ParentAccount.create({
    id_number: PARENT_ID['F-1'],
    full_name: 'הורה של דני',
    face_consent: { given: true, at: new Date(), version: '2026-09' },
  });
  await ParentAccount.create({
    id_number: PARENT_ID['F-2'],
    full_name: 'הורה של מאיה',
    face_consent: { given: false },
  });
  await ParentAccount.create({
    id_number: PARENT_ID['F-4'],
    full_name: 'הורה של רוני',
    face_consent: { given: true, at: new Date(), version: '2026-09' },
  });

  const DATE = '2026-09-22';
  // The daily board: דני and מאיה came in, יונתן did not.
  await DailyLog.create({
    child_id: dani._id, child_name: dani.child_name, classroom_id: room._id, branch_id: ks._id, date: DATE, attendance: 'הגיע',
  });
  await DailyLog.create({
    child_id: maya._id, child_name: maya.child_name, classroom_id: room._id, branch_id: ks._id, date: DATE, attendance: 'הגיע',
  });
  await DailyLog.create({
    child_id: absent._id, child_name: absent.child_name, classroom_id: room._id, branch_id: ks._id, date: DATE, attendance: 'חסר',
  });

  const mkPhoto = (classroomDoc, branch, faces) => Photo.create({
    key: `photos/${Math.random().toString(36).slice(2)}.jpg`,
    thumb_key: 'photos/t.jpg',
    source: 'staff',
    branch_id: branch._id,
    classroom_id: classroomDoc._id,
    date: DATE,
    width: 1600,
    height: 1200,
    face_scan_status: 'done',
    face_scanned_at: new Date(),
    faces,
  });

  const photo = await mkPhoto(room, ks, [
    {
      bbox: [100, 100, 200, 200], det_score: 0.92, child_id: null, embedding: axis(0),
    },
    {
      bbox: [400, 100, 500, 200], det_score: 0.88, child_id: null, embedding: axis(1),
    },
  ]);
  const foreign = await mkPhoto(otherRoom, other, [
    {
      bbox: [10, 10, 60, 60], det_score: 0.95, child_id: null, embedding: axis(2),
    },
  ]);

  /* ---------------------------------------------------------------- */
  head('1. התור מציג רק פרצופים שממתינים, והחזק ביותר ראשון');
  const q1 = await request({ path: `/api/face-tagging/queue?classroom_id=${room._id}`, token: shira });
  eq(q1.status, 200, 'התור נטען');
  eq((q1.body.faces || []).length, 2, 'שני פרצופים ממתינים');
  eq(q1.body.faces?.[0]?.det_score, 0.92, 'הברור ביותר מוצע ראשון');
  eq(q1.body.progress?.waiting, 2, 'המונה מראה שניים');

  // הכתובת שחוזרת נצרכת דרך לקוח ה-API, שה-baseURL שלו כבר מסתיים ב-/api.
  // נתיב שמתחיל ב-/api נותן /api/api/... — 404 שמצטייר כריבוע שבור, בלי
  // הודעת שגיאה בשום מקום. נבדק כאן כמו שהלקוח מחבר אותו בפועל.
  const cropPath = q1.body.faces?.[0]?.crop_url || '';
  ok(!cropPath.startsWith('/api'), 'הנתיב לא חוזר על התחילית /api');
  eq(
    new URL(`/api${cropPath}`, 'http://x').pathname,
    `/api/face-tagging/crop/${photo._id}/0`,
    'הצירוף עם בסיס הלקוח מגיע לראוט האמיתי',
  );

  /* ---------------------------------------------------------------- */
  head('2. הכפתורים הם מי שנכח, לא כל הגן');
  const cand = await request({
    path: `/api/face-tagging/candidates?classroom_id=${room._id}&date=${DATE}`, token: shira,
  });
  eq(cand.status, 200, 'רשימת המועמדים נטענת');
  const names = (cand.body.children || []).map((c) => c.name);
  ok(names.includes('דני לוי'), 'מי שההורים שלו הסכימו — מוצע');
  ok(!names.includes('מאיה כהן'), 'מי שההורים שלו לא הסכימו — לא מוצע כלל');
  ok(!names.includes('יונתן אבן'), 'מי שסומן חסר — לא מוצע');
  ok(!names.includes('רוני גל'), 'ילד מסניף אחר — בוודאי שלא');
  ok(names.every(Boolean), 'לכל כפתור יש שם');

  // "ילד אחר מהכיתה": הרשימה הקצרה יכולה להצטמצם לשם אחד, ואז אין דרך להגיע
  // לשאר. הרשימה המלאה מתעלמת מנוכחות ומהסכמה, ומסמנת מי חסר הסכמה — התיוג
  // מותר, הלמידה לא.
  const full = await request({
    path: `/api/face-tagging/candidates?classroom_id=${room._id}&all=1`, token: shira,
  });
  eq(full.status, 200, 'הרשימה המלאה נטענת');
  const fullNames = (full.body.children || []).map((c) => c.name);
  ok(fullNames.includes('מאיה כהן'), 'ילדה בלי הסכמה כן מופיעה ברשימה המלאה');
  ok(fullNames.includes('יונתן אבן'), 'גם מי שסומן חסר');
  ok(!fullNames.includes('רוני גל'), 'אבל ילד מסניף אחר — לא');
  eq(
    (full.body.children || []).find((c) => c.name === 'מאיה כהן')?.consent,
    false,
    'ומסומן שאין לה הסכמה',
  );
  eq(
    (full.body.children || []).find((c) => c.name === 'דני לוי')?.consent,
    true,
    'ולמי שיש — מסומן שיש',
  );
  const noRoom = await request({ path: '/api/face-tagging/candidates?all=1', token: shira });
  eq(noRoom.status, 400, 'רשימה מלאה בלי כיתה נדחית ולא מחזירה ערבוב של כיתות');

  /* ---------------------------------------------------------------- */
  head('3. מתן שם: התמונה מתויגת, ונוצרת טביעת ייחוס');
  const named = await request({
    method: 'POST',
    path: `/api/face-tagging/${photo._id}/0`,
    token: shira,
    body: { child_id: String(dani._id) },
  });
  eq(named.status, 200, 'השם נשמר');
  eq(named.body.references, 1, 'נוצרה טביעת ייחוס אחת');
  ok(named.body.taught, 'הפרצוף לימד את המערכת');
  ok(named.body.consent, 'ההסכמה נבדקה ונמצאה');

  const refs = await ChildFaceReference.find({ child_id: dani._id }).lean();
  eq(refs.length, 1, 'הטביעה קיימת במסד');
  eq(refs[0].source, 'staff', 'מקורה בגננת');

  const after = await Photo.findById(photo._id).select('+faces.embedding').lean();
  eq(String(after.faces[0].child_id), String(dani._id), 'הפרצוף מקושר לדני');
  eq(after.faces[0].decided_by, 'staff', 'מסומן כהחלטת אדם');
  eq(after.faces[0].confidence, null, 'החלטת אדם אינה מקבלת ציון ביטחון');
  ok(after.child_ids.map(String).includes(String(dani._id)), 'דני נוסף לתמונה');

  /* ---------------------------------------------------------------- */
  head('4. פרצוף שקיבל שם לא חוזר לתור');
  const q2 = await request({ path: `/api/face-tagging/queue?classroom_id=${room._id}`, token: shira });
  eq((q2.body.faces || []).length, 1, 'נשאר פרצוף אחד');
  eq(q2.body.faces?.[0]?.face_index, 1, 'והוא השני');
  eq(q2.body.progress?.named, 1, 'המונה סופר אחד מזוהה');

  /* ---------------------------------------------------------------- */
  head('5. "זה לא ילד" מוציא מהתור בלי לתייג');
  const skipped = await request({
    method: 'POST', path: `/api/face-tagging/${photo._id}/1`, token: shira, body: { not_a_child: true },
  });
  eq(skipped.status, 200, 'הסימון נשמר');
  const q3 = await request({ path: `/api/face-tagging/queue?classroom_id=${room._id}`, token: shira });
  eq((q3.body.faces || []).length, 0, 'התור ריק');
  const p3 = await Photo.findById(photo._id).lean();
  eq(p3.faces[1].child_id, null, 'ולא הודבק שם לאף אחד');

  /* ---------------------------------------------------------------- */
  head('6. גבול הסניף');
  const foreignQueue = await request({ path: '/api/face-tagging/queue', token: tamar });
  const seen = (foreignQueue.body.faces || []).map((f) => f.photo_id);
  ok(!seen.includes(String(photo._id)), 'גננת מהרצליה לא רואה פרצוף מכפר סבא');
  ok(seen.includes(String(foreign._id)), 'אבל כן את של עצמה');

  const crossBranch = await request({
    method: 'POST', path: `/api/face-tagging/${foreign._id}/0`, token: shira, body: { child_id: String(herzliya._id) },
  });
  eq(crossBranch.status, 403, 'תיוג תמונה של סניף אחר נדחה');

  const crossChild = await request({
    method: 'POST', path: `/api/face-tagging/${photo._id}/1`, token: shira, body: { child_id: String(herzliya._id) },
  });
  eq(crossChild.status, 403, 'הדבקת ילד מסניף אחר על תמונה שלי נדחית');

  /* ---------------------------------------------------------------- */
  head('7. ילד ללא הסכמת הורים — אפשר לתייג, אסור ללמוד');
  const noConsentPhoto = await mkPhoto(room, ks, [
    { bbox: [5, 5, 95, 95], det_score: 0.93, child_id: null, embedding: axis(7) },
  ]);
  const taggedNoConsent = await request({
    method: 'POST',
    path: `/api/face-tagging/${noConsentPhoto._id}/0`,
    token: shira,
    body: { child_id: String(maya._id) },
  });
  eq(taggedNoConsent.status, 200, 'התיוג עצמו מתקבל — זו הערה של אדם על תמונה');
  eq(taggedNoConsent.body.consent, false, 'אבל ההסכמה חסרה');
  ok(!taggedNoConsent.body.taught, 'ולכן לא נוצרה טביעה');
  eq(await ChildFaceReference.countDocuments({ child_id: maya._id }), 0,
    'אין שום מידע ביומטרי על הילדה הזו');
  const mayaPhoto = await Photo.findById(noConsentPhoto._id).lean();
  ok(mayaPhoto.child_ids.map(String).includes(String(maya._id)),
    'והתמונה כן מגיעה למשפחה שלה');

  /* ---------------------------------------------------------------- */
  head('8. פרצוף שהטביעה שלו נמחקה אינו מוצע — אין ממה ללמוד');
  const stale = await mkPhoto(room, ks, [
    { bbox: [0, 0, 80, 80], det_score: 0.9, child_id: null },
  ]);
  const q4 = await request({ path: `/api/face-tagging/queue?classroom_id=${room._id}`, token: shira });
  ok(!(q4.body.faces || []).some((f) => f.photo_id === String(stale._id)),
    'תמונה בלי טביעות אינה בתור');

  /* ---------------------------------------------------------------- */
  console.log(`\n${failures ? '❌' : '✅'} ${checks - failures}/${checks} בדיקות עברו`);
  if (failures) process.exit(1);
}

main()
  .then(async () => {
    await mongoose.disconnect().catch(() => {});
    if (mongod) await mongod.stop().catch(() => {});
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('\n❌ נפל:', e.message);
    await mongoose.disconnect().catch(() => {});
    if (mongod) await mongod.stop().catch(() => {});
    process.exit(1);
  });
