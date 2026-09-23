#!/usr/bin/env node
/**
 * אותה תמונה פעמיים — לא שגיאה, ולא סיבה לשמור אותה שוב.
 *
 * It happens constantly: a teacher re-picks the whole camera roll because she
 * cannot remember what she already sent, or taps send twice on a slow network.
 * Before this, each of those made another row, another two objects in the
 * bucket, another face scan, and two identical photographs in a family's
 * gallery.
 *
 * The fingerprint is the CONTENT, not the filename and not EXIF. This pipeline
 * strips metadata deliberately in two places — the canvas on the phone and
 * `rotate()` on the server — because a phone photograph carries GPS
 * coordinates of an address the gan does not publish. By the time a picture
 * reaches the database there is no metadata left to read. The bytes are what
 * two uploads of the same photograph agree on.
 *
 *   node scripts/photo-duplicate.test.js
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
  console.log('=== אותה תמונה פעמיים ===');
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
  const other = await Classroom.create({
    name: 'כיתה ב', branch_id: branch._id, academic_year: '2026-2027', is_active: true,
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

  // A real JPEG, and a second one that differs by a single pixel.
  const make = async (seed) => {
    const img = sharp({
      create: {
        width: 900, height: 700, channels: 3, background: { r: seed, g: 120, b: 200 },
      },
    });
    return img.jpeg({ quality: 82 }).toBuffer();
  };
  const a = await make(10);
  const b = await make(11);

  console.log('\n1. אותה תמונה, אותה כיתה');
  const first = await post({
    path: '/api/photos/upload', token, fields: { classroom_id: String(room._id) }, files: [{ name: 'a.jpg', buffer: a }],
  });
  eq(first.status, 200, 'ההעלאה הראשונה עברה');
  eq(first.body.saved, 1, 'נשמרה תמונה אחת');

  const objectsAfterFirst = bucket.size;
  const again = await post({
    path: '/api/photos/upload', token, fields: { classroom_id: String(room._id) }, files: [{ name: 'shared-again.jpg', buffer: a }],
  });
  eq(again.status, 200, 'ההעלאה השנייה לא נכשלת — זו לא שגיאה');
  eq(again.body.saved, 0, 'אבל שום דבר לא נשמר');
  eq((again.body.duplicates || []).length, 1, 'ומדווח שזו כפילות');
  eq(await Photo.countDocuments(), 1, 'יש שורה אחת במסד');
  eq(bucket.size, objectsAfterFirst,
    'ולא נשארו אובייקטים יתומים בדלי — הכפילות ניקתה אחרי עצמה');
  eq(objectsAfterFirst, 2, 'להעלאה אחת יש שני אובייקטים: מלאה וממוזערת');

  console.log('\n2. שם קובץ שונה אינו משנה');
  ok((again.body.duplicates || [])[0]?.name === 'shared-again.jpg',
    'הזיהוי לפי תוכן, לא לפי שם');

  console.log('\n3. תמונה אחרת כן נשמרת');
  const diff = await post({
    path: '/api/photos/upload', token, fields: { classroom_id: String(room._id) }, files: [{ name: 'b.jpg', buffer: b }],
  });
  eq(diff.body.saved, 1, 'תמונה שונה בפיקסל אחד נשמרת');
  eq(await Photo.countDocuments(), 2, 'שתי שורות');

  console.log('\n4. אותה תמונה בכיתה אחרת — לגיטימי');
  const sibling = await post({
    path: '/api/photos/upload', token, fields: { classroom_id: String(other._id) }, files: [{ name: 'a.jpg', buffer: a }],
  });
  eq(sibling.body.saved, 1, 'נשמרת — אחים בשתי כיתות זה מקרה אמיתי');
  eq((sibling.body.duplicates || []).length, 0, 'ולא מסומנת ככפילות');

  console.log('\n5. החתימה נשמרה על השורה');
  const rows = await Photo.find({ classroom_id: room._id }).select('sha256').lean();
  ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.sha256 || '')), 'לכל שורה יש sha256 תקין');
  const expected = crypto.createHash('sha256');
  ok(new Set(rows.map((r) => r.sha256)).size === rows.length, 'ושתי התמונות השונות קיבלו חתימות שונות');

  console.log(`\n${failures ? '❌' : '✅'} ${failures ? `${failures} שגויים` : 'הכל עבר'}`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('נפל:', e); process.exit(1); });
