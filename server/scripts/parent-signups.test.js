#!/usr/bin/env node
/**
 * מעקב הורים רשומים — who may open it, and does it tell the truth.
 *
 * Two different kinds of check, and both matter. The screen is a list of
 * families' ID numbers and mobile numbers, so the first half is a wall: a
 * teacher must not reach it, and a branch manager must not see another gan's
 * families through it. The second half is arithmetic — "has not signed up"
 * and "cannot sign up" are different answers that lead to different actions,
 * and a screen that confuses them sends the office chasing somebody whose
 * record is broken and who will never answer.
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL. dotenv is stubbed out of require.cache
 * before anything loads it, so server/.env — which on this machine points at
 * production — is never read, and the connection host is asserted to be
 * loopback before a single document is written.
 *
 *   node scripts/parent-signups.test.js
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
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await request({ path: '/api/health' });
      if (r.status === 200) return true;
    } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('השרת לא ענה על /api/health');
}

let mongod = null;
let server = null;

async function main() {
  console.log('=== מעקב הורים רשומים ===');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_parent_signups' } });
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'parent-signups-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  delete process.env.PLATFORM_MONGODB_URI;

  const express = require('express');
  const originalListen = express.application.listen;
  express.application.listen = function patched(...args) {
    server = originalListen.apply(this, args);
    return server;
  };
  require('../src/index.js');
  await waitForServer();
  express.application.listen = originalListen;

  const host = String(mongoose.connection.host || '');
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
    throw new Error(`מסד הנתונים אינו מקומי (${host}) — עוצרים`);
  }
  console.log(`\nשרת עלה על :${PORT}, מסד נתונים בזיכרון (${host})`);

  const { User, Branch, Classroom, Child, Registration, ParentAccount } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const YEAR = '2026-2027';
  const ks = await Branch.create({ name: 'כפר סבא - משה דיין', address: 'משה דיין 9' });
  const tlv = await Branch.create({ name: 'תל אביב', address: 'יפו 1' });
  const roomA = await Classroom.create({ name: 'תינוקיה 20', branch_id: ks._id, academic_year: YEAR, is_active: true });
  const roomB = await Classroom.create({ name: 'בוגרים 30', branch_id: ks._id, academic_year: YEAR, is_active: true });
  const roomT = await Classroom.create({ name: 'תינוקיה', branch_id: tlv._id, academic_year: YEAR, is_active: true });

  /**
   * A family, built the way most of them really are: the ID and the phone on
   * the REGISTRATION rather than on the child, because of the 63-of-71 fact
   * in parentDirectory.service. A test built the other way would pass while
   * the live data failed.
   */
  let seq = 0;
  const mkFamily = async ({ childName, parentName, parentId, phone, room, branch, account }) => {
    seq += 1;
    const reg = await Registration.create({
      unique_id: `PS-${seq}`, child_name: childName, parent_name: parentName,
      parent_id_number: parentId, parent_phone: phone,
      monthly_fee: 2000, branch_id: branch._id, academic_year: YEAR,
      start_date: new Date(`${YEAR.slice(0, 4)}-09-01`), end_date: new Date(`${YEAR.slice(5)}-08-31`),
    });
    const child = await Child.create({
      registration_id: reg._id, child_name: childName, classroom_id: room._id,
      branch_id: branch._id, academic_year: YEAR, is_active: true,
    });
    if (account) {
      await ParentAccount.create({
        id_number: parentId, full_name: parentName, phone: phone || '0500000000',
        activated: true, access_approved: true, is_active: true,
        password_hash: passwordHash, last_login_at: new Date(),
      });
    }
    return { reg, child };
  };

  // Signed up.
  await mkFamily({ childName: 'יעל כהן', parentName: 'דנה כהן', parentId: '000000018', phone: '0501111111', room: roomA, branch: ks, account: true });
  // Can sign up, has not.
  await mkFamily({ childName: 'איתי לוי', parentName: 'רון לוי', parentId: '000000026', phone: '0502222222', room: roomA, branch: ks });
  // Cannot sign up — a landline is not a mobile, so no code can reach them.
  await mkFamily({ childName: 'נועה בר', parentName: 'שירה בר', parentId: '000000034', phone: '039876543', room: roomA, branch: ks });
  // A sibling of the first family: one parent, two children, ONE row.
  await mkFamily({ childName: 'עמית כהן', parentName: 'דנה כהן', parentId: '000000018', phone: '0501111111', room: roomB, branch: ks });
  // Another gan entirely.
  await mkFamily({ childName: 'דן שמש', parentName: 'אורי שמש', parentId: '000000042', phone: '0504444444', room: roomT, branch: tlv });

  const mkUser = (o) => User.create({ password_hash: passwordHash, password_set: true, is_active: true, ...o });
  await mkUser({ email: 'admin@ps.local', full_name: 'אורי מנהל', id_number: '900000001', role: 'system_admin', branch_id: ks._id });
  await mkUser({ email: 'mgr@ps.local', full_name: 'לידור כהן', id_number: '900000002', role: 'branch_manager', branch_id: ks._id, managed_branch_ids: [ks._id] });
  await mkUser({ email: 'teach@ps.local', full_name: 'נועה גננת', id_number: '900000003', role: 'teacher', branch_id: ks._id });
  await mkUser({ email: 'lead@ps.local', full_name: 'מיכל אחראית', id_number: '900000004', role: 'class_leader', branch_id: ks._id });

  const login = async (full_name, id_number) => {
    const r = await request({
      method: 'POST', path: '/api/auth/login-password',
      body: { full_name, id_number, password: PASSWORD },
    });
    if (r.status !== 200 || !r.body?.token) throw new Error(`התחברות נכשלה (${full_name}): ${r.status} ${r.text}`);
    return r.body.token;
  };

  const admin = await login('אורי מנהל', '900000001');
  const manager = await login('לידור כהן', '900000002');
  const teacher = await login('נועה גננת', '900000003');
  const leader = await login('מיכל אחראית', '900000004');

  /* ---------------------------------------------------------------- */
  head('1. מי בכלל נכנס למסך');
  eq((await request({ path: '/api/parent-signups', token: admin })).status, 200, 'מנהל מערכת — כן');
  eq((await request({ path: '/api/parent-signups', token: manager })).status, 200, 'מנהל סניף — כן');
  eq((await request({ path: '/api/parent-signups', token: teacher })).status, 403, 'גננת — לא');
  eq((await request({ path: '/api/parent-signups', token: leader })).status, 403, 'גננת אחראית — לא');
  eq((await request({ path: '/api/parent-signups' })).status, 401, 'ובלי טוקן — לא');

  head('2. הספירה אומרת את האמת');
  const all = await request({ path: '/api/parent-signups', token: admin });
  const s = all.body.summary;
  eq(s.parents, 4, 'ארבעה הורים — האחים נספרים פעם אחת');
  eq(s.active, 1, 'אחד הפעיל חשבון');
  eq(s.blocked, 1, 'ואחד חסום');
  eq(s.not_signed_up, 2, 'והשניים הנותרים ממתינים');

  const dana = all.body.parents.find(p => p.id_number === '000000018');
  eq(dana?.children.length, 2, 'לדנה שני ילדים בשורה אחת');
  eq(dana?.state, 'active', 'והיא מסומנת כנכנסה');

  const shira = all.body.parents.find(p => p.id_number === '000000034');
  eq(shira?.state, 'blocked', 'מי שיש לו קו נייח מסומן חסום');
  eq(shira?.blocked_reason, 'no_phone', 'והסיבה נאמרת — לא סתם "לא נכנס"');
  eq(shira?.phone, null, 'ומספר הקו הנייח לא מוצג כאילו אפשר לשלוח אליו');

  head('3. סניף של מישהו אחר');
  const mgrView = await request({ path: '/api/parent-signups', token: manager });
  ok(!mgrView.body.parents.some(p => p.id_number === '000000042'),
    'מנהל סניף אינו רואה משפחות של סניף אחר');
  eq(mgrView.body.summary.parents, 3, 'ורואה רק את שלוש המשפחות שלו');

  eq((await request({
    path: `/api/parent-signups?branch=${tlv._id}`, token: manager,
  })).status, 403, 'ובקשה מפורשת לסניף אחר נדחית — לא מוחזרת ריקה');

  const adminTlv = await request({ path: `/api/parent-signups?branch=${tlv._id}`, token: admin });
  eq(adminTlv.body.summary.parents, 1, 'מנהל מערכת כן רואה את תל אביב');

  head('4. סינון לפי כיתה');
  const infants = await request({
    path: `/api/parent-signups?classroom=${encodeURIComponent('תינוקיה 20')}`, token: admin,
  });
  eq(infants.body.summary.children, 3, 'שלושה ילדים בתינוקיה');
  ok(infants.body.parents.every(p => p.classrooms.includes('תינוקיה 20')),
    'וכל ההורים ברשימה שייכים לה');

  head('5. מה הלוח אומר על הכיתה');
  const yael = all.body.parents
    .find(p => p.id_number === '000000018')?.children
    .find(c => c.name === 'יעל כהן');
  eq(yael?.board, 'full', 'ילדת תינוקייה מסומנת כמקבלת לוח מלא');
  const amit = all.body.parents
    .find(p => p.id_number === '000000018')?.children
    .find(c => c.name === 'עמית כהן');
  eq(amit?.board, 'none', 'וילד בוגרים — ללא לוח');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
}

main()
  .catch((err) => { console.error('\n❌ נפילה:', err); failures++; })
  .finally(async () => {
    try { if (server) await new Promise(r => server.close(r)); } catch { /* ignore */ }
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    try { if (mongod) await mongod.stop(); } catch { /* ignore */ }
    process.exit(failures === 0 ? 0 : 1);
  });
