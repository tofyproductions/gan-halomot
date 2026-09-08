#!/usr/bin/env node
/**
 * Custom roles — a named permission set, end to end against the real server.
 *
 * THE STORY THIS TEST TELLS. עינת is a גננת who was also given רישום חיצוני,
 * the right to act there, and the employee cards — and had עדכונים taken away.
 * Four checkboxes, ticked by hand on the permissions screen. When the next
 * person is hired to do her job, somebody has to remember which four. So the
 * admin presses "הקם תפקיד מההרשאות של משתמש/ת זה", the four become a role
 * with a name, and the next person is given the role.
 *
 * WHAT MUST HOLD, and what each check here defends:
 *   - her `role` in the database stays 'teacher' — the custom role moves the
 *     TAB layer and nothing else, because `role` is the field every
 *     branch-scope rule and every requireRole in the codebase reads;
 *   - the role's lists REPLACE the role-wide override for teachers rather than
 *     merging with it (check 5), or a role a teacher is not subject to would
 *     leak into her token;
 *   - a per-user override still beats the role (check 7), same precedence as
 *     always;
 *   - deleting the role leaves its holders as ordinary teachers, not as people
 *     with no permissions (check 10).
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL — same harness as viewer-e2e.test.js:
 * dotenv is stubbed out of require.cache before anything can read server/.env
 * (which on this machine points at production), MONGODB_URI is set before
 * src/index.js loads, and the connection host is asserted to be loopback
 * before a single document is written.
 *
 *   node scripts/custom-roles.test.js
 */
const net = require('net');
const http = require('http');

/* 1. Nothing may read server/.env. Stub dotenv before anything loads it. */
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
const JWT_SECRET = 'custom-roles-secret';

let failures = 0;
let checks = 0;

function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}

function eq(actual, expected, label) {
  return ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `קיבלנו ${JSON.stringify(actual)}, ציפינו ${JSON.stringify(expected)}`,
  );
}

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

function request({ method = 'GET', path, token, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
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
    try {
      const r = await request({ path: '/api/health' });
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('השרת לא ענה על /api/health');
}

async function login(full_name, id_number) {
  const r = await request({
    method: 'POST', path: '/api/auth/login-password',
    body: { full_name, id_number, password: PASSWORD },
  });
  if (r.status !== 200 || !r.body?.token) {
    throw new Error(`התחברות נכשלה עבור ${full_name}: ${r.status} ${r.text}`);
  }
  return r.body.token;
}

/** The token's claims — what every request will actually be judged on. */
const claims = (token) => jwt.verify(token, JWT_SECRET);

/**
 * The server's own screen gate, run against a token's claims.
 *
 * This is middleware/auth.js#requireTab, the very function every gated route
 * builds its guard from — not a re-implementation of it. Calling it directly
 * asks the one question that matters ("would this person be let into this
 * screen?") without depending on which route happens to be wired to which tab
 * today.
 */
function tabAllowed(token, tabId, defaultRoles, { method = 'GET', url = '/api/x' } = {}) {
  const { requireTab } = require('../src/middleware/auth');
  const req = { user: claims(token), method, originalUrl: url, url, path: url };
  let outcome = null;
  const res = {
    status(code) { outcome = code; return this; },
    json() { return this; },
  };
  requireTab(tabId, ...defaultRoles)(req, res, () => { outcome = 'next'; });
  return outcome === 'next';
}

const CLICKTAC_ROLES = ['system_admin', 'admin_viewer', 'accountant', 'branch_manager'];
const EMPLOYEE_ROLES = ['teacher', 'assistant', 'class_leader', 'cook'];

let mongod = null;
let server = null;

async function main() {
  console.log('=== תפקידים מותאמים — בדיקת קצה-אל-קצה מול השרת האמיתי ===');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_custom_roles' } });
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.PARENT_SECRET = 'custom-roles-parent-secret';
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

  const { User, Branch, CustomRole, Setting } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const branchA = await Branch.create({ name: 'תל אביב', address: 'הרצל 1' });
  const branchB = await Branch.create({ name: 'כפר סבא', address: 'ויצמן 2' });

  const mkUser = (o) => User.create({
    password_hash: passwordHash, password_set: true, is_active: true, ...o,
  });

  const admin = await mkUser({
    email: 'admin@roles.local', full_name: 'אורי מנהל', id_number: '910000001',
    role: 'system_admin', branch_id: branchA._id, position: 'מנהל מערכת',
  });
  // עינת — the person the feature exists for. Base גננת, four checkboxes.
  const einat = await mkUser({
    email: 'einat@roles.local', full_name: 'עינת גננת', id_number: '910000002',
    role: 'teacher', branch_id: branchA._id, managed_branch_ids: [branchA._id],
    position: 'גננת',
    tab_overrides_add: ['clicktac', 'clicktac_write', 'employees'],
    tab_overrides_remove: ['my_updates'],
  });
  // The next person hired to do עינת's job.
  const michal = await mkUser({
    email: 'michal@roles.local', full_name: 'מיכל גננת', id_number: '910000003',
    role: 'teacher', branch_id: branchB._id, position: 'גננת',
  });
  // The control: an ordinary teacher, touched by nothing here.
  await mkUser({
    email: 'plain@roles.local', full_name: 'רונית גננת', id_number: '910000004',
    role: 'teacher', branch_id: branchB._id, position: 'גננת',
  });

  const adminToken = await login('אורי מנהל', '910000001');
  let einatToken = await login('עינת גננת', '910000002');
  let michalToken = await login('מיכל גננת', '910000003');
  const plainToken = await login('רונית גננת', '910000004');
  console.log('נזרעו 2 סניפים ו-4 משתמשים; כולם התחברו בסיסמה');

  const ADD = ['clicktac', 'clicktac_write', 'employees'];
  const REMOVE = ['my_updates'];
  let roleId = null;

  /* ================================================================ *
   * 1. הקמת תפקיד מההרשאות של עינת
   * ================================================================ */
  head('בדיקה 1 — POST /api/admin/custom-roles/from-user/:userId');
  {
    const r = await request({
      method: 'POST', path: `/api/admin/custom-roles/from-user/${einat._id}`,
      token: adminToken, body: { name: 'גננת עם רישום חיצוני' },
    });
    ok(r.status === 200, '1a התפקיד הוקם (200)', `${r.status} ${r.text}`);
    roleId = r.body?.role?._id;
    eq(r.body?.role?.base_role, 'teacher', '1b תפקיד הבסיס הוא teacher');
    eq(r.body?.role?.tab_add, ADD, '1c tab_add הוא בדיוק שלושת הטאבים שנוספו לה');
    eq(r.body?.role?.tab_remove, REMOVE, '1d tab_remove הוא בדיוק הטאב שהוסר לה');
    eq(r.body?.user?.custom_role_id, String(roleId), '1e המשתמשת שויכה לתפקיד');
    eq(r.body?.user?.custom_role_name, 'גננת עם רישום חיצוני', '1f שם התפקיד חוזר על המשתמשת');
    eq(r.body?.user?.role, 'teacher', '1g התפקיד בבסיס הנתונים נשאר teacher');

    const fresh = await User.findById(einat._id).lean();
    eq(fresh.tab_overrides_add, [], '1h ההרשאות פר-משתמש נוקו — הן התפקיד עכשיו');
    eq(fresh.tab_overrides_remove, [], '1i גם ההסרות פר-משתמש נוקו');
    ok(String(fresh.custom_role_id) === String(roleId), '1j custom_role_id נשמר על המשתמשת');
  }

  /* ================================================================ *
   * 2. הטוקן החדש של עינת
   * ================================================================ */
  head('בדיקה 2 — התחברות מחדש: ה-JWT נושא את התפקיד');
  {
    einatToken = await login('עינת גננת', '910000002');
    const c = claims(einatToken);
    eq(c.role, 'teacher', '2a role ב-JWT הוא תפקיד הבסיס');
    eq(c.role_tab_add, ADD, '2b role_tab_add מגיע מהתפקיד המותאם');
    eq(c.role_tab_remove, REMOVE, '2c role_tab_remove מגיע מהתפקיד המותאם');
    eq(c.tab_overrides_add, [], '2d אין יותר הרשאות פר-משתמש');
    eq(c.custom_role_name, 'גננת עם רישום חיצוני', '2e שם התפקיד ב-JWT');
    eq(c.custom_role_id, String(roleId), '2f מזהה התפקיד ב-JWT');

    const me = await request({ path: '/api/auth/me', token: einatToken });
    eq(me.body?.user?.role_tab_add, ADD, '2g /me מחזיר את אותה רשימה');
    eq(me.body?.user?.role_tab_remove, REMOVE, '2h /me מחזיר את אותה הסרה');
    eq(me.body?.user?.custom_role_name, 'גננת עם רישום חיצוני', '2i /me מחזיר את שם התפקיד');
  }

  /* ================================================================ *
   * 3. הגישה בפועל בשרת
   * ================================================================ */
  head('בדיקה 3 — requireTab מול הטוקן');
  {
    ok(tabAllowed(einatToken, 'clicktac', CLICKTAC_ROLES), '3a עינת נכנסת ל"רישום חיצוני"');
    ok(!tabAllowed(plainToken, 'clicktac', CLICKTAC_ROLES), '3b גננת רגילה נחסמת (403)');
    ok(!tabAllowed(einatToken, 'my_updates', EMPLOYEE_ROLES), '3c "עדכונים" נשלל מעינת');
    ok(tabAllowed(plainToken, 'my_updates', EMPLOYEE_ROLES), '3d "עדכונים" פתוח לגננת רגילה');
    ok(tabAllowed(einatToken, 'nursery', ['system_admin', 'branch_manager', 'class_leader', 'teacher', 'assistant']),
      '3e ברירות המחדל של גננת לא נפגעו');
  }

  /* ================================================================ *
   * 4. הקצאת התפקיד למישהי אחרת
   * ================================================================ */
  head('בדיקה 4 — PATCH /api/admin/users/:id/role { custom_role_id }');
  {
    const r = await request({
      method: 'PATCH', path: `/api/admin/users/${michal._id}/role`,
      token: adminToken, body: { custom_role_id: roleId },
    });
    ok(r.status === 200, '4a ההקצאה הצליחה', `${r.status} ${r.text}`);
    eq(r.body?.user?.role, 'teacher', '4b role נשאר תפקיד הבסיס');
    eq(r.body?.user?.custom_role_name, 'גננת עם רישום חיצוני', '4c שם התפקיד על המשתמשת');

    michalToken = await login('מיכל גננת', '910000003');
    eq(claims(michalToken).role_tab_add, ADD, '4d ה-JWT שלה נושא את אותה רשימה');
    ok(tabAllowed(michalToken, 'clicktac', CLICKTAC_ROLES), '4e גם היא נכנסת ל"רישום חיצוני"');
    ok(!tabAllowed(michalToken, 'my_updates', EMPLOYEE_ROLES), '4f וגם לה "עדכונים" נשלל');

    const list = await request({ path: '/api/admin/custom-roles', token: adminToken });
    const row = (list.body?.roles || []).find(x => x._id === String(roleId));
    eq(row?.user_count, 2, '4g הרשימה סופרת שתי בעלות תפקיד');
  }

  /* ================================================================ *
   * 5. התפקיד המותאם מחליף את הרשאות התפקיד — לא מתמזג איתן
   * ================================================================ */
  head('בדיקה 5 — הרשאה לכל הגננות לא נכנסת לתפקיד המותאם');
  {
    await request({
      method: 'PUT', path: '/api/admin/role-tabs', token: adminToken,
      body: { role_tabs: { teacher: { add: ['collections'], remove: [] } } },
    });
    const plain2 = await login('רונית גננת', '910000004');
    ok((claims(plain2).role_tab_add || []).includes('collections'),
      '5a גננת רגילה כן מקבלת את ההרשאה הרוחבית');

    einatToken = await login('עינת גננת', '910000002');
    eq(claims(einatToken).role_tab_add, ADD,
      '5b בעלת תפקיד מותאם — הרשימה שלה היא של התפקיד בלבד');
    ok(!tabAllowed(einatToken, 'collections', ['system_admin', 'admin_viewer', 'accountant']),
      '5c ולכן "גבייה" לא נפתחה לה');
  }

  /* ================================================================ *
   * 6. עריכת התפקיד
   * ================================================================ */
  head('בדיקה 6 — PATCH /api/admin/custom-roles/:id');
  {
    const r = await request({
      method: 'PATCH', path: `/api/admin/custom-roles/${roleId}`,
      token: adminToken, body: { tab_add: ['clicktac', 'clicktac_write'] },
    });
    ok(r.status === 200, '6a התפקיד נערך', `${r.status} ${r.text}`);
    eq(r.body?.role?.tab_add, ['clicktac', 'clicktac_write'], '6b "עובדים" ירד מהתפקיד');

    einatToken = await login('עינת גננת', '910000002');
    eq(claims(einatToken).role_tab_add, ['clicktac', 'clicktac_write'],
      '6c ה-JWT אחרי התחברות מחדש כבר לא נושא אותו');
    michalToken = await login('מיכל גננת', '910000003');
    eq(claims(michalToken).role_tab_add, ['clicktac', 'clicktac_write'],
      '6d והשינוי חל על כל בעלות התפקיד');
  }

  /* ================================================================ *
   * 7. הרשאה פר-משתמש עדיין גוברת על התפקיד
   * ================================================================ */
  head('בדיקה 7 — override פר-משתמש מעל התפקיד המותאם');
  {
    const r = await request({
      method: 'PATCH', path: `/api/admin/users/${michal._id}/tabs`,
      token: adminToken, body: { add: ['payroll'], remove: ['clicktac'] },
    });
    ok(r.status === 200, '7a ה-override נשמר', `${r.status} ${r.text}`);

    michalToken = await login('מיכל גננת', '910000003');
    const c = claims(michalToken);
    eq(c.role_tab_add, ['clicktac', 'clicktac_write'], '7b שכבת התפקיד לא זזה');
    ok(!tabAllowed(michalToken, 'clicktac', CLICKTAC_ROLES),
      '7c הסרה פר-משתמש גוברת על הענקת התפקיד');
    ok(tabAllowed(michalToken, 'payroll', ['system_admin', 'admin_viewer', 'accountant']),
      '7d הענקה פר-משתמש עדיין עובדת מעל התפקיד');
    // ...ועל עינת, שאין לה override, שום דבר לא השתנה.
    ok(tabAllowed(einatToken, 'clicktac', CLICKTAC_ROLES), '7e עינת לא הושפעה');
  }

  /* ================================================================ *
   * 8. שם כפול
   * ================================================================ */
  head('בדיקה 8 — שם תפוס');
  {
    const r = await request({
      method: 'POST', path: `/api/admin/custom-roles/from-user/${michal._id}`,
      token: adminToken, body: { name: 'גננת עם רישום חיצוני' },
    });
    eq(r.status, 409, '8a שם קיים מוחזר כ-409');
    const n = await require('../src/models').CustomRole.countDocuments({});
    eq(n, 1, '8b ולא נוצר תפקיד שני');
  }

  /* ================================================================ *
   * 9. הקמת תפקיד ממי שכבר מחזיקה תפקיד מותאם
   * ================================================================ */
  let role2Id = null;
  head('בדיקה 9 — from-user על מי שכבר יש לה תפקיד מותאם');
  {
    await request({
      method: 'PATCH', path: `/api/admin/users/${einat._id}/tabs`,
      token: adminToken, body: { add: ['gantt'], remove: [] },
    });
    const r = await request({
      method: 'POST', path: `/api/admin/custom-roles/from-user/${einat._id}`,
      token: adminToken, body: { name: 'גננת עם רישום חיצוני וגאנט' },
    });
    ok(r.status === 200, '9a התפקיד השני הוקם', `${r.status} ${r.text}`);
    role2Id = r.body?.role?._id;
    eq(r.body?.role?.base_role, 'teacher', '9b הבסיס נלקח מהתפקיד שהיא כבר מחזיקה');
    eq(r.body?.role?.tab_add, ['clicktac', 'clicktac_write', 'gantt'],
      '9c הרשימה חושבה מרשימות התפקיד ועוד ה-override שלה');
    eq(r.body?.role?.tab_remove, REMOVE, '9d וההסרה של התפקיד נשמרה');
    eq(r.body?.user?.custom_role_id, String(role2Id), '9e עינת עברה לתפקיד החדש');

    einatToken = await login('עינת גננת', '910000002');
    eq(claims(einatToken).role_tab_add, ['clicktac', 'clicktac_write', 'gantt'],
      '9f וה-JWT שלה נושא אותו');
  }

  /* ================================================================ *
   * 10. מחיקת תפקיד
   * ================================================================ */
  head('בדיקה 10 — DELETE /api/admin/custom-roles/:id');
  {
    const r = await request({
      method: 'DELETE', path: `/api/admin/custom-roles/${roleId}`, token: adminToken,
    });
    ok(r.status === 200, '10a התפקיד נמחק', `${r.status} ${r.text}`);
    eq(r.body?.reverted, 1, '10b בעלת התפקיד היחידה הוחזרה');

    const m = await User.findById(michal._id).lean();
    eq(m.custom_role_id, null, '10c custom_role_id התאפס');
    eq(m.role, 'teacher', '10d והתפקיד נשאר תפקיד הבסיס');

    michalToken = await login('מיכל גננת', '910000003');
    const c = claims(michalToken);
    ok((c.role_tab_add || []).includes('collections'),
      '10e ה-JWT חזר לסמנטיקה של הרשאות התפקיד הרוחביות');
    eq(c.custom_role_name, null, '10f ואין יותר שם תפקיד מותאם');
    ok(!tabAllowed(michalToken, 'clicktac', CLICKTAC_ROLES),
      '10g ההרשאה שהגיעה מהתפקיד נעלמה');

    // התפקיד השני עדיין חי, ועינת עדיין מחזיקה בו.
    einatToken = await login('עינת גננת', '910000002');
    eq(claims(einatToken).custom_role_name, 'גננת עם רישום חיצוני וגאנט',
      '10h מחיקת תפקיד אחד לא נגעה בשני');

    const del2 = await request({
      method: 'DELETE', path: `/api/admin/custom-roles/${role2Id}`, token: adminToken,
    });
    eq(del2.body?.reverted, 1, '10i גם השני נמחק והחזיר את בעלת התפקיד');
    const list = await request({ path: '/api/admin/custom-roles', token: adminToken });
    eq(list.body?.roles, [], '10j לא נשארו תפקידים מותאמים');
  }

  /* ================================================================ *
   * 11. מעבר לתפקיד מובנה מנתק את התפקיד המותאם
   * ================================================================ */
  head('בדיקה 11 — role לבד מנתק תפקיד מותאם שאינו על אותו בסיס');
  {
    const created = await request({
      method: 'POST', path: `/api/admin/custom-roles/from-user/${einat._id}`,
      token: adminToken, body: { name: 'תפקיד זמני' },
    });
    const tmpId = created.body?.role?._id;
    ok(!!tmpId, '11a הוקם תפקיד לבדיקה');

    const same = await request({
      method: 'PATCH', path: `/api/admin/users/${einat._id}/role`,
      token: adminToken, body: { role: 'teacher' },
    });
    eq(same.body?.user?.custom_role_id, String(tmpId),
      '11b מעבר לתפקיד שהוא הבסיס עצמו — התפקיד המותאם נשמר');

    const moved = await request({
      method: 'PATCH', path: `/api/admin/users/${einat._id}/role`,
      token: adminToken, body: { role: 'branch_manager' },
    });
    eq(moved.body?.user?.role, 'branch_manager', '11c התפקיד המובנה הוחלף');
    eq(moved.body?.user?.custom_role_id, null, '11d והתפקיד המותאם נותק');

    await request({ method: 'DELETE', path: `/api/admin/custom-roles/${tmpId}`, token: adminToken });
    await User.updateOne({ _id: einat._id }, { $set: { role: 'teacher' } });
  }

  /* ================================================================ *
   * 12. שדות ורשימות
   * ================================================================ */
  head('בדיקה 12 — /api/admin/users נושא את התפקיד המותאם');
  {
    const created = await request({
      method: 'POST', path: `/api/admin/custom-roles/from-user/${michal._id}`,
      token: adminToken, body: { name: 'תפקיד לרשימה' },
    });
    const id = created.body?.role?._id;
    const users = await request({ path: '/api/admin/users', token: adminToken });
    const row = (users.body?.users || []).find(u => String(u._id) === String(michal._id));
    eq(row?.custom_role_id, String(id), '12a custom_role_id מופיע כמחרוזת');
    eq(row?.custom_role_name, 'תפקיד לרשימה', '12b וגם שם התפקיד');
    eq(row?.custom_role_base_role, 'teacher', '12c וגם תפקיד הבסיס שלו');

    const bad = await request({
      method: 'PATCH', path: `/api/admin/users/${michal._id}/role`,
      token: adminToken, body: { custom_role_id: '000000000000000000000000' },
    });
    eq(bad.status, 404, '12d תפקיד מותאם שאינו קיים מוחזר כ-404');
  }

  /* ================================================================ */
  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} בדיקות עברו`);
}

main()
  .catch((err) => { console.error('\n💥', err); failures++; })
  .finally(async () => {
    try { if (server) await new Promise(r => server.close(r)); } catch { /* ignore */ }
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    try { if (mongod) await mongod.stop(); } catch { /* ignore */ }
    process.exit(failures === 0 ? 0 : 1);
  });
