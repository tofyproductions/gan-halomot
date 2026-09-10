#!/usr/bin/env node
/**
 * Web push subscribe/unsubscribe + the public-key endpoint, against a real
 * booted server.
 *
 *   node scripts/push-web-routes.test.js
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
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
let PORT = 0;
function request({ method = 'GET', path, token, body }) {
  return new Promise((resolve, reject) => {
    const h = {};
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = payload.length;
    }
    if (token) h.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { const r = await request({ path: '/api/health' }); if (r.status === 200) return true; } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('השרת לא ענה על /api/health');
}
async function login(full_name, id_number) {
  const r = await request({ method: 'POST', path: '/api/auth/login-password', body: { full_name, id_number, password: PASSWORD } });
  if (r.status !== 200 || !r.body?.token) throw new Error(`התחברות נכשלה: ${r.status} ${r.text}`);
  return r.body.token;
}

let mongod = null, server = null;

async function main() {
  console.log('=== מנויי פוש דפדפן — register-web / unregister-web / vapid-public-key ===');
  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_push_web_routes' } });
  PORT = await freePort();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'push-web-secret';
  process.env.PARENT_SECRET = 'push-web-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  process.env.VAPID_PUBLIC_KEY = 'test-public-key';
  delete process.env.PLATFORM_MONGODB_URI;

  const express = require('express');
  const originalListen = express.application.listen;
  express.application.listen = function patched(...args) { server = originalListen.apply(this, args); return server; };
  require('../src/index.js');
  await waitForServer();
  express.application.listen = originalListen;

  const host = String(mongoose.connection.host || '');
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) throw new Error(`מסד הנתונים אינו מקומי (${host}) — עוצרים`);

  const { User, WebPushSubscription } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({
    email: 'm@x.local', full_name: 'מנהלת', id_number: '444444444', role: 'branch_manager',
    position: 'x', password_hash: passwordHash, password_set: true, is_active: true,
  });
  const token = await login('מנהלת', '444444444');

  console.log('\nבדיקה 1 — מפתח ה-VAPID הציבורי');
  const key = await request({ token, path: '/api/push/vapid-public-key' });
  eq(key.status, 200, '1a מוחזר בהצלחה');
  eq(key.body.publicKey, 'test-public-key', '1b המפתח הנכון');

  console.log('\nבדיקה 2 — הרשמה');
  const sub = await request({
    method: 'POST', token, path: '/api/push/register-web',
    body: { endpoint: 'https://push.example/ep-1', keys: { p256dh: 'p', auth: 'a' } },
  });
  eq(sub.status, 200, '2a נרשם בהצלחה');
  eq(await WebPushSubscription.countDocuments({}), 1, '2b נשמר מנוי אחד');

  console.log('\nבדיקה 3 — הרשמה חוזרת על אותו endpoint לא כופלת');
  await request({
    method: 'POST', token, path: '/api/push/register-web',
    body: { endpoint: 'https://push.example/ep-1', keys: { p256dh: 'p2', auth: 'a2' } },
  });
  eq(await WebPushSubscription.countDocuments({}), 1, '3a עדיין מנוי אחד בלבד');
  const row = await WebPushSubscription.findOne({}).lean();
  eq(row.keys.p256dh, 'p2', '3b אבל המפתחות עודכנו');

  console.log('\nבדיקה 4 — ביטול הרשמה');
  const unsub = await request({ method: 'POST', token, path: '/api/push/unregister-web', body: { endpoint: 'https://push.example/ep-1' } });
  eq(unsub.status, 200, '4a בוטל בהצלחה');
  eq(await WebPushSubscription.countDocuments({}), 0, '4b נמחק מהמסד');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} בדיקות עברו`);
}

main()
  .catch(err => { console.error('\n💥', err); failures++; })
  .finally(async () => {
    try { if (server) await new Promise(r => server.close(r)); } catch { /* closing */ }
    try { await mongoose.disconnect(); } catch { /* disconnecting */ }
    try { if (mongod) await mongod.stop(); } catch { /* stopping */ }
    process.exit(failures === 0 ? 0 : 1);
  });
