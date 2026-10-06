#!/usr/bin/env node
/**
 * The parent link — where can it reach?
 *
 * Before משה דיין's families are put on the portal, this asks the only question
 * that matters about letting several hundred outsiders hold a token into the
 * gan's own database: with a real parent's credential in hand, what opens?
 *
 * The answer has to be "their own children, and nothing else". Not "their own
 * children, and the staff screens happen to need a different token" — the
 * difference between those two sentences is a test, and until now there was
 * none. Every assertion below is written to FAIL if somebody later mounts a
 * parent route without the guard, mints a parent token with the staff key, or
 * trusts an id out of the URL.
 *
 * Six walls, in the order an attacker meets them:
 *
 *   1. The token does not cross.          A parent's token on staff routes.
 *   2. The forgery does not cross.        A staff-signed token shaped as a parent's.
 *   3. The guard is on every route.       No token at all, 36 routes.
 *   4. Another family is a 404.           Every child-scoped route, a real sibling id.
 *   5. Every other id is checked too.     photo, contract, document, pickup.
 *   6. Nobody else's device, account or branch.
 *
 * Wall 4 is the load-bearing one and it is deliberately not spot-checked: the
 * route table is read out of parent.routes.js itself, so a route added next
 * year is tested the day it is added or this file says it was missed.
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL. dotenv is stubbed out of require.cache
 * before anything loads it, so server/.env — which on this machine points at
 * production — is never read, and the connection host is asserted to be
 * loopback before a single document is written.
 *
 *   node scripts/parent-portal-authz.test.js
 */
const net = require('net');
const http = require('http');
const crypto = require('crypto');

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const PASSWORD = 'test1234';
const JWT_SECRET = 'parent-authz-staff-secret';
let failures = 0;
let checks = 0;

const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
};
const eq = (a, b, label) => ok(a === b, label, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const oneOf = (a, list, label) => ok(list.includes(a), label, `קיבלנו ${a}, ציפינו אחד מ-${list.join('/')}`);
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

/**
 * Every guarded route in the parent router, read out of the router itself.
 *
 * Hand-listing them is how a route added in a hurry escapes its test, so the
 * express layer stack is walked instead and the four anonymous auth routes are
 * removed by name. `:param` placeholders are filled by the caller.
 */
function parentRoutes() {
  const router = require('../src/routes/parent.routes');
  const anonymous = new Set([
    '/auth/start', '/auth/verify', '/auth/set-password', '/auth/login',
  ]);
  const out = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const p = layer.route.path;
    if (anonymous.has(p)) continue;
    for (const [method, on] of Object.entries(layer.route.methods || {})) {
      if (on) out.push({ method: method.toUpperCase(), path: p });
    }
  }
  return out;
}

/** A body that gets past the 400s, so a 200 would really mean "it let me in". */
function bodyFor({ method, path }) {
  if (method === 'GET' || method === 'DELETE') return undefined;
  if (path.endsWith('/photo-digest')) return { mode: 'off' };
  if (path.endsWith('/face-consent')) return { given: true };
  if (path.endsWith('/push/register')) return { fcm_token: 'probe-token', platform: 'android' };
  if (path.endsWith('/push/unregister')) return { fcm_token: 'probe-token' };
  if (path.endsWith('/second-parent')) return { name: 'בודק', id_number: '000000018', phone: '0501112233' };
  if (path.endsWith('/faces')) return { action: 'hide', face_index: 0 };
  if (path.endsWith('/pickup')) return { full_name: 'דוד', id_number: '000000018', relation: 'סבא' };
  if (path.endsWith('/absences')) return { date: '2030-01-01' };
  if (path.endsWith('/gift')) return { photo_id: null };
  if (path.endsWith('/phone/start')) return { phone: '0501112233' };
  if (path.endsWith('/phone/confirm')) return { code: '000000' };
  if (path.endsWith('/day')) return { home_mood: 'טוב' };
  if (path.endsWith('/children/:childId')) return { allergies: 'אין' };
  if (path.endsWith('/data-deletion/me')) return { reason: 'בדיקה' };
  return {};
}

let mongod = null;
let server = null;

async function main() {
  console.log('=== פורטל ההורים — לאן הקישור מגיע ===');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_parent_authz' } });
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  // Storage has to LOOK configured, or the document and photograph handlers
  // answer 503 before they ever reach the ownership check and the wall below
  // passes without having been tested. Nothing is ever uploaded or signed —
  // every assertion here is on a refusal, which happens first.
  process.env.STORAGE_ENDPOINT = 'http://127.0.0.1:1/authz';
  process.env.STORAGE_ACCESS_KEY_ID = 'authz';
  process.env.STORAGE_SECRET_ACCESS_KEY = 'authz';
  process.env.STORAGE_BUCKET = 'authz';
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

  const {
    User, Branch, Classroom, Child, Registration, ParentAccount, Photo,
    Contract, ReconcileDecision, PushSubscription, ParentVisibility,
  } = require('../src/models');
  const { signParentToken, signSetupToken } = require('../src/middleware/parentAuth');

  /* ---------------------------------------------------------------- *
   * Two families in two branches, which is the only way a scope bug
   * shows up: one gan's data is not "other" enough.
   * ---------------------------------------------------------------- */
  const YEAR = '2026-2027';
  const ks = await Branch.create({ name: 'כפר סבא - משה דיין', address: 'משה דיין 9' });
  const tlv = await Branch.create({ name: 'תל אביב', address: 'יפו 1' });
  const roomKs = await Classroom.create({ name: 'תינוקייה א', branch_id: ks._id, academic_year: YEAR, is_active: true });
  const roomTlv = await Classroom.create({ name: 'תינוקייה', branch_id: tlv._id, academic_year: YEAR, is_active: true });

  const mkFamily = async ({ childName, parentName, parentId, childId, phone, room, branch, uid }) => {
    const reg = await Registration.create({
      unique_id: uid, child_name: childName, parent_name: parentName,
      parent_id_number: parentId, parent_phone: phone,
      monthly_fee: 2000, branch_id: branch._id, academic_year: YEAR,
      start_date: new Date(`${YEAR.slice(0, 4)}-09-01`), end_date: new Date(`${YEAR.slice(5)}-08-31`),
    });
    const child = await Child.create({
      registration_id: reg._id, child_name: childName, classroom_id: room._id,
      child_id_number: childId,
      branch_id: branch._id, academic_year: YEAR, is_active: true,
    });
    const account = await ParentAccount.create({
      id_number: parentId, full_name: parentName, phone,
      activated: true, access_approved: true, is_active: true,
      password_hash: await bcrypt.hash(PASSWORD, 10),
    });
    return { reg, child, account };
  };

  const mine = await mkFamily({
    childName: 'יעל כהן', parentName: 'דנה כהן', parentId: '000000018',
    childId: '111111180', phone: '0501111111', room: roomKs, branch: ks, uid: 'AZ-1',
  });
  const theirs = await mkFamily({
    childName: 'איתי לוי', parentName: 'רון לוי', parentId: '000000026',
    childId: '222222260', phone: '0502222222', room: roomTlv, branch: tlv, uid: 'AZ-2',
  });

  const parentToken = signParentToken(mine.account);
  const otherParentToken = signParentToken(theirs.account);

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({
    email: 'admin@authz.local', full_name: 'אורי מנהל', id_number: '900000001',
    role: 'system_admin', branch_id: ks._id, position: 'מנהל מערכת',
    password_hash: passwordHash, password_set: true, is_active: true,
  });
  await User.create({
    email: 'teach@authz.local', full_name: 'נועה גננת', id_number: '900000002',
    role: 'teacher', branch_id: ks._id, position: 'גננת',
    password_hash: passwordHash, password_set: true, is_active: true,
  });
  const staffLogin = async (full_name, id_number) => {
    const r = await request({
      method: 'POST', path: '/api/auth/login-password',
      body: { full_name, id_number, password: PASSWORD },
    });
    if (r.status !== 200 || !r.body?.token) throw new Error(`התחברות צוות נכשלה: ${r.status} ${r.text}`);
    return r.body.token;
  };
  const adminToken = await staffLogin('אורי מנהל', '900000001');
  const teacherToken = await staffLogin('נועה גננת', '900000002');

  /* ---------------------------------------------------------------- */
  head('0. הקישור עצמו — הורה אמת נכנס ורואה את הילדה שלו');
  const me = await request({ path: '/api/parent/me', token: parentToken });
  eq(me.status, 200, 'הטוקן של ההורה עובד על הפורטל');
  eq((me.body?.children || []).length, 1, 'ורואה ילד אחד — שלו');

  const ownChildOk = await request({
    path: `/api/parent/children/${mine.child._id}`, token: parentToken,
  });
  eq(ownChildOk.status, 200, 'והילדה שלו נפתחת');

  /* ---------------------------------------------------------------- *
   * WALL 1. The token does not cross.
   * ---------------------------------------------------------------- */
  head('1. חומה ראשונה — טוקן של הורה על מסכי הצוות');
  // Chosen to span the shapes the staff side is built in: a role-gated route,
  // a tab-gated route, a router with NO guard that decides from branch scope
  // (גיוס), payroll, and the admin surface.
  const staffTargets = [
    ['GET', '/api/employees'],
    ['GET', '/api/children'],
    ['GET', '/api/registrations'],
    ['GET', '/api/candidates'],
    ['GET', '/api/payroll/summary'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/branches'],
    ['GET', '/api/nursery/settings'],
    ['GET', '/api/gantt/visibility?branch=all'],
    ['GET', '/api/photos'],
    ['GET', '/api/announcements'],
    ['GET', '/api/parent-changes'],
    ['GET', '/api/finance/summary'],
    ['GET', '/api/reports/attendance'],
    ['GET', '/api/suppliers'],
    ['GET', '/api/documents'],
    ['GET', '/api/contracts'],
    ['GET', '/api/discounts'],
    ['GET', '/api/shifts'],
    ['GET', '/api/punches'],
  ];
  let crossed = 0;
  for (const [method, path] of staffTargets) {
    const r = await request({ method, path, token: parentToken });
    if (r.status !== 401) {
      crossed++;
      console.log(`     ↳ ${method} ${path} → ${r.status}`);
    }
  }
  eq(crossed, 0, `כל ${staffTargets.length} מסכי הצוות מחזירים 401 לטוקן של הורה`);

  const adminOnParent = await request({ path: '/api/parent/me', token: adminToken });
  eq(adminOnParent.status, 401, 'ולהפך — טוקן של מנהל מערכת נדחה מהפורטל');
  const teacherOnParent = await request({
    path: `/api/parent/children/${mine.child._id}`, token: teacherToken,
  });
  eq(teacherOnParent.status, 401, 'וגם טוקן של גננת');

  /* ---------------------------------------------------------------- *
   * WALL 2. The forgery does not cross.
   *
   * The entire separation rests on one line: PARENT_SECRET is derived from
   * JWT_SECRET, so the two keys verify different tokens. If that derivation
   * is ever removed, these three checks are what notices.
   * ---------------------------------------------------------------- */
  head('2. חומה שנייה — זיוף');
  const forgedParent = jwt.sign(
    { pid: String(mine.account._id), id_number: mine.account.id_number, typ: 'parent' },
    JWT_SECRET, { expiresIn: '30d' },
  );
  eq((await request({ path: '/api/parent/me', token: forgedParent })).status, 401,
    'טוקן הורה שנחתם במפתח של הצוות נדחה מהפורטל');
  eq((await request({ path: '/api/employees', token: forgedParent })).status, 401,
    'וגם לא נכנס לצד הצוות');

  const setupTicket = signSetupToken(mine.account);
  eq((await request({ path: '/api/parent/me', token: setupTicket })).status, 401,
    'כרטיס בחירת סיסמה אינו טוקן כניסה');

  eq((await request({
    path: '/api/parent/me',
    token: jwt.sign({ pid: String(mine.account._id), typ: 'parent' },
      crypto.randomBytes(32).toString('hex'), { expiresIn: '30d' }),
  })).status, 401, 'טוקן שנחתם במפתח אקראי נדחה');

  const closed = await ParentAccount.create({
    id_number: '000000034', full_name: 'הורה סגור', phone: '0503333333',
    activated: true, access_approved: true, is_active: false,
  });
  eq((await request({ path: '/api/parent/me', token: signParentToken(closed) })).status, 403,
    'חשבון שנסגר נחסם גם עם טוקן תקף שנותר בידיו');

  /* ---------------------------------------------------------------- *
   * WALL 3. The guard is on every route.
   * ---------------------------------------------------------------- */
  head('3. חומה שלישית — אין מסלול בלי שומר');
  const routes = parentRoutes();
  ok(routes.length >= 30, `נסרקו ${routes.length} מסלולים מתוך parent.routes.js`);
  let unguarded = 0;
  for (const route of routes) {
    const path = `/api/parent${route.path
      .replace(':childId', String(mine.child._id))
      .replace(':photoId', String(new mongoose.Types.ObjectId()))
      .replace(':contractId', String(new mongoose.Types.ObjectId()))
      .replace(':docId', String(new mongoose.Types.ObjectId()))
      .replace(':date', '2030-01-01')
      .replace(':id', String(new mongoose.Types.ObjectId()))}`;
    const r = await request({ method: route.method, path, body: bodyFor(route) });
    if (r.status !== 401) {
      unguarded++;
      console.log(`     ↳ ${route.method} ${route.path} ללא טוקן → ${r.status}`);
    }
  }
  eq(unguarded, 0, `כל ${routes.length} המסלולים דורשים טוקן הורה`);

  /* ---------------------------------------------------------------- *
   * WALL 4. Another family is a 404.
   * ---------------------------------------------------------------- */
  head('4. חומה רביעית — ילד של משפחה אחרת');
  const childScoped = routes.filter(r => r.path.includes(':childId'));
  ok(childScoped.length >= 20, `${childScoped.length} מסלולים מקבלים מזהה ילד`);
  let leaked = 0;
  for (const route of childScoped) {
    const path = `/api/parent${route.path
      .replace(':childId', String(theirs.child._id))
      .replace(':photoId', String(new mongoose.Types.ObjectId()))
      .replace(':contractId', String(new mongoose.Types.ObjectId()))
      .replace(':docId', String(new mongoose.Types.ObjectId()))
      .replace(':date', '2030-01-01')
      .replace(':id', String(new mongoose.Types.ObjectId()))}`;
    const r = await request({ method: route.method, path, token: parentToken, body: bodyFor(route) });
    // 404 is the designed answer. 403 would also be a refusal, so it is
    // tolerated; anything else means the handler did something with the id.
    if (r.status !== 404 && r.status !== 403) {
      leaked++;
      console.log(`     ↳ ${route.method} ${route.path} על ילד של אחר → ${r.status}`);
    }
  }
  eq(leaked, 0, `כל ${childScoped.length} המסלולים מסרבים לילד של משפחה אחרת`);

  eq((await request({
    path: `/api/parent/children/${new mongoose.Types.ObjectId()}`, token: parentToken,
  })).status, 404, 'ומזהה שלא קיים בכלל מקבל אותה תשובה — לא מגלים מה קיים');

  /* ---------------------------------------------------------------- *
   * WALL 5. Every OTHER id in the URL is checked too.
   *
   * childId was always validated. The ids beside it were the gap: a photograph
   * id, a contract id, a document id, a pickup id — each one a second chance
   * to ask for something that is not yours, on a route that already proved the
   * child was.
   * ---------------------------------------------------------------- */
  head('5. חומה חמישית — כל מזהה אחר בכתובת');

  const today = require('../src/services/nursery.service').todayKey();
  const mkPhoto = (key, room, branch, childIds, faceChild) => Photo.create({
    key, classroom_id: room._id, branch_id: branch._id, source: 'staff', date: today,
    child_ids: childIds,
    faces: [{ bbox: [0, 0, 10, 10], det_score: 0.99, child_id: faceChild }],
  });
  // Another branch's photograph, with one untagged face — the shape the grab
  // needed: `is_my_child` refuses a face already confidently somebody else's.
  const otherPhoto = await mkPhoto('authz/other.jpg', roomTlv, tlv, [theirs.child._id], null);
  const minePhoto = await mkPhoto('authz/mine.jpg', roomKs, ks, [mine.child._id], mine.child._id);

  // THE ONE THAT MATTERED. "זה כן הילד שלי" on another branch's photograph
  // attached this child to it, and the photograph then came back through the
  // parent's own gallery with a signed URL on it.
  const grab = await request({
    method: 'POST', token: parentToken,
    path: `/api/parent/children/${mine.child._id}/photos/${otherPhoto._id}/faces`,
    body: { action: 'is_my_child', face_index: 0 },
  });
  eq(grab.status, 404, 'לא מצליחים לסמן "זה הילד שלי" על תמונה מסניף אחר');
  const stillClean = await Photo.findById(otherPhoto._id).lean();
  eq(stillClean.child_ids.map(String).includes(String(mine.child._id)), false,
    'והילד לא הודבק לתמונה ההיא');

  for (const action of ['hide', 'unhide', 'not_my_child']) {
    eq((await request({
      method: 'POST', token: parentToken,
      path: `/api/parent/children/${mine.child._id}/photos/${otherPhoto._id}/faces`,
      body: { action, face_index: 0 },
    })).status, 404, `גם "${action}" על תמונה של אחר מסורב`);
  }
  eq((await request({
    method: 'POST', token: parentToken,
    path: `/api/parent/children/${mine.child._id}/photos/${new mongoose.Types.ObjectId()}/faces`,
    body: { action: 'hide', face_index: 0 },
  })).status, 404, 'ומזהה תמונה שלא קיים');
  eq((await request({
    method: 'POST', token: parentToken,
    path: `/api/parent/children/${mine.child._id}/photos/not-an-id/faces`,
    body: { action: 'hide', face_index: 0 },
  })).status, 404, 'ומזהה תמונה שבור — 404 ולא 500');

  // The gallery still works, so the wall is a wall and not a brick.
  const hideOwn = await request({
    method: 'POST', token: parentToken,
    path: `/api/parent/children/${mine.child._id}/photos/${minePhoto._id}/faces`,
    body: { action: 'hide', face_index: 0 },
  });
  oneOf(hideOwn.status, [200], 'התמונה של הילדה שלו — כן, ההסתרה עובדת');

  const otherContract = await Contract.create({
    registration_id: theirs.reg._id, type: 'enrollment', branch_id: tlv._id,
    file_name: 'other.pdf', file_data: Buffer.from('%PDF-1.4 other').toString('base64'),
  });
  eq((await request({
    token: parentToken,
    path: `/api/parent/children/${mine.child._id}/contracts/${otherContract._id}/file`,
  })).status, 404, 'חוזה של משפחה אחרת אינו נפתח דרך הילדה שלו');

  // The shared documents live on the other family's ReconcileDecision, keyed
  // by the CHILD's id number — the one scope in the portal that is not the
  // child's ObjectId, and therefore the one worth its own check.
  const otherDecision = await ReconcileDecision.create({
    branch_id: tlv._id, academic_year: YEAR, id_number: '222222260',
    documents: [{
      key: 'authz/other-doc.pdf', file_name: 'הסכם.pdf', visible_to_parent: true,
    }],
  });
  eq((await request({
    token: parentToken,
    path: `/api/parent/children/${mine.child._id}/documents/${otherDecision.documents[0]._id}/file`,
  })).status, 404, 'ומסמך שהגן שיתף עם משפחה אחרת');

  const theirPickup = await request({
    method: 'POST', token: otherParentToken,
    path: `/api/parent/children/${theirs.child._id}/pickup`,
    body: { full_name: 'סבתא של איתי', id_number: '000000042', relation: 'סבתא' },
  });
  if (theirPickup.status === 200 || theirPickup.status === 201) {
    const id = theirPickup.body?.pickup?.id || theirPickup.body?.pickup?._id || theirPickup.body?.id;
    if (id) {
      eq((await request({
        method: 'DELETE', token: parentToken,
        path: `/api/parent/children/${mine.child._id}/pickup/${id}`,
      })).status, 404, 'ואי אפשר לבטל מורשה איסוף של משפחה אחרת');
    }
  }

  /* ---------------------------------------------------------------- *
   * WALL 6. Nobody else's device, account or branch.
   * ---------------------------------------------------------------- */
  head('6. חומה שישית — מכשיר, חשבון וסניף של מישהו אחר');

  await PushSubscription.create({
    fcm_token: 'staff-device-token', platform: 'android', user_id: (await User.findOne({ id_number: '900000001' }))._id,
  });
  await request({
    method: 'POST', token: parentToken, path: '/api/parent/push/unregister',
    body: { fcm_token: 'staff-device-token' },
  });
  ok(await PushSubscription.exists({ fcm_token: 'staff-device-token' }),
    'הורה אינו משתיק את הטלפון של מנהל המערכת');

  await request({
    method: 'POST', token: parentToken, path: '/api/parent/push/register',
    body: { fcm_token: 'parent-device-token', platform: 'android' },
  });
  await request({
    method: 'POST', token: otherParentToken, path: '/api/parent/push/unregister',
    body: { fcm_token: 'parent-device-token' },
  });
  ok(await PushSubscription.exists({ fcm_token: 'parent-device-token' }),
    'ולא את הטלפון של הורה אחר');
  await request({
    method: 'POST', token: parentToken, path: '/api/parent/push/unregister',
    body: { fcm_token: 'parent-device-token' },
  });
  ok(!(await PushSubscription.exists({ fcm_token: 'parent-device-token' })),
    'אבל את המכשיר שלו עצמו — כן');

  // The takeover chain: name another family's parent as "the second parent" of
  // your own child, and their one-time code starts arriving on your phone.
  head('   הוספת "הורה נוסף" — מי מותר לנקוב בו');
  const takeover = await request({
    method: 'POST', token: parentToken,
    path: `/api/parent/children/${mine.child._id}/second-parent`,
    body: { name: 'רון לוי', id_number: theirs.account.id_number, phone: '0509999999' },
  });
  eq(takeover.status, 409, 'ת.ז של הורה אחר במערכת מסורבת');
  const untouched = await Child.findById(mine.child._id).lean();
  eq(untouched.parent2_id_number || null, null, 'ושום דבר לא נכתב על הילדה');
  const victim = await ParentAccount.findById(theirs.account._id).lean();
  eq(victim.phone, '0502222222', 'והטלפון של ההורה האחר לא שונה');

  // Asserted on the resolver rather than through /auth/start, because the SMS
  // provider is not configured here and a 502 would hide the answer. This is
  // the exact line the takeover turned: where the one-time code is addressed.
  const { findParent } = require('../src/services/parentDirectory.service');
  const victimResolved = await findParent(theirs.account.id_number);
  eq(victimResolved.phone, '0502222222',
    'וקוד הכניסה שלו ממשיך להיפתר לטלפון שלו, לא לזה שהוקלד');

  const stranger = await request({
    method: 'POST', token: parentToken,
    path: `/api/parent/children/${mine.child._id}/second-parent`,
    body: { name: 'אבא של יעל', id_number: '000000059', phone: '0508888888' },
  });
  if (stranger.status === 200) {
    const row = await Child.findById(mine.child._id).lean();
    eq(row.parent2_id_number, '000000059', 'ת.ז שאינה מוכרת כן נרשמת');
    eq(row.parent2_phone || null, null, 'אבל הטלפון ממתין לאישור הגן ולא נכתב על הילדה');
    const pending = await ParentAccount.findOne({ id_number: '000000059' }).lean();
    eq(pending.access_approved, false, 'והחשבון נוצר ללא גישה');
    const hint = await request({
      method: 'POST', path: '/api/parent/auth/start', body: { id_number: '000000059' },
    });
    oneOf(hint.status, [403, 409], 'ולפני אישור הגן הוא אינו מקבל קוד כניסה');
  } else {
    ok(false, `הוספת הורה נוסף תקין נכשלה: ${stranger.status} ${stranger.text}`);
  }

  // A second attempt on the same child, now that it has a second parent:
  // replacing them is what would redirect their codes, so it is refused.
  eq((await request({
    method: 'POST', token: parentToken,
    path: `/api/parent/children/${mine.child._id}/second-parent`,
    body: { name: 'מישהו אחר', id_number: '000000067', phone: '0507777777' },
  })).status, 409, 'ולהחליף את ההורה השני אי אפשר — רק הגן');

  // The checksum, on a sibling that has no second parent yet so the refusal
  // below can only be the ID number itself. Without the checksum a typo lands
  // on a real stranger's ת.ז.
  const siblingReg = await Registration.create({
    unique_id: 'AZ-3', child_name: 'נועם כהן', parent_name: 'דנה כהן',
    parent_id_number: mine.account.id_number, parent_phone: '0501111111',
    monthly_fee: 2000, branch_id: ks._id, academic_year: YEAR,
    start_date: new Date(`${YEAR.slice(0, 4)}-09-01`), end_date: new Date(`${YEAR.slice(5)}-08-31`),
  });
  const sibling = await Child.create({
    registration_id: siblingReg._id, child_name: 'נועם כהן', classroom_id: roomKs._id,
    child_id_number: '333333340', branch_id: ks._id, academic_year: YEAR, is_active: true,
  });
  eq((await request({
    method: 'POST', token: parentToken,
    path: `/api/parent/children/${sibling._id}/second-parent`,
    body: { name: 'מישהו', id_number: '123456789', phone: '0507777777' },
  })).status, 400, 'ת.ז עם ספרת ביקורת שגויה נדחית');

  head('   המתג שמפרסם להורים');
  const week = require('../src/services/parentVisibility').weekKey(
    new Date().toISOString().slice(0, 10),
  );
  eq((await request({
    method: 'PUT', token: teacherToken, path: '/api/gantt/visibility',
    body: { branch_id: String(ks._id), week, gantt: true },
  })).status, 403, 'גננת אינה מפרסמת גאנט להורים');
  eq((await request({
    method: 'PUT', token: adminToken, path: '/api/gantt/visibility',
    body: { branch_id: String(ks._id), week, gantt: true },
  })).status, 200, 'מנהל מערכת כן');
  ok(await ParentVisibility.exists({ branch_id: ks._id, week, gantt: true }),
    'והמתג נשמר');

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
