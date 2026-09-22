#!/usr/bin/env node
/**
 * לוח כיתה — the tablet on the wall, end to end.
 *
 * This account is different from every other one in the system: it is not a
 * person, it lives signed in all day, and it hangs in a room that three-year-
 * olds, their parents and whoever came to collect them all walk through. The
 * question every check below asks is the same one — if that tablet leaves the
 * building, what does it open?
 *
 * The answer has to be "one room's day, and that room's photographs". Check 5
 * is the load-bearing one: several routers in this system are guarded by
 * nothing but a logged-in user and decide per row from branch scope (גיוס says
 * so in its own header), and a board has a branch_id. Without the wall in
 * middleware/auth a tablet token would have walked straight into the candidate
 * list of the gan it hangs in — and into whatever gets built the same way next
 * year. That is why the rule is an allowlist and not a set of guards.
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL. dotenv is stubbed out of require.cache
 * before anything loads it, so server/.env — which on this machine points at
 * production — is never read, and the connection host is asserted to be
 * loopback before a single document is written.
 *
 *   node scripts/classroom-board-e2e.test.js
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
const BOARD_PASSWORD = 'luach2026';
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

async function login(full_name, id_number) {
  const r = await request({
    method: 'POST', path: '/api/auth/login-password',
    body: { full_name, id_number, password: PASSWORD },
  });
  if (r.status !== 200 || !r.body?.token) throw new Error(`התחברות נכשלה: ${r.status} ${r.text}`);
  return r.body.token;
}

let mongod = null;
let server = null;

async function main() {
  console.log('=== לוח כיתה — בדיקת קצה-אל-קצה ===');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_board_e2e' } });
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'board-e2e-secret';
  process.env.PARENT_SECRET = 'board-e2e-parent-secret';
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

  const { User, Branch, Classroom, Child, Registration, Candidate } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const ks = await Branch.create({ name: 'כפר סבא - משה דיין', address: 'משה דיין 9' });
  const tlv = await Branch.create({ name: 'תל אביב - יפו', address: 'יפו 1' });

  const YEAR = '2026-2027';
  const roomA = await Classroom.create({ name: 'צעירים', branch_id: ks._id, academic_year: YEAR, is_active: true });
  const roomB = await Classroom.create({ name: 'תינוקייה א', branch_id: ks._id, academic_year: YEAR, is_active: true });
  const roomC = await Classroom.create({ name: 'תינוקייה', branch_id: tlv._id, academic_year: YEAR, is_active: true });

  // A Child hangs off a Registration, so the two are seeded together — the
  // board renders the roster and an empty room would pass check 4 by accident.
  const mkChild = async (name, room, uid) => {
    const reg = await Registration.create({
      unique_id: uid, child_name: name, parent_name: `הורה של ${name}`,
      monthly_fee: 2000, branch_id: ks._id, academic_year: YEAR,
      start_date: new Date(`${YEAR.slice(0, 4)}-09-01`), end_date: new Date(`${YEAR.slice(5)}-08-31`),
    });
    return Child.create({
      registration_id: reg._id, child_name: name, classroom_id: room._id,
      branch_id: ks._id, academic_year: YEAR, is_active: true,
    });
  };
  await mkChild('יעל כהן', roomA, 'E2E-1');
  await mkChild('איתי לוי', roomB, 'E2E-2');

  const mkUser = (o) => User.create({ password_hash: passwordHash, password_set: true, is_active: true, ...o });
  await mkUser({
    email: 'admin@e2e.local', full_name: 'אורי מנהל', id_number: '900000001',
    role: 'system_admin', branch_id: ks._id, position: 'מנהל מערכת',
  });
  await mkUser({
    email: 'ks@e2e.local', full_name: 'לידור כהן', id_number: '900000002',
    role: 'branch_manager', branch_id: ks._id, managed_branch_ids: [ks._id], position: 'מנהלת סניף',
  });

  // Something the board must never reach, built the way גיוס is: a router with
  // no role gate that decides from branch scope.
  await Candidate.create({
    full_name: 'מועמדת סודית', phone: '0541112233', branch_ids: [ks._id],
    applications: [{ at: new Date(), source: 'website' }],
  });

  const adminToken = await login('אורי מנהל', '900000001');

  /* ---------------------------------------------------------------- */
  head('1. מנהל מערכת יוצר לוח לכיתה');
  const before = await request({ path: '/api/classroom-boards', token: adminToken });
  eq(before.status, 200, 'הרשימה נטענת');
  eq((before.body?.boards || []).length, 0, 'אין עדיין לוחות');
  ok((before.body?.missing || []).length === 3, 'ושלוש הכיתות מוצגות כחסרות לוח');

  const created = await request({
    method: 'POST', path: '/api/classroom-boards', token: adminToken,
    body: { classroom_id: String(roomA._id), password: BOARD_PASSWORD },
  });
  eq(created.status, 201, 'הלוח נוצר');
  const board = created.body.board;
  eq(board.classroom, 'צעירים', 'ומשויך לכיתה');
  ok(!!board.board_token, 'עם קישור משלו');
  eq(board.has_password, true, 'וסיסמה');

  eq((await request({
    method: 'POST', path: '/api/classroom-boards', token: adminToken,
    body: { classroom_id: String(roomA._id), password: BOARD_PASSWORD },
  })).status, 409, 'לוח שני לאותה כיתה נדחה');
  eq((await request({
    method: 'POST', path: '/api/classroom-boards', token: adminToken,
    body: { classroom_id: String(roomB._id), password: '123' },
  })).status, 400, 'סיסמה קצרה נדחית');

  // בוגרים keeps no daily board, so a tablet there would open on nothing.
  const olderRoom = await Classroom.create({
    name: 'בוגרים 30', branch_id: ks._id, academic_year: YEAR, is_active: true,
  });
  ok(!(before.body?.missing || []).some(m => m.classroom === 'בוגרים 30'),
    'כיתת בוגרים אינה מוצעת להגדרת לוח');
  eq((await request({
    method: 'POST', path: '/api/classroom-boards', token: adminToken,
    body: { classroom_id: String(olderRoom._id), password: 'abcdef' },
  })).status, 400, 'וגם בקשה ישירה ליצור לה לוח נדחית');

  head('2. הקישור אומר איזה לוח הוא — ולא יותר מזה');
  const info = await request({ path: `/api/public/board/${board.board_token}` });
  eq(info.status, 200, 'נענה בלי התחברות');
  eq(info.body?.classroom, 'צעירים', 'שם הכיתה');
  eq(info.body?.branch, 'כפר סבא - משה דיין', 'ושם הסניף');
  eq(info.body?.has_biometric, false, 'עדיין בלי כניסה ביומטרית');
  ok(!('password_hash' in (info.body || {})), 'ושום דבר נוסף');
  eq((await request({ path: '/api/public/board/lo-kayam' })).status, 404, 'קישור שאינו קיים — 404');

  head('3. הסיסמה היא מה שפותח');
  eq((await request({
    method: 'POST', path: `/api/public/board/${board.board_token}/login`, body: { password: 'לא נכון' },
  })).status, 401, 'סיסמה שגויה נדחית');
  const signedIn = await request({
    method: 'POST', path: `/api/public/board/${board.board_token}/login`, body: { password: BOARD_PASSWORD },
  });
  eq(signedIn.status, 200, 'הסיסמה הנכונה פותחת');
  const boardToken = signedIn.body.token;
  ok(!!boardToken, 'והתקבל טוקן');
  eq(signedIn.body.user.role, 'classroom_board', 'בתפקיד לוח כיתה');
  eq(signedIn.body.user.classroom, 'צעירים', 'עם הכיתה שלו');

  head('4. הלוח רואה את הכיתה שלו — ורק אותה');
  const boardView = await request({ path: '/api/nursery/board', token: boardToken });
  eq(boardView.status, 200, 'הלוח נטען');
  eq((boardView.body?.classrooms || []).length, 1, '⚠️ רשימת הכיתות באורך אחת');
  eq(boardView.body?.classroom?.name, 'צעירים', 'והיא הכיתה שלו');
  ok((boardView.body?.children || []).some(c => c.name === 'יעל כהן'), 'הילדים של הכיתה מוצגים');
  ok(!(boardView.body?.children || []).some(c => c.name === 'איתי לוי'),
    'וילד מכיתה אחרת אינו מוצג');

  // Asking for somebody else's room by id must not produce it.
  const askedOther = await request({ path: `/api/nursery/board?classroom=${roomB._id}`, token: boardToken });
  eq(askedOther.body?.classroom?.name, 'צעירים',
    '⚠️ בקשה מפורשת לכיתה אחרת חוזרת לכיתה שלו, לא לשלה');

  head('5. הקיר — כל השאר סגור, גם מה שאין עליו שומר תפקיד');
  const closed = [
    ['/api/recruitment', 'גיוס — ראוטר בלי בדיקת תפקיד'],
    ['/api/payroll/employees', 'עובדים ושכר'],
    ['/api/children', 'רשימת הילדים של הגן'],
    ['/api/employee-file/000000000000000000000000', 'תיק עובד'],
    ['/api/classroom-boards', 'הלוחות עצמם'],
    ['/api/collections', 'גבייה'],
    ['/api/leads', 'פניות הורים'],
    ['/api/branches', 'סניפים'],
    ['/api/employee-onboarding', 'רישומי עובדים'],
  ];
  for (const [path, label] of closed) {
    const r = await request({ path, token: boardToken });
    eq(r.status, 403, label);
  }
  const recruit = await request({ path: '/api/recruitment', token: boardToken });
  ok(!/מועמדת סודית/.test(recruit.text || ''), '⚠️ ושום מועמדת לא דלפה בגוף התשובה');

  head('6. מה שכן פתוח — וזה בדיוק העבודה');
  eq((await request({ path: '/api/photos/classrooms', token: boardToken })).status, 200, 'תמונות הכיתה');
  eq((await request({ path: '/api/auth/me', token: boardToken })).status, 200, 'מי אני');
  const child = (boardView.body?.children || [])[0];
  const wrote = await request({
    method: 'PATCH', path: `/api/nursery/log/${child.id}`, token: boardToken,
    body: { attendance: 'הגיע' },
  });
  eq(wrote.status, 200, 'סימון נוכחות נשמר');
  const reread = await request({ path: '/api/nursery/board', token: boardToken });
  const saved = (reread.body?.children || []).find(c => String(c.id) === String(child.id));
  eq(saved?.log?.attendance, 'הגיע', 'והנוכחות חוזרת מהשרת');

  head('7. הטוקן שורד את /auth/me — ולא מאבד את הכיתה');
  // /auth/me re-mints a token whenever the claims it builds differ from the
  // ones the caller holds. A payload without classroom_id would have replaced
  // a working board token with one that has no room at all — mid-morning, on
  // a tablet nobody is watching, failing into a blank screen.
  const meCall = await request({ path: '/api/auth/me', token: boardToken });
  eq(meCall.status, 200, 'נענה');
  const afterMe = meCall.body?.token || boardToken;
  const stillMine = await request({ path: '/api/nursery/board', token: afterMe });
  eq(stillMine.status, 200, 'הלוח עדיין נטען');
  eq(stillMine.body?.classroom?.name, 'צעירים', '⚠️ ועדיין על הכיתה שלו');
  eq((await request({ path: '/api/recruitment', token: afterMe })).status, 403,
    'והקיר עדיין עומד');

  head('8. הלוח אינו מגדיר לוחות ואינו משנה הגדרות רשת');
  eq((await request({
    method: 'POST', path: '/api/classroom-boards', token: boardToken,
    body: { classroom_id: String(roomB._id), password: 'abcdef' },
  })).status, 403, 'לא יוצר לוח נוסף');
  eq((await request({
    method: 'PUT', path: '/api/nursery/settings/options', token: boardToken, body: {},
  })).status, 403, 'ולא משנה את רשימות הלוח לכל הרשת');

  head('9. מנהלת סניף מנהלת את הלוחות שלה בלבד');
  const ksToken = await login('לידור כהן', '900000002');
  const hers = await request({ path: '/api/classroom-boards', token: ksToken });
  eq(hers.status, 200, 'הרשימה נטענת לה');
  ok((hers.body?.missing || []).every(m => m.branch === 'כפר סבא - משה דיין'),
    'ורואה רק כיתות של הסניף שלה');
  const tlvBoard = await request({
    method: 'POST', path: '/api/classroom-boards', token: adminToken,
    body: { classroom_id: String(roomC._id), password: BOARD_PASSWORD },
  });
  eq((await request({
    method: 'POST', path: `/api/classroom-boards/${tlvBoard.body.board.id}/password`,
    token: ksToken, body: { password: 'zzzzzz' },
  })).status, 403, 'ולא נוגעת בלוח של סניף אחר');

  head('10. טאבלט שאבד — ביטול מנתק אותו');
  const oldToken = board.board_token;
  const revoked = await request({
    method: 'POST', path: `/api/classroom-boards/${board.id}/revoke`, token: adminToken,
  });
  eq(revoked.status, 200, 'הביטול עובר');
  ok(revoked.body.board.board_token !== oldToken, 'והקישור התחלף');
  eq((await request({ path: `/api/public/board/${oldToken}` })).status, 404, 'הקישור הישן מת');
  eq(revoked.body.board.has_biometric, false, 'ומפתחות המכשיר נמחקו');

  head('11. לוח מכובה אינו נפתח');
  await request({
    method: 'PATCH', path: `/api/classroom-boards/${board.id}`, token: adminToken, body: { is_active: false },
  });
  eq((await request({ path: `/api/public/board/${revoked.body.board.board_token}` })).status, 404,
    'הקישור מפסיק לענות');
  eq((await request({
    method: 'POST', path: `/api/public/board/${revoked.body.board.board_token}/login`,
    body: { password: BOARD_PASSWORD },
  })).status, 404, 'וגם הכניסה');

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
