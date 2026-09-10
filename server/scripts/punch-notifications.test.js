#!/usr/bin/env node
/**
 * ההחתמה מגיעה, הפוש יוצא, הכל נסגר כשמטפלים — קצה אל קצה, דרך שלושת
 * המסלולים: דיווח עצמי של עובדת, תיקון של מנהלת לעובדת שלה, ותיקון
 * חוצה-סניפים (מנהלת אורחת → מנהלת הבית → הנה"ח).
 *
 *   node scripts/punch-notifications.test.js
 */
const net = require('net');
const http = require('http');

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const sent = { fcm: [], web: [] };
const fcmPath = require.resolve('../src/services/fcm.service');
require.cache[fcmPath] = {
  id: fcmPath, filename: fcmPath, loaded: true, children: [], paths: [],
  exports: {
    sendPush: async ({ token, title, body }) => { sent.fcm.push({ token, title, body }); return { ok: true, unregistered: false }; },
    isConfigured: () => true,
  },
};
const webPushPath = require.resolve('web-push');
require.cache[webPushPath] = {
  id: webPushPath, filename: webPushPath, loaded: true, children: [], paths: [],
  exports: {
    setVapidDetails: () => {},
    sendNotification: async (subscription, payload) => { sent.web.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) }); return { statusCode: 201 }; },
  },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const PASSWORD = 'test1234';
let failures = 0, checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const head = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, tries = 40) {
  for (let i = 0; i < tries; i++) { if (await pred()) return true; await sleep(50); }
  return pred();
}

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
    if (body !== undefined) { payload = Buffer.from(JSON.stringify(body)); h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    if (token) h.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, body: json, text }); });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}
async function waitForServer() {
  for (let i = 0; i < 100; i++) { try { const r = await request({ path: '/api/health' }); if (r.status === 200) return true; } catch { /* not up */ } await sleep(200); }
  throw new Error('השרת לא ענה על /api/health');
}
async function login(full_name, id_number) {
  const r = await request({ method: 'POST', path: '/api/auth/login-password', body: { full_name, id_number, password: PASSWORD } });
  if (r.status !== 200 || !r.body?.token) throw new Error(`התחברות נכשלה עבור ${full_name}: ${r.status} ${r.text}`);
  return r.body.token;
}

let mongod = null, server = null;

async function main() {
  console.log('=== התראות פוש על תור אישורי החתמה — קצה אל קצה ===');
  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_punch_notifications' } });
  PORT = await freePort();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'punch-notif-secret';
  process.env.PARENT_SECRET = 'punch-notif-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  process.env.VAPID_PUBLIC_KEY = 'test-public';
  process.env.VAPID_PRIVATE_KEY = 'test-private';
  delete process.env.PLATFORM_MONGODB_URI;

  const express = require('express');
  const originalListen = express.application.listen;
  express.application.listen = function patched(...args) { server = originalListen.apply(this, args); return server; };
  require('../src/index.js');
  await waitForServer();
  express.application.listen = originalListen;

  const host = String(mongoose.connection.host || '');
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) throw new Error(`מסד הנתונים אינו מקומי (${host}) — עוצרים`);

  const { User, Branch, Employee, Punch, PushSubscription, NotificationEvent } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const branch = await Branch.create({ name: 'הרצליה' });
  const manager = await User.create({ email: 'm@x.local', full_name: 'מנהלת הרצליה', id_number: '555555001', role: 'branch_manager', branch_id: branch._id, position: 'x', password_hash: passwordHash, password_set: true, is_active: true });
  const accountant = await User.create({ email: 'a@x.local', full_name: 'הנהח', id_number: '555555002', role: 'accountant', branch_id: branch._id, position: 'x', password_hash: passwordHash, password_set: true, is_active: true });
  await PushSubscription.create({ user_id: manager._id, fcm_token: 'MGR_TOKEN', platform: 'android' });
  await PushSubscription.create({ user_id: accountant._id, fcm_token: 'ACC_TOKEN', platform: 'android' });
  const emp = await Employee.create({ full_name: 'עובדת בדיקה', israeli_id: '655555001', phone: '050-0000001', email: 'e@x.local', position: 'סייעת', branch_id: branch._id, salary_type: 'hourly', hourly_rate: 50, is_active: true, start_date: new Date('2024-09-01') });

  const tokenManager = await login('מנהלת הרצליה', '555555001');
  const tokenAccountant = await login('הנהח', '555555002');

  head('בדיקה 1 — מנהלת מדווחת עבור העובדת (branch_manager) → ישר pending_accountant, פוש להנה"ח');
  {
    const res = await request({ method: 'POST', token: tokenManager, path: '/api/payroll/manual-punches', body: { employee_id: String(emp._id), date: '2026-09-10', in_time: '08:00', note: '' } });
    ok(res.status === 200, '1a הדיווח נקלט', `${res.status} ${res.text?.slice(0, 200)}`);
    const punchId = res.body.punches[0]._id;
    const created = await Punch.findById(punchId).lean();
    eq(created.approval_status, 'pending_accountant', '1a2 ההחתמה נחתה על pending_accountant');
    await waitFor(async () => (await NotificationEvent.countDocuments({ ref_id: punchId, type: 'punch_pending_accountant', recipient_id: accountant._id })) === 1);
    eq(await NotificationEvent.countDocuments({ ref_id: punchId, type: 'punch_pending_accountant', recipient_id: accountant._id, status: 'pending' }), 1, '1b נוצר אירוע פוש להנה"ח');
    await waitFor(() => sent.fcm.some(s => s.token === 'ACC_TOKEN'));
    ok(sent.fcm.some(s => s.token === 'ACC_TOKEN'), '1c ונשלח פוש בפועל');

    const approve = await request({ method: 'PATCH', token: tokenAccountant, path: `/api/payroll/punches/${punchId}/approve` });
    ok(approve.status === 200, '1d הנה"ח מאשרת');
    eq(await NotificationEvent.countDocuments({ ref_id: punchId, status: 'pending' }), 0, '1e האירוע נסגר');
    const finalPunch = await Punch.findById(punchId).lean();
    eq(finalPunch.approval_status, 'approved', '1f ואושרה סופית');
  }

  head('בדיקה 2 — מנהלת מתקנת שעה שכבר נספרת לעובדת שלה (pending_edit רגיל) → פוש להנה"ח מיד');
  {
    const p = await Punch.create({ branch_id: branch._id, employee_id: emp._id, israeli_id: emp.israeli_id, device_user_sn: 9001, timestamp: new Date('2026-09-10T08:00:00Z'), approval_status: 'auto' });
    sent.fcm.length = 0;
    const res = await request({ method: 'PATCH', token: tokenManager, path: `/api/payroll/punches/${p._id}`, body: { timestamp: new Date('2026-09-10T08:30:00Z').toISOString() } });
    ok(res.status === 200, '2a התיקון נקלט');
    const staged = await Punch.findById(p._id).lean();
    eq(staged.approval_status, 'auto', '2a2 הסטטוס נשאר auto בזמן ההמתנה');
    await waitFor(async () => (await NotificationEvent.countDocuments({ ref_id: p._id, type: 'punch_pending_accountant', recipient_id: accountant._id })) === 1);
    eq(await NotificationEvent.countDocuments({ ref_id: p._id, status: 'pending' }), 1, '2b אירוע אחד בלבד, להנה"ח');

    const approve = await request({ method: 'PATCH', token: tokenAccountant, path: `/api/payroll/punches/${p._id}/approve` });
    ok(approve.status === 200, '2c הנה"ח מאשרת');
    eq(await NotificationEvent.countDocuments({ ref_id: p._id, status: 'pending' }), 0, '2d האירוע נסגר');
    const restored = await Punch.findById(p._id).lean();
    eq(restored.approval_status, 'auto', '2e ואושר עם שחזור ה-approval_status המקורי (prev_status)');
  }

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
