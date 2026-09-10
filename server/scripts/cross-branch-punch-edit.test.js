#!/usr/bin/env node
/**
 * שילו בגים, אורחת בהרצליה — תיקון החתמה חוצה-סניפים, קצה-אל-קצה.
 *
 * שילו שייכת לכפר סבא (מנהלת: לידור). היא עבדה יום אמיתי בהרצליה (מנהלת:
 * טניה), וטניה רוצה לתקן לה שעה — אבל עד עכשיו ניסיון כזה נחסם לגמרי, כי
 * ההחתמה "שייכת לעובד/ת בסניף שאינו בניהולך". הבדיקה הזאת מוכיחה את כל
 * השרשרת החדשה כנגד שרת אמיתי: טניה כן יכולה לבקש תיקון; הוא ממתין ללידור,
 * לא לטניה עצמה ולא להנה"ח; לידור מאשרת ורק אז זה עובר להנה"ח; לאורך כל
 * הדרך השעה שכבר נספרת ממשיכה להיספר בשכר בלי לזוז, בדיוק כמו תיקון רגיל;
 * ורק אחרי אישור ההנה"ח השעה בפועל משתנה.
 *
 * גם: מנהלת עצמה שמתקנת לעובדת שלה — בלי שינוי מההתנהגות הקיימת. שני
 * מנהלות פעילות לאותו סניף בית — שתיהן רואות, הראשונה שמאשרת סוגרת. מנהל
 * מערכת יכול תמיד לחתוך ישר להנה"ח, גם בלי שאף מנהלת בית קיימת.
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL — same three guarantees as
 * viewer-e2e.test.js (dotenv stubbed first, MONGODB_URI set before
 * src/index.js loads, host asserted loopback before any write).
 *
 *   node scripts/cross-branch-punch-edit.test.js
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
  return !!cond;
}
const eq = (a, b, label) => ok(
  JSON.stringify(a) === JSON.stringify(b), label,
  `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`,
);
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
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { const r = await request({ path: '/api/health' }); if (r.status === 200) return true; } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('השרת לא ענה על /api/health');
}
async function login(full_name, id_number) {
  const r = await request({ method: 'POST', path: '/api/auth/login-password', body: { full_name, id_number, password: PASSWORD } });
  if (r.status !== 200 || !r.body?.token) throw new Error(`התחברות נכשלה עבור ${full_name}: ${r.status} ${r.text}`);
  return r.body.token;
}

let mongod = null;
let server = null;

async function main() {
  console.log('=== תיקון החתמה חוצה-סניפים — קצה אל קצה ===');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_cross_branch_punch' } });
  PORT = await freePort();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'cross-branch-punch-secret';
  process.env.PARENT_SECRET = 'cross-branch-punch-parent-secret';
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

  const {
    User, Branch, Employee, Punch, CrossBranchPunchEdit,
  } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const herzliya = await Branch.create({ name: 'הרצליה הרצוג' });
  const kfarSaba = await Branch.create({ name: 'כפר סבא - משה דיין' });
  const tlv = await Branch.create({ name: 'תל אביב' }); // home branch with NO active manager

  const admin = await User.create({
    email: 'admin@cbp.local', full_name: 'אורי מנהל', id_number: '900000001',
    role: 'system_admin', branch_id: herzliya._id, position: 'מנהל מערכת',
    password_hash: passwordHash, password_set: true, is_active: true,
  });
  const accountant = await User.create({
    email: 'acc@cbp.local', full_name: 'רונית הנהח', id_number: '900000002',
    role: 'accountant', branch_id: herzliya._id, position: 'הנהלת חשבונות',
    password_hash: passwordHash, password_set: true, is_active: true,
  });
  const tania = await User.create({ // host manager — הרצליה
    email: 'tania@cbp.local', full_name: 'טניה מנהלת', id_number: '900000003',
    role: 'branch_manager', branch_id: herzliya._id, position: 'מנהלת סניף',
    password_hash: passwordHash, password_set: true, is_active: true,
  });
  const lidor = await User.create({ // home manager — כפר סבא
    email: 'lidor@cbp.local', full_name: 'לידור מנהלת', id_number: '900000004',
    role: 'branch_manager', branch_id: kfarSaba._id, position: 'מנהלת סניף',
    password_hash: passwordHash, password_set: true, is_active: true,
  });
  // A second active manager of the SAME home branch — "who decides first, closes it".
  const bodek = await User.create({
    email: 'bodek@cbp.local', full_name: 'בודק גוגל', id_number: '900000005',
    role: 'branch_manager', branch_id: kfarSaba._id, position: 'מנהל סניף',
    password_hash: passwordHash, password_set: true, is_active: true,
  });

  const mkEmp = (name, id, branch) => Employee.create({
    full_name: name, israeli_id: id, phone: `050-${id.slice(-7)}`,
    email: `${id}@cbp.local`, position: 'סייעת', branch_id: branch._id,
    salary_type: 'hourly', hourly_rate: 50, is_active: true,
    start_date: new Date('2024-09-01'),
  });
  const shilo = await mkEmp('שילו בגים', '320000001', kfarSaba); // home: כפר סבא
  const dana = await mkEmp('דנה הרצליה', '320000002', herzliya); // home: הרצליה
  const noTaman = await mkEmp('ילדה בלי מנהלת', '320000003', tlv); // home: תל אביב — no active manager there

  const tokenAdmin = await login('אורי מנהל', '900000001');
  const tokenAccountant = await login('רונית הנהח', '900000002');
  const tokenTania = await login('טניה מנהלת', '900000003');
  const tokenLidor = await login('לידור מנהלת', '900000004');
  const tokenBodek = await login('בודק גוגל', '900000005');

  const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };

  /* ================================================================ */
  head('בדיקה 1 — מנהלת שמתקנת לעובדת שלה: בלי שינוי מההתנהגות הקיימת');
  {
    const p = await Punch.create({
      branch_id: herzliya._id, employee_id: dana._id, israeli_id: dana.israeli_id,
      device_user_sn: 1001, timestamp: at(8, 0), approval_status: 'auto',
    });
    const res = await request({
      method: 'PATCH', token: tokenTania, path: `/api/payroll/punches/${p._id}`,
      body: { timestamp: at(8, 30).toISOString() },
    });
    ok(res.status === 200, '1a התיקון נשלח', `${res.status} ${res.text?.slice(0, 200)}`);
    eq(res.body?.cross_branch, false, '1b אינו מסומן חוצה-סניפים — זו העובדת שלה');
    const fresh = await Punch.findById(p._id).lean();
    eq(fresh.approval_status, 'auto', '1c הסטטוס לא זז — ממשיך להיספר');
    ok(!fresh.pending_edit?.cross_branch, '1d אין דגל cross_branch');
    ok(!!fresh.manager_approved_by, '1e manager_approved_by מתמלא מיד — כמו תמיד');
    eq(await CrossBranchPunchEdit.countDocuments({}), 0, '1f ואין רישום ביומן — זה לא המקרה החדש');

    // Accountant applies it — unaffected flow.
    const app = await request({ method: 'PATCH', token: tokenAccountant, path: `/api/payroll/punches/${p._id}/approve` });
    ok(app.status === 200, '1g הנה"ח מאשרת סופית');
    eq(new Date(app.body.punch.timestamp).getTime(), at(8, 30).getTime(), '1h והשעה החדשה נכנסת');
  }

  head('בדיקה 2 — טניה (הרצליה) מתקנת לשילו (כפר סבא) — אורחת אמיתית');
  let punchId, editId;
  {
    const p = await Punch.create({
      branch_id: herzliya._id, employee_id: shilo._id, israeli_id: shilo.israeli_id,
      device_user_sn: 1002, timestamp: at(9, 0), approval_status: 'auto',
    });
    punchId = String(p._id);

    const res = await request({
      method: 'PATCH', token: tokenTania, path: `/api/payroll/punches/${punchId}`,
      body: { timestamp: at(9, 45).toISOString(), manual_note: 'עבדה בפועל עד 9:45' },
    });
    ok(res.status === 200, '2a טניה יכולה לבקש תיקון — לא נחסמת יותר', `${res.status} ${res.text?.slice(0, 300)}`);
    eq(res.body?.pending, true, '2b מסומן כממתין');
    eq(res.body?.cross_branch, true, '2c ומסומן חוצה-סניפים');

    const fresh = await Punch.findById(punchId).lean();
    eq(fresh.approval_status, 'auto', '2d הסטטוס נשאר auto — השעה הישנה ממשיכה להיספר');
    eq(fresh.pending_edit?.cross_branch, true, '2e pending_edit מסומן');
    eq(fresh.pending_edit?.manager_approved, false, '2f וטרם אושר');
    ok(!fresh.manager_approved_by, '2g manager_approved_by ריק — טניה אינה המנהלת שסוגרת את השלב');

    const log = await CrossBranchPunchEdit.findOne({ punch_id: punchId }).lean();
    ok(!!log, '2h נוצרה רשומה ביומן');
    editId = String(log._id);
    eq(log.status, 'pending_manager', '2i ממתינה למנהל/ת');
    eq(log.home_branch_name, 'כפר סבא - משה דיין', '2j מזוהה כסניף הבית הנכון');
    eq(log.host_branch_name, 'הרצליה הרצוג', '2k וסניף המארח הנכון');
    eq(log.requested_by_name, 'טניה מנהלת', '2l עם שם המבקשת');
  }

  head('בדיקה 3 — טניה עצמה לא יכולה לאשר את הבקשה שלה, וגם לידור לא רואה אותה בתור הרגיל');
  {
    const res = await request({ method: 'PATCH', token: tokenTania, path: `/api/payroll/punches/${punchId}/approve` });
    eq(res.status, 403, '3a טניה נחסמת מאישור הבקשה של עצמה');
    ok(/מנהל\/ת הבית/.test(res.body?.error || ''), '3b וההודעה מסבירה למה', res.body?.error);

    const pend = await request({ token: tokenTania, path: '/api/payroll/punches/pending' });
    ok(!(pend.body?.pending_manager || []).some(x => String(x._id) === punchId),
      '3c ואינה מופיעה בתור "בעיות בהחתמה" הרגיל של טניה — היא לא מי שמאשר');
  }

  head('בדיקה 4 — לידור (מנהלת הבית) רואה ומאשרת דרך "עובדים שלי בסניפים אחרים"');
  {
    const list = await request({ token: tokenLidor, path: '/api/payroll/cross-branch-edits' });
    ok(list.status === 200, '4a הרשימה נטענת ללידור', list.status);
    const row = (list.body?.edits || []).find(e => e._id === editId);
    ok(!!row, '4b ורואה את הבקשה של שילו', JSON.stringify(list.body?.edits?.map(e => e.employee_name)));
    eq(row?.status, 'pending_manager', '4c ממתינה לה');

    const res = await request({ method: 'PATCH', token: tokenLidor, path: `/api/payroll/punches/${punchId}/approve` });
    ok(res.status === 200, '4d לידור מאשרת', `${res.status} ${res.text?.slice(0, 200)}`);
    eq(res.body?.pending, true, '4e עדיין ממתין — עכשיו להנה"ח');

    const fresh = await Punch.findById(punchId).lean();
    eq(fresh.approval_status, 'auto', '4f הסטטוס עדיין auto — עדיין נספר לפי השעה המקורית');
    eq(fresh.pending_edit?.manager_approved, true, '4g אבל שלב המנהלת סומן כאושר');
    eq(String(fresh.manager_approved_by), String(lidor._id), '4h ועל ידי לידור, לא טניה');

    const log = await CrossBranchPunchEdit.findById(editId).lean();
    eq(log.status, 'pending_accountant', '4i היומן עבר לשלב הנה"ח');
    eq(log.manager_decided_by_name, 'לידור מנהלת', '4j עם שם המאשרת');
  }

  head('בדיקה 5 — לידור לא יכולה לאשר פעמיים (השלב כבר סגור אצלה)');
  {
    const res = await request({ method: 'PATCH', token: tokenLidor, path: `/api/payroll/punches/${punchId}/approve` });
    eq(res.status, 403, '5a נדחית — כבר אין מה לאשר בשלב שלה');
  }

  head('בדיקה 6 — הנה"ח מאשרת סופית — ורק עכשיו השעה בפועל זזה');
  {
    const res = await request({ method: 'PATCH', token: tokenAccountant, path: `/api/payroll/punches/${punchId}/approve` });
    ok(res.status === 200, '6a אושר סופית', `${res.status} ${res.text?.slice(0, 200)}`);
    ok(res.body?.applied_edit, '6b applied_edit=true');
    const fresh = await Punch.findById(punchId).lean();
    eq(new Date(fresh.timestamp).getTime(), at(9, 45).getTime(), '6c השעה החדשה נכנסה');
    eq(fresh.approval_status, 'auto', '6d וסטטוס ה-auto המקורי נשמר (prev_status), ממשיך להיספר');
    ok(!fresh.pending_edit?.timestamp, '6e pending_edit נוקה');

    const log = await CrossBranchPunchEdit.findById(editId).lean();
    eq(log.status, 'approved', '6f היומן מציג אישור סופי');
    eq(log.final_decided_by_name, 'רונית הנהח', '6g עם שם הנה"ח');

    // The dedicated review screen still shows the closed request, for the month's history.
    const list = await request({ token: tokenLidor, path: '/api/payroll/cross-branch-edits' });
    const row = (list.body?.edits || []).find(e => e._id === editId);
    eq(row?.status, 'approved', '6h ונשארת בלוג של לידור כהיסטוריה');
  }

  head('בדיקה 7 — שתי מנהלות לאותו סניף בית: הראשונה שמאשרת סוגרת');
  {
    const p = await Punch.create({
      branch_id: herzliya._id, employee_id: shilo._id, israeli_id: shilo.israeli_id,
      device_user_sn: 1003, timestamp: at(10, 0), approval_status: 'approved',
    });
    await request({
      method: 'PATCH', token: tokenTania, path: `/api/payroll/punches/${p._id}`,
      body: { timestamp: at(10, 20).toISOString() },
    });

    const seenByLidor = await request({ token: tokenLidor, path: '/api/payroll/cross-branch-edits' });
    const seenByBodek = await request({ token: tokenBodek, path: '/api/payroll/cross-branch-edits' });
    ok((seenByLidor.body?.edits || []).some(e => String(e.punch_id) === String(p._id)), '7a לידור רואה');
    ok((seenByBodek.body?.edits || []).some(e => String(e.punch_id) === String(p._id)), '7b בודק גוגל רואה גם כן');

    const first = await request({ method: 'PATCH', token: tokenBodek, path: `/api/payroll/punches/${p._id}/approve` });
    ok(first.status === 200, '7c בודק גוגל מאשר ראשון — מצליח');
    const second = await request({ method: 'PATCH', token: tokenLidor, path: `/api/payroll/punches/${p._id}/approve` });
    eq(second.status, 403, '7d לידור מגיעה שנייה — נדחית, השלב כבר סגור');
  }

  head('בדיקה 8 — אין אף מנהלת פעילה בסניף הבית (תל אביב): עובר ישירות למנהל המערכת');
  {
    const p = await Punch.create({
      branch_id: herzliya._id, employee_id: noTaman._id, israeli_id: noTaman.israeli_id,
      device_user_sn: 1004, timestamp: at(11, 0), approval_status: 'auto',
    });
    const edited = await request({
      method: 'PATCH', token: tokenTania, path: `/api/payroll/punches/${p._id}`,
      body: { timestamp: at(11, 15).toISOString() },
    });
    ok(edited.status === 200 && edited.body?.cross_branch, '8a התיקון נקלט כחוצה-סניפים');

    // No branch_manager exists for תל אביב at all — system_admin cuts straight
    // through to final approval, same shortcut it always has.
    const res = await request({ method: 'PATCH', token: tokenAdmin, path: `/api/payroll/punches/${p._id}/approve` });
    ok(res.status === 200 && res.body?.applied_edit, '8b מנהל המערכת מאשר ישירות עד הסוף, בלי שלב ביניים', `${res.status} ${res.text?.slice(0, 200)}`);
    const fresh = await Punch.findById(p._id).lean();
    eq(new Date(fresh.timestamp).getTime(), at(11, 15).getTime(), '8c השעה עודכנה');
  }

  head('בדיקה 9 — דחייה: ההחתמה המקורית נשארת, היומן מציג "נדחה"');
  {
    const p = await Punch.create({
      branch_id: herzliya._id, employee_id: shilo._id, israeli_id: shilo.israeli_id,
      device_user_sn: 1005, timestamp: at(12, 0), approval_status: 'auto',
    });
    await request({
      method: 'PATCH', token: tokenTania, path: `/api/payroll/punches/${p._id}`,
      body: { timestamp: at(12, 40).toISOString() },
    });
    const rej = await request({
      method: 'PATCH', token: tokenLidor, path: `/api/payroll/punches/${p._id}/reject`,
      body: { note: 'זה לא נכון, בדקתי מול השעון' },
    });
    ok(rej.status === 200, '9a לידור דוחה', `${rej.status} ${rej.text?.slice(0, 200)}`);
    ok(rej.body?.restored, '9b restored=true');
    const fresh = await Punch.findById(p._id).lean();
    eq(new Date(fresh.timestamp).getTime(), at(12, 0).getTime(), '9c השעה המקורית נשארה');
    ok(!fresh.pending_edit?.timestamp, '9d pending_edit נוקה');
    const log = await CrossBranchPunchEdit.findOne({ punch_id: p._id }).lean();
    eq(log.status, 'rejected', '9e היומן מציג נדחה');
    eq(log.final_decided_by_name, 'לידור מנהלת', '9f עם שם הדוחה');
  }

  head('בדיקה 10 — היקף: לידור לא רואה ביומן שלה בקשות של סניפים שאינם שלה');
  {
    const list = await request({ token: tokenLidor, path: '/api/payroll/cross-branch-edits' });
    ok(!(list.body?.edits || []).some(e => e.home_branch_name === 'הרצליה הרצוג'),
      '10a שום רשומה שסניף הבית שלה הוא הרצליה — זה לא הסניף שהיא מנהלת');
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} בדיקות עברו`);
}

main()
  .catch((err) => { console.error('\n💥', err); failures++; })
  .finally(async () => {
    try { if (server) await new Promise(r => server.close(r)); } catch { /* closing */ }
    try { await mongoose.disconnect(); } catch { /* disconnecting */ }
    try { if (mongod) await mongod.stop(); } catch { /* stopping */ }
    process.exit(failures === 0 ? 0 : 1);
  });
