#!/usr/bin/env node
/**
 * סימון ומחיקה של כמה תמונות בבת אחת.
 *
 * A teacher back from the garden with forty photographs of the same handful of
 * children should not open forty dialogs, and forty separate requests on a
 * gan's wifi are forty chances for one to fail halfway and leave the work half
 * done.
 *
 * Two rules matter here more than the convenience.
 *
 * PERMISSION IS CHECKED PER PHOTOGRAPH. Multi-select is exactly where it is
 * tempting to assume every id came from the screen the teacher is looking at.
 * A request can be sent without that screen.
 *
 * 'add' IS THE DEFAULT. Different photographs already carry different tags,
 * and a 'replace' across a selection would erase what is on each of them —
 * silent destruction that cannot be undone. Replacing is something you ask
 * for.
 *
 *   node scripts/photo-bulk.test.js
 */
const net = require('net');
const http = require('http');
const crypto = require('crypto');

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

// Object storage as a map, watched: the point is also that a rejected upload
// does not leave orphaned bytes behind.
const bucket = new Map();
const storagePath = require.resolve('../src/services/storage.service');
require.cache[storagePath] = {
  id: storagePath, filename: storagePath, loaded: true, children: [], paths: [],
  exports: {
    isConfigured: () => true,
    putObject: async ({ key, body }) => { bucket.set(key, body); },
    getObject: async (key) => bucket.get(key),
    deleteObject: async (key) => { bucket.delete(key); },
    signedReadUrl: async (key) => `https://example.test/${key}`,
    // Same shape as the real one: a random name and a .jpg extension. The
    // first version returned the prefix unchanged, which has no extension —
    // so `key.replace(/\.jpg$/, '_t.jpg')` produced the SAME key for the full
    // size and the thumbnail, they overwrote each other, and the test's object
    // count was quietly measuring one file instead of two.
    makeKey: (p, ext = 'jpg') => `${p}/${crypto.randomBytes(8).toString('hex')}.${ext}`,
    READ_URL_TTL_S: 1800,
  },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const sharp = require('sharp');

const PASSWORD = 'test1234';
let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ✅ ${label}`);
  else { failures += 1; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
};
const eq = (a, b, label) => ok(a === b, label, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);

let PORT = 0;
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

function post({ path, token, fields, files }) {
  const boundary = `----t${Date.now()}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  for (const f of files || []) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="${f.name}"\r\nContent-Type: image/jpeg\r\n\r\n`));
    parts.push(f.buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
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
    req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function main() {
  console.log('=== פעולות קבוצתיות ===');
  const mongod = await MongoMemoryServer.create();
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'dup-secret';
  process.env.PARENT_SECRET = 'dup-parent';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  delete process.env.PLATFORM_MONGODB_URI;

  const express = require('express');
  const originalListen = express.application.listen;
  express.application.listen = function patched(...a) { return originalListen.apply(this, a); };
  require('../src/index.js');
  // The request object emits 'error' on a refused connection, and without a
  // handler that rejection is unhandled and the promise never settles — which
  // is a hung test rather than a failing one, and far harder to read.
  for (let i = 0; i < 100; i += 1) {
    const code = await new Promise((res) => {
      const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' },
        (x) => { x.resume(); res(x.statusCode); });
      r.on('error', () => res(0));
      r.setTimeout(1000, () => { r.destroy(); res(0); });
    });
    if (code === 200) break;
    await sleep(200);
  }

  const {
    User, Branch, Classroom, Photo,
  } = require('../src/models');
  const branch = await Branch.create({ name: 'סניף' });
  const room = await Classroom.create({
    name: 'כיתה', branch_id: branch._id, academic_year: '2026-2027', is_active: true,
  });
  // סניף אחר, כדי שהבדיקה החוצה-סניפים תבדוק גבול אמיתי ולא רק חדר שכן.
  const otherBranch = await Branch.create({ name: 'סניף אחר' });
  const other = await Classroom.create({
    name: 'כיתה ב', branch_id: otherBranch._id, academic_year: '2026-2027', is_active: true,
  });
  await User.create({
    email: 'hz@t.local',
    full_name: 'תמר',
    id_number: '920000002',
    role: 'teacher',
    branch_id: otherBranch._id,
    password_hash: await bcrypt.hash(PASSWORD, 10),
    password_set: true,
    is_active: true,
  });
  await User.create({
    email: 'g@t.local',
    full_name: 'גננת',
    id_number: '920000001',
    role: 'teacher',
    branch_id: branch._id,
    password_hash: await bcrypt.hash(PASSWORD, 10),
    password_set: true,
    is_active: true,
  });

  const login = await new Promise((resolve) => {
    // Buffer, not a string. `'גננת'.length` is 4 characters and 8 bytes, so a
    // Content-Length taken from the string truncates the body mid-JSON and the
    // login fails with a parse error three layers away from the cause.
    const payload = Buffer.from(JSON.stringify({
      full_name: 'גננת', id_number: '920000001', password: PASSWORD,
    }));
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/auth/login-password',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString())));
    });
    req.write(payload);
    req.end();
  });
  const token = login.token;

  function postJson(path, tok, body) {
    const payload = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: PORT, path, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          Authorization: `Bearer ${tok}`,
        },
      }, (res) => {
        const c = [];
        res.on('data', (x) => c.push(x));
        res.on('end', () => {
          const text = Buffer.concat(c).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, body: json, text });
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  const loginAs = (name, id) => new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({ full_name: name, id_number: id, password: PASSWORD }));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/auth/login-password', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString()).token));
    });
    req.write(payload); req.end();
  });
  const tamar = await loginAs('תמר', '920000002');

  const sharpLib = require('sharp');
  const mkJpeg = (seed) => sharpLib({
    create: { width: 700, height: 500, channels: 3, background: { r: seed, g: 90, b: 160 } },
  }).jpeg({ quality: 80 }).toBuffer();

  const upload = async (classroom, n) => {
    const files = [];
    for (let i = 0; i < n; i += 1) files.push({ name: `p${seedCounter}.jpg`, buffer: await mkJpeg(seedCounter += 3) });
    const r = await post({ path: '/api/photos/upload', token, fields: { classroom_id: String(classroom._id) }, files });
    return (r.body.photos || []).map((p) => String(p._id || p.id));
  };
  let seedCounter = 10;

  const { Child, Registration } = require('../src/models');
  const mkChild = async (name, roomDoc, uid) => {
    const reg = await Registration.create({
      unique_id: uid, child_name: name, parent_name: 'הורה', monthly_fee: 0,
      branch_id: branch._id, academic_year: '2026-2027',
      start_date: new Date('2026-09-01'), end_date: new Date('2027-08-31'),
      classroom_id: roomDoc._id,
    });
    return Child.create({
      registration_id: reg._id, child_name: name, classroom_id: roomDoc._id,
      branch_id: branch._id, academic_year: '2026-2027', is_active: true,
    });
  };
  const dani = await mkChild('דני', room, 'B-1');
  const maya = await mkChild('מאיה', room, 'B-2');
  const foreign = await mkChild('רוני', other, 'B-3');

  console.log('\n1. סימון קבוצתי — כמה ילדים על כמה תמונות');
  const ids = await upload(room, 4);
  eq(ids.length, 4, 'ארבע תמונות הועלו');

  let r = await postJson('/api/photos/bulk-tag', token, {
    photo_ids: ids, child_ids: [String(dani._id), String(maya._id)],
  });
  eq(r.status, 200, 'הסימון עבר');
  eq(r.body.changed, 4, 'כל הארבע סומנו');
  let rows = await Photo.find({ _id: { $in: ids } }).select('child_ids').lean();
  ok(rows.every((x) => x.child_ids.length === 2), 'בכל תמונה שני ילדים',
    JSON.stringify(rows.map((x) => x.child_ids.length)));

  console.log('\n2. ברירת המחדל מוסיפה, לא מוחקת');
  r = await postJson('/api/photos/bulk-tag', token, {
    photo_ids: [ids[0]], child_ids: [String(dani._id)],
  });
  rows = await Photo.findById(ids[0]).select('child_ids').lean();
  eq(rows.child_ids.length, 2, 'מאיה נשארה מסומנת — add לא מוחק');

  console.log('\n3. החלפה מוחקת, אבל רק כשמבקשים');
  r = await postJson('/api/photos/bulk-tag', token, {
    photo_ids: [ids[0]], child_ids: [String(dani._id)], mode: 'replace',
  });
  rows = await Photo.findById(ids[0]).select('child_ids').lean();
  eq(rows.child_ids.length, 1, 'נשאר רק מי שנבחר');

  console.log('\n4. ילד מכיתה אחרת נדחה');
  r = await postJson('/api/photos/bulk-tag', token, {
    photo_ids: [ids[1]], child_ids: [String(foreign._id)], mode: 'replace',
  });
  rows = await Photo.findById(ids[1]).select('child_ids').lean();
  eq(rows.child_ids.length, 0, 'לא הודבק ילד שאינו בכיתה');

  console.log('\n5. גננת מסניף אחר לא נוגעת בתמונות שלי');
  const hzIds = await upload(other, 1);
  r = await postJson('/api/photos/bulk-tag', tamar, {
    photo_ids: ids, child_ids: [String(foreign._id)],
  });
  eq(r.body.changed, 0, 'אף תמונה לא שונתה');
  eq(r.body.refused, ids.length, 'וכולן נדחו במפורש');

  console.log('\n6. מחיקה קבוצתית');
  const before = await Photo.countDocuments();
  const bucketBefore = bucket.size;
  r = await postJson('/api/photos/bulk-delete', token, { photo_ids: ids.slice(0, 2) });
  eq(r.body.deleted, 2, 'שתיים נמחקו');
  eq(await Photo.countDocuments(), before - 2, 'והשורות ירדו');
  ok(bucket.size === bucketBefore - 4, 'וגם הקבצים באחסון (מלאה + ממוזערת לכל אחת)',
    `${bucketBefore} -> ${bucket.size}`);

  console.log('\n7. מחיקה חוצה סניפים נדחית');
  r = await postJson('/api/photos/bulk-delete', tamar, { photo_ids: ids.slice(2) });
  eq(r.body.deleted, 0, 'לא נמחק כלום');
  ok(await Photo.findById(ids[2]), 'והתמונה עדיין שם');

  /**
   * תיוג מהגלריה אומר "הילד בתמונה", לא "זה הפרצוף שלו", ולכן הוא בדרך כלל
   * לא מלמד כלום — וזה הפתיע בפועל: עשר תמונות מתויגות לילד, שמונה טביעות.
   * המקרה היחיד שבו אין עמימות הוא פרצוף אחד פתוח וילד אחד שנוסף.
   */
  console.log('\n8. בחירה מרובה מלמדת רק כשאין שום עמימות');
  const { ParentAccount, ChildFaceReference } = require('../src/models');
  await ParentAccount.create({
    id_number: '930000001', full_name: 'הורה של דני',
    face_consent: { given: true, at: new Date(), version: '2026-09' },
  });
  await Child.updateOne({ _id: dani._id }, { $set: { parent_id_number: '930000001' } });

  // וקטור יחידה — התוכן לא משנה כאן, רק שהוא קיים ונשמר כמו שהוא.
  const vec = (k) => Array.from({ length: 512 }, (_, i) => (i === k ? 1 : 0));
  const withFaces = async (classroomDoc, faces) => {
    const [id] = await upload(classroomDoc, 1);
    await Photo.updateOne({ _id: id }, {
      $set: { face_scan_status: 'done', faces },
    });
    return id;
  };
  const openFace = (k) => ({
    bbox: [10, 10, 60, 60], det_score: 0.9, child_id: null, embedding: vec(k),
  });

  const one = await withFaces(room, [openFace(0)]);
  r = await postJson('/api/photos/bulk-tag', token, {
    photo_ids: [one], child_ids: [String(dani._id)],
  });
  eq(r.body.taught, 1, 'פרצוף אחד וילד אחד — נוצרה טביעה');
  let after = await Photo.findById(one).select('faces child_ids').lean();
  eq(String(after.faces[0].child_id), String(dani._id), 'והפרצוף עצמו נושא את השם');
  eq(after.faces[0].decided_by, 'staff', 'כהחלטת אדם');
  eq(await ChildFaceReference.countDocuments({ child_id: dani._id }), 1, 'טביעה אחת בדיוק');

  const two = await withFaces(room, [openFace(1), openFace(2)]);
  r = await postJson('/api/photos/bulk-tag', token, {
    photo_ids: [two], child_ids: [String(dani._id)],
  });
  eq(r.body.taught, 0, 'שני פרצופים פתוחים — לא ידוע מי מהם, לא לומדים');
  after = await Photo.findById(two).select('faces child_ids').lean();
  ok(after.faces.every((f) => !f.child_id), 'ואף פרצוף לא קיבל שם');
  eq(after.child_ids.length, 1, 'אבל התמונה כן מסומנת — זו הערה של אדם');

  const twoKids = await withFaces(room, [openFace(3)]);
  r = await postJson('/api/photos/bulk-tag', token, {
    photo_ids: [twoKids], child_ids: [String(dani._id), String(maya._id)],
  });
  eq(r.body.taught, 0, 'שני ילדים על פרצוף אחד — עמום, לא לומדים');

  // מאיה בלי הסכמת הורים: התיוג נשמר, הטביעה לא נוצרת. אותו כלל כמו ב"מי זה?".
  const noConsent = await withFaces(room, [openFace(4)]);
  r = await postJson('/api/photos/bulk-tag', token, {
    photo_ids: [noConsent], child_ids: [String(maya._id)],
  });
  eq(r.body.taught, 0, 'בלי הסכמה — לא נוצרת טביעה');
  after = await Photo.findById(noConsent).select('faces child_ids').lean();
  eq(String(after.faces[0].child_id), String(maya._id), 'אבל הפרצוף כן מסומן');
  eq(await ChildFaceReference.countDocuments({ child_id: maya._id }), 0, 'ואין שום מידע ביומטרי עליה');

  console.log('\n9. בקשה ריקה נדחית');
  r = await postJson('/api/photos/bulk-delete', token, { photo_ids: [] });
  eq(r.status, 400, 'רשימה ריקה היא שגיאה, לא "מחק הכל"');

  console.log(`\n${failures ? '❌' : '✅'} ${failures ? `${failures} שגויים` : 'הכל עבר'}`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('נפל:', e); process.exit(1); });
