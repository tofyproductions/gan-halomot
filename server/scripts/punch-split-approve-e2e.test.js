#!/usr/bin/env node
/**
 * Punch decisions accounting makes — end to end.
 *
 *  1. A day opened at one branch and closed at another is split with TWO
 *     times: left the first at 12:00, arrived at the second at 13:00. Four
 *     punches, and the hour on the road is not paid.
 *  2. Accounting/admin approving a self-reported punch is final, even when
 *     the branch manager never saw it (override, recorded as a bypass).
 *  3. Accounting labelling a >2-punch day settles the pending punches it uses.
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL — dotenv is stubbed before load.
 *
 *   node scripts/punch-split-approve-e2e.test.js
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
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
};
const eq = (a, b, label) => ok(a === b, label, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const head = (t) => console.log(`\n${t}`);

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
    if (body !== undefined && body !== null) {
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
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { const r = await request({ path: '/api/health' }); if (r.status === 200) return true; } catch { /* */ }
    await sleep(200);
  }
  throw new Error('השרת לא ענה על /api/health');
}
async function login(full_name, id_number) {
  const r = await request({ method: 'POST', path: '/api/auth/login-password', body: { full_name, id_number, password: PASSWORD } });
  if (r.status !== 200 || !r.body?.token) throw new Error(`התחברות נכשלה: ${r.status} ${r.text}`);
  return r.body.token;
}
/** An Israel-local wall-clock time on a date (September = UTC+3). */
const il = (date, hhmm) => new Date(`${date}T${hhmm}:00+03:00`);
const hhmmIL = (ts) => new Date(ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });

let mongod = null;
let server = null;

async function main() {
  console.log('=== החלטות הנה"ח על החתמות — בדיקת קצה-אל-קצה ===');
  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_punch_e2e' } });
  PORT = await freePort();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'punch-e2e-secret';
  process.env.PARENT_SECRET = 'punch-e2e-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  delete process.env.PLATFORM_MONGODB_URI;

  const express = require('express');
  const originalListen = express.application.listen;
  express.application.listen = function patched(...args) { server = originalListen.apply(this, args); return server; };
  require('../src/index.js');
  await waitForServer();
  express.application.listen = originalListen;
  const host = String(mongoose.connection.host || '');
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) throw new Error(`מסד הנתונים אינו מקומי (${host}) — עוצרים`);
  console.log(`\nשרת עלה על :${PORT}, מסד נתונים בזיכרון (${host})`);

  const { User, Branch, Employee, Punch, PunchResolution } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const kaplan = await Branch.create({ name: 'כפר סבא - קפלן', address: 'קפלן 1' });
  const herz = await Branch.create({ name: 'הרצליה הרצוג', address: 'הרצוג 1' });
  const emp = await Employee.create({ full_name: 'שילו בגים', israeli_id: '300000001', branch_id: kaplan._id, hourly_rate: 40, is_active: true });
  const mkUser = (o) => User.create({ password_hash: passwordHash, password_set: true, is_active: true, ...o });
  await mkUser({ email: 'admin@e2e.local', full_name: 'אורי מנהל', id_number: '900000001', role: 'system_admin', branch_id: kaplan._id, position: 'מנהל מערכת' });
  const manager = await mkUser({ email: 'ks@e2e.local', full_name: 'לידור כהן', id_number: '900000002', role: 'branch_manager', branch_id: kaplan._id, managed_branch_ids: [kaplan._id], position: 'מנהלת סניף' });
  const adminToken = await login('אורי מנהל', '900000001');
  const managerToken = await login('לידור כהן', '900000002');

  const device = (branch, date, hhmm, state) => Punch.create({
    branch_id: branch._id, employee_id: emp._id, israeli_id: emp.israeli_id, device_user_sn: Math.floor(Math.random() * 1e9),
    timestamp: il(date, hhmm), timestamp_source: 'device', state, verify_mode: 0, received_at: new Date(), approval_status: 'auto',
  });

  /* ---------------------------------------------------------------- */
  head('1. פיצול יום דו-סניפי עם שתי שעות');
  const D1 = '2026-09-01';
  const inKaplan = await device(kaplan, D1, '07:00', 0);
  const outHerz = await device(herz, D1, '17:00', 1);

  const issues = await request({ path: `/api/payroll-month/2026-09/punch-issues`, token: adminToken });
  eq(issues.status, 200, 'רשימת הבעיות נטענת');
  const cross = (issues.body?.cross_branch || []).find(c => c.date === D1);
  ok(!!cross, 'היום מזוהה כדו-סניפי');
  eq(cross?.minutes, 600, 'לפני הפיצול: 10 שעות לסניף הראשון');

  const bad = await request({ method: 'POST', path: '/api/payroll-month/2026-09/punch-issues/split-branch', token: adminToken,
    body: { employee_id: String(emp._id), date: D1, out_time: '13:00', in_time: '12:00' } });
  eq(bad.status, 400, 'כניסה לפני יציאה נדחית');
  const bad2 = await request({ method: 'POST', path: '/api/payroll-month/2026-09/punch-issues/split-branch', token: adminToken,
    body: { employee_id: String(emp._id), date: D1, out_time: '06:00', in_time: '12:00' } });
  eq(bad2.status, 400, 'יציאה לפני הכניסה של הבוקר נדחית');

  const split = await request({ method: 'POST', path: '/api/payroll-month/2026-09/punch-issues/split-branch', token: adminToken,
    body: { employee_id: String(emp._id), date: D1, out_time: '12:00', in_time: '13:00' } });
  eq(split.status, 200, 'הפיצול הצליח');
  eq(split.body?.status, 'approved', 'מנהל מערכת = מאושר מיד');
  eq(split.body?.minutes, 540, '9 שעות: 5 בקפלן + 4 בהרצליה, השעה בדרך לא נספרת');

  const after = await Punch.find({ employee_id: emp._id, timestamp: { $gte: il(D1, '00:00'), $lt: il(D1, '23:59') } }).sort({ timestamp: 1 }).lean();
  eq(after.length, 4, 'ארבע החתמות ביום');
  eq(after.map(p => hhmmIL(p.timestamp)).join(','), '07:00,12:00,13:00,17:00', 'בשעות הנכונות');
  eq(String(after[1].branch_id), String(kaplan._id), 'יציאה 12:00 בקפלן');
  eq(after[1].state, 1, '…והיא יציאה');
  eq(String(after[2].branch_id), String(herz._id), 'כניסה 13:00 בהרצליה');
  eq(after[2].state, 0, '…והיא כניסה');
  const res1 = await PunchResolution.findOne({ employee_id: emp._id, date: D1 }).lean();
  eq(res1?.status, 'approved', 'החלטת היום נרשמה כמאושרת');
  eq(res1?.minutes, 540, 'עם 540 דקות');

  head('1ב. אותה שעה בשני השדות = מעבר ישיר (כמו קודם)');
  const D2 = '2026-09-02';
  await device(kaplan, D2, '07:00', 0);
  await device(herz, D2, '17:00', 1);
  const direct = await request({ method: 'POST', path: '/api/payroll-month/2026-09/punch-issues/split-branch', token: adminToken,
    body: { employee_id: String(emp._id), date: D2, out_time: '12:00', in_time: '12:00' } });
  eq(direct.status, 200, 'הפיצול הצליח');
  eq(direct.body?.minutes, 600, 'כל 10 השעות נספרות');
  const legacy = '2026-09-03';
  await device(kaplan, legacy, '07:00', 0);
  await device(herz, legacy, '17:00', 1);
  const old = await request({ method: 'POST', path: '/api/payroll-month/2026-09/punch-issues/split-branch', token: adminToken,
    body: { employee_id: String(emp._id), date: legacy, transfer_time: '11:00' } });
  eq(old.status, 200, 'transfer_time הישן עדיין עובד');
  eq(old.body?.minutes, 600, 'ומתנהג כמעבר ישיר');

  head('1ג. מנהלת סניף — הצעה, לא החלטה');
  const D3 = '2026-09-04';
  await device(kaplan, D3, '07:25', 0);
  await device(herz, D3, '17:02', 1);
  const prop = await request({ method: 'POST', path: '/api/payroll-month/2026-09/punch-issues/split-branch', token: managerToken,
    body: { employee_id: String(emp._id), date: D3, out_time: '12:30', in_time: '13:15' } });
  eq(prop.status, 200, 'המנהלת פיצלה');
  eq(prop.body?.status, 'pending', 'ממתין להנה"ח');
  const propPunches = await Punch.find({ employee_id: emp._id, timestamp_source: 'manual', timestamp: { $gte: il(D3, '00:00'), $lt: il(D3, '23:59') } }).lean();
  ok(propPunches.every(p => p.approval_status === 'pending_accountant'), 'ההחתמות שיצרה ממתינות להנה"ח');

  /* ---------------------------------------------------------------- */
  head('2. אישור הנה"ח/מנהל מערכת הוא סופי — גם לפני המנהלת');
  const D4 = '2026-09-09';
  const self = await Punch.create({
    branch_id: kaplan._id, employee_id: emp._id, israeli_id: emp.israeli_id, device_user_sn: -1, timestamp: il(D4, '07:20'),
    timestamp_source: 'manual', state: 0, verify_mode: 0, received_at: new Date(), agent_version: 'manual-entry', approval_status: 'pending_manager',
  });
  const plain = await request({ method: 'PATCH', path: `/api/payroll/punches/${self._id}/approve`, token: adminToken, body: {} });
  eq(plain.status, 200, 'לחיצה רגילה של מנהל מערכת מאשרת');
  const selfAfter = await Punch.findById(self._id).lean();
  eq(selfAfter.approval_status, 'approved', 'סופי — לא "ממתין להנה"ח"');
  eq(selfAfter.manager_bypassed, true, 'העקיפה של המנהלת נרשמה');
  const twice = await request({ method: 'PATCH', path: `/api/payroll/punches/${self._id}/approve`, token: adminToken, body: { override_manager: true } });
  eq(twice.status, 403, 'אישור שני על החתמה מאושרת נדחה');

  head('2ב. מנהלת סניף עדיין רק מקדמת להנה"ח');
  const self2 = await Punch.create({
    branch_id: kaplan._id, employee_id: emp._id, israeli_id: emp.israeli_id, device_user_sn: -5, timestamp: il(D4, '17:00'),
    timestamp_source: 'manual', state: 1, verify_mode: 0, received_at: new Date(), agent_version: 'manual-entry', approval_status: 'pending_manager',
  });
  const mgr = await request({ method: 'PATCH', path: `/api/payroll/punches/${self2._id}/approve`, token: managerToken, body: {} });
  eq(mgr.status, 200, 'המנהלת אישרה');
  eq((await Punch.findById(self2._id).lean()).approval_status, 'pending_accountant', 'ועכשיו ממתין להנה"ח');
  const fin = await request({ method: 'PATCH', path: `/api/payroll/punches/${self2._id}/approve`, token: adminToken, body: {} });
  eq(fin.status, 200, 'מנהל מערכת סוגר');
  eq((await Punch.findById(self2._id).lean()).approval_status, 'approved', 'מאושר');
  eq((await Punch.findById(self2._id).lean()).manager_bypassed, false, 'בלי עקיפה — המנהלת ראתה');

  /* ---------------------------------------------------------------- */
  head('3. סידור יום עם 3 החתמות מאשר את ההחתמות הממתינות שבו');
  const D5 = '2026-09-10';
  const a = await Punch.create({
    branch_id: kaplan._id, employee_id: emp._id, israeli_id: emp.israeli_id, device_user_sn: -2, timestamp: il(D5, '07:20'),
    timestamp_source: 'manual', state: 0, verify_mode: 0, received_at: new Date(), agent_version: 'manual-entry', approval_status: 'pending_manager',
  });
  const b = await device(kaplan, D5, '07:42', 255);
  const c = await Punch.create({
    branch_id: kaplan._id, employee_id: emp._id, israeli_id: emp.israeli_id, device_user_sn: -3, timestamp: il(D5, '17:00'),
    timestamp_source: 'manual', state: 1, verify_mode: 0, received_at: new Date(), agent_version: 'manual-entry', approval_status: 'pending_manager',
  });
  const dayView = await request({ path: `/api/payroll/punches/day?employee_id=${emp._id}&date=${D5}`, token: adminToken });
  eq(dayView.status, 200, 'חלון היום נטען');
  eq((dayView.body?.punches || []).length, 3, 'שלוש החתמות');
  eq(dayView.body?.resolution, null, 'בלי החלטה עדיין');

  const settle = await request({ method: 'POST', path: '/api/payroll-month/punch-resolutions', token: adminToken,
    body: { employee_id: String(emp._id), date: D5, labels: [
      { punch_id: String(a._id), role: 'in' }, { punch_id: String(b._id), role: 'ignore' }, { punch_id: String(c._id), role: 'out' },
    ] } });
  eq(settle.status, 200, 'היום סודר');
  eq(settle.body?.status, 'approved', 'מאושר סופית');
  eq(settle.body?.minutes, 580, '07:20→17:00 = 9.67 שעות');
  eq((await Punch.findById(a._id).lean()).approval_status, 'approved', 'הכניסה הממתינה אושרה');
  eq((await Punch.findById(c._id).lean()).approval_status, 'approved', 'היציאה הממתינה אושרה');
  eq((await Punch.findById(a._id).lean()).manager_bypassed, true, 'העקיפה נרשמה');
  eq((await Punch.findById(b._id).lean()).approval_status, 'auto', 'ההחתמה שהתעלמנו ממנה לא נגעה');
  const dayView2 = await request({ path: `/api/payroll/punches/day?employee_id=${emp._id}&date=${D5}`, token: adminToken });
  eq(dayView2.body?.resolution?.status, 'approved', 'חלון היום רואה את ההחלטה');

  head('3ב. מנהלת סניף מסדרת יום — ההחתמות נשארות ממתינות');
  const D6 = '2026-09-11';
  const m1 = await Punch.create({
    branch_id: kaplan._id, employee_id: emp._id, israeli_id: emp.israeli_id, device_user_sn: -4, timestamp: il(D6, '07:00'),
    timestamp_source: 'manual', state: 0, verify_mode: 0, received_at: new Date(), agent_version: 'manual-entry', approval_status: 'pending_manager',
  });
  const m2 = await device(kaplan, D6, '07:30', 255);
  const m3 = await device(kaplan, D6, '16:00', 255);
  const mProp = await request({ method: 'POST', path: '/api/payroll-month/punch-resolutions', token: managerToken,
    body: { employee_id: String(emp._id), date: D6, labels: [
      { punch_id: String(m1._id), role: 'in' }, { punch_id: String(m2._id), role: 'ignore' }, { punch_id: String(m3._id), role: 'out' },
    ] } });
  eq(mProp.status, 200, 'המנהלת הציעה');
  eq(mProp.body?.status, 'pending', 'ממתין להנה"ח');
  eq((await Punch.findById(m1._id).lean()).approval_status, 'pending_manager', 'ההחתמה הממתינה לא אושרה על ידה דרך הסידור');
  void manager;

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} בדיקות עברו`);
}

main()
  .catch((err) => { console.error('\n💥', err); failures++; })
  .finally(async () => {
    try { server?.close(); } catch { /* */ }
    try { await mongoose.disconnect(); } catch { /* */ }
    try { await mongod?.stop(); } catch { /* */ }
    process.exit(failures ? 1 : 0);
  });
