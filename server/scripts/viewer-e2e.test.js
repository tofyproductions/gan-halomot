#!/usr/bin/env node
/**
 * The admin_viewer role, end to end, against the REAL server.
 *
 * The unit tests (viewer-gate, viewer-scope, proposed-*) each prove one piece
 * with the rest faked. This one proves the pieces are wired together: a real
 * express app on a real port, real routes, real controllers, real mongoose —
 * and a viewer logging in with a password and getting 202s, proposals and
 * replayed writes exactly as the design document describes.
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL. mongodb-memory-server starts a real
 * mongod in a temp directory; nothing here can reach the production cluster:
 *   - MONGODB_URI is set BEFORE src/index.js is required (same as
 *     scripts/demo-server.js),
 *   - dotenv is stubbed out of require.cache first, so server/.env — which on
 *     this machine points at production — is never read at all,
 *   - and the connection host is asserted to be loopback before a single
 *     document is written.
 *
 * HISTORY. Six of these sub-checks were red when the test was first written:
 * they asserted what
 * docs/superpowers/specs/2026-09-07-admin-viewer-role-design.md promises and
 * the server did something else. Both gaps are now closed (see CLOSED GAPS at
 * the bottom of this file) and all 90 pass. If one of them goes red again, the
 * server has regressed — do not relax the assertion to make the suite green.
 *
 *   node scripts/viewer-e2e.test.js
 */
const net = require('net');
const http = require('http');

/* ------------------------------------------------------------------ *
 * 1. Nothing may read server/.env. Stub dotenv before anything loads it.
 * ------------------------------------------------------------------ */
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
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`);
  }
  return !!cond;
}

function eq(actual, expected, label) {
  return ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `קיבלנו ${JSON.stringify(actual)}, ציפינו ${JSON.stringify(expected)}`,
  );
}

function head(title) {
  console.log(`\n${title}`);
}

/** A free TCP port, so a dev server already on 3001 does not collide. */
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

/**
 * One request to the server under test. `path` goes on the wire verbatim —
 * no normalisation — which is the whole point of check 7.
 */
function request({ method = 'GET', path, token, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    let payload = null;
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) {
        payload = body;
      } else {
        payload = Buffer.from(JSON.stringify(body));
        h['Content-Type'] = h['Content-Type'] || 'application/json';
      }
      h['Content-Length'] = payload.length;
    }
    if (token) h.Authorization = `Bearer ${token}`;
    const req = http.request({
      host: '127.0.0.1', port: PORT, path, method, headers: h,
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

/** YYYY-MM-DD, `day` of last month — safely in the past, inside one month. */
function pastDate(day) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

/* ------------------------------------------------------------------ */

let mongod = null;
let server = null;

async function main() {
  console.log('=== admin_viewer — בדיקת קצה-אל-קצה מול השרת האמיתי ===');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_viewer_e2e' } });
  const uri = mongod.getUri();
  PORT = await freePort();

  process.env.MONGODB_URI = uri;
  process.env.JWT_SECRET = 'viewer-e2e-secret';
  process.env.PARENT_SECRET = 'viewer-e2e-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  // src/index.js re-executes itself in a child process when global.gc is
  // missing. A child would take our teardown handle with it, so tell it the
  // re-exec already happened.
  process.env.GC_REEXEC = '1';
  delete process.env.PLATFORM_MONGODB_URI;   // single-customer mode, always

  // app.listen() lives inside src/index.js and its server is not exported.
  // Borrow it on the way past so teardown can close it.
  const express = require('express');
  const originalListen = express.application.listen;
  express.application.listen = function patched(...args) {
    server = originalListen.apply(this, args);
    return server;
  };

  require('../src/index.js');
  await waitForServer();
  express.application.listen = originalListen;

  // Belt and braces: prove we are not talking to Atlas before writing a row.
  const host = String(mongoose.connection.host || '');
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
    throw new Error(`מסד הנתונים אינו מקומי (${host}) — עוצרים`);
  }
  console.log(`\nשרת עלה על :${PORT}, מסד נתונים בזיכרון (${host})`);

  /* ---------------------------------------------------------------- *
   * Seed
   * ---------------------------------------------------------------- */
  const {
    User, Branch, Employee, ProposedChange, Punch, Setting, Supplier, SalaryAdjustment,
    Registration, Document, EmploymentContract,
  } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const branchA = await Branch.create({ name: 'תל אביב', address: 'הרצל 1' });
  const branchB = await Branch.create({ name: 'כפר סבא', address: 'ויצמן 2' });

  const mkUser = (o) => User.create({
    password_hash: passwordHash, password_set: true, is_active: true, ...o,
  });

  const admin = await mkUser({
    email: 'admin@e2e.local', full_name: 'אורי מנהל', id_number: '900000001',
    role: 'system_admin', branch_id: branchA._id, position: 'מנהל מערכת',
  });
  const acc = await mkUser({
    email: 'acc@e2e.local', full_name: 'חנה חשבת', id_number: '900000002',
    role: 'accountant', branch_id: branchA._id, position: 'הנהלת חשבונות',
  });
  const viewer = await mkUser({
    email: 'viewer@e2e.local', full_name: 'אלעד צופה', id_number: '900000003',
    role: 'admin_viewer', branch_id: branchA._id, managed_branch_ids: [branchA._id],
    position: 'מנהל מערכת - לצפייה בלבד',
  });
  const viewer0 = await mkUser({
    email: 'viewer0@e2e.local', full_name: 'ורד צופה', id_number: '900000004',
    role: 'admin_viewer', branch_id: branchA._id, managed_branch_ids: [],
    position: 'מנהל מערכת - לצפייה בלבד',
  });
  const manager = await mkUser({
    email: 'manager@e2e.local', full_name: 'רותי מנהלת', id_number: '900000005',
    role: 'branch_manager', branch_id: branchA._id, managed_branch_ids: [branchA._id],
    position: 'מנהלת סניף',
  });
  const teacher = await mkUser({
    email: 'teacher@e2e.local', full_name: 'מיכל גננת', id_number: '900000006',
    role: 'teacher', branch_id: branchB._id, position: 'גננת',
  });

  const mkEmp = (name, id, branch) => Employee.create({
    full_name: name, israeli_id: id, phone: `050-${id.slice(-7)}`,
    email: `${id}@e2e.local`, position: 'גננת', branch_id: branch._id,
    salary_type: 'hourly', hourly_rate: 50, is_active: true,
    start_date: new Date('2024-09-01'),
  });
  const empA1 = await mkEmp('דנה תל אביב', '310000001', branchA);
  const empA2 = await mkEmp('יעל תל אביב', '310000002', branchA);
  const empB1 = await mkEmp('נועה כפר סבא', '310000003', branchB);
  const empB2 = await mkEmp('שירה כפר סבא', '310000004', branchB);

  // Fixed-hours employees, one per branch. Without them the materializers that
  // GET /api/payroll-month runs would have nothing to write and check 9 would
  // pass on an empty pass, proving nothing. Every weekday is covered so the
  // fill produces punches whatever day of the month the suite runs on.
  const everyDay = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, in: '08:00', out: '16:00' }));
  const mkFixedEmp = async (name, id, branch) => {
    const e = await mkEmp(name, id, branch);
    await Employee.updateOne({ _id: e._id }, { $set: { fixed_schedule: { enabled: true, days: everyDay, exceptions: [], start_date: null, note: '' } } });
    return e;
  };
  const empFixedA = await mkFixedEmp('קבועה תל אביב', '310000005', branchA);
  const empFixedB = await mkFixedEmp('קבועה כפר סבא', '310000006', branchB);

  // A genuine multi-branch worker: her card lives in כפר סבא, and she is also
  // paid at תל אביב. The manager of תל אביב may sign her in — for תל אביב.
  const empMulti = await mkEmp('רונית שני סניפים', '310000007', branchB);
  await Employee.updateOne(
    { _id: empMulti._id },
    { $set: { branch_rates: [{ branch_id: branchA._id, hourly_rate: 55 }] } },
  );

  const tokens = {
    admin: await login('אורי מנהל', '900000001'),
    acc: await login('חנה חשבת', '900000002'),
    viewer: await login('אלעד צופה', '900000003'),
    viewer0: await login('ורד צופה', '900000004'),
    manager: await login('רותי מנהלת', '900000005'),
    teacher: await login('מיכל גננת', '900000006'),
  };
  console.log('נזרעו 2 סניפים, 6 משתמשים, 7 עובדים (2 בשעות קבועות, 1 דו-סניפית); כל המשתמשים התחברו בסיסמה');

  const month = thisMonth();
  const punchesByNote = (note) => Punch.find({ manual_note: note }).lean();

  /* ================================================================ *
   * 1. קריאות של הצופה
   * ================================================================ */
  head('בדיקה 1 — הצופה קורא');
  {
    const r = await request({ path: '/api/employees?branch=all', token: tokens.viewer });
    eq(r.status, 200, '1a GET /api/employees מחזיר 200');
    const names = (r.body?.employees || []).map(e => e.full_name);
    ok(names.includes('רותי מנהלת') && names.includes('מיכל גננת'),
      '1a GET /api/employees מחזיר משתמשים משני הסניפים',
      `קיבלנו ${JSON.stringify(names)}`);

    // The Employee-model list, which is what the "עובדים" screen reads.
    const rp = await request({ path: '/api/payroll/employees?branch=all', token: tokens.viewer });
    eq(rp.status, 200, '1b GET /api/payroll/employees מחזיר 200');
    const empNames = (rp.body?.employees || []).map(e => e.full_name);
    ok(empNames.includes('דנה תל אביב') && empNames.includes('נועה כפר סבא'),
      '1b GET /api/payroll/employees מחזיר עובדים משני הסניפים',
      `קיבלנו ${JSON.stringify(empNames)}`);

    const ra = await request({ path: '/api/admin/users', token: tokens.viewer });
    eq(ra.status, 403, '1c GET /api/admin/users נחסם ב-403');

    const rm = await request({ path: `/api/payroll-month?month=${month}&branch=all`, token: tokens.viewer });
    eq(rm.status, 200, '1d GET /api/payroll-month מחזיר 200');
    const branchesInView = (rm.body?.branches || []).map(b => b.name);
    ok(branchesInView.includes('תל אביב') && branchesInView.includes('כפר סבא'),
      '1d טבלת השכר של הצופה כוללת את שני הסניפים',
      `קיבלנו ${JSON.stringify(branchesInView)}`);

    // GET /api/branches: a viewer must see every branch, including one
    // (viewer0) with no managed branches at all — she is still a viewer, not
    // a manager with nothing assigned. A branch_manager stays scoped to her
    // own branch, unchanged.
    const rb = await request({ path: '/api/branches', token: tokens.viewer });
    eq(rb.status, 200, '1e GET /api/branches מחזיר 200 לצופה');
    const branchNames = (rb.body?.branches || []).map(b => b.name);
    ok(branchNames.includes('תל אביב') && branchNames.includes('כפר סבא'),
      '1e הצופה רואה את שני הסניפים',
      `קיבלנו ${JSON.stringify(branchNames)}`);

    const rb0 = await request({ path: '/api/branches', token: tokens.viewer0 });
    eq(rb0.status, 200, '1f GET /api/branches מחזיר 200 לצופה ללא סניפים בניהול');
    const branchNames0 = (rb0.body?.branches || []).map(b => b.name);
    ok(branchNames0.includes('תל אביב') && branchNames0.includes('כפר סבא'),
      '1f גם צופה ללא סניפים בניהול רואה את שני הסניפים',
      `קיבלנו ${JSON.stringify(branchNames0)}`);

    const rbm = await request({ path: '/api/branches', token: tokens.manager });
    eq(rbm.status, 200, '1g GET /api/branches מחזיר 200 למנהלת סניף');
    const branchNamesM = (rbm.body?.branches || []).map(b => b.name);
    eq(branchNamesM, ['תל אביב'],
      '1g מנהלת סניף רואה רק את הסניף שבניהולה (התנהגות קיימת, ללא שינוי)');
  }

  /* ================================================================ *
   * 2. בקשת שינוי שכר לסניף שאינו בניהול הצופה
   * ================================================================ */
  head('בדיקה 2 — בקשת שינוי בטבלת השכר');
  let changeRequestId = null;
  {
    const payload = {
      month,
      note: 'בדיקת קצה',
      changes: [{
        employee_id: String(empB1._id), field: 'notes', field_label: 'הערות',
        current_value: '', requested_value: 'הערת בדיקה',
      }],
    };
    const r = await request({
      method: 'POST', path: '/api/payroll-month/change-requests',
      token: tokens.viewer, body: payload,
    });
    eq(r.status, 201, '2a הצופה מגיש בקשת שינוי לעובדת בסניף שאינו בניהולה → 201');
    changeRequestId = r.body?.request?._id ? String(r.body.request._id) : null;
    eq(String(r.body?.request?.changes?.[0]?.branch_id || ''), String(branchB._id),
      '2a שורת הבקשה נושאת את סניף העובדת (כפר סבא)');

    const list = await request({
      path: '/api/payroll-month/change-requests?status=pending', token: tokens.acc,
    });
    eq(list.status, 200, '2b הנה"ח רואה את רשימת הבקשות הממתינות');
    const found = (list.body?.requests || []).find(x => String(x._id) === changeRequestId);
    ok(!!found, '2b הבקשה של הצופה מופיעה אצל הנה"ח');
    ok((list.body?.pending_count || 0) >= 1, '2b pending_count לפחות 1',
      `קיבלנו ${list.body?.pending_count}`);

    const mgr = await request({
      method: 'POST', path: '/api/payroll-month/change-requests',
      token: tokens.manager, body: payload,
    });
    eq(mgr.status, 403, '2c מנהלת סניף א׳ מבקשת שינוי לעובדת סניף ב׳ → 403 (ללא שינוי)');
  }

  /* ================================================================ *
   * 3. החתמות ידניות
   * ================================================================ */
  head('בדיקה 3 — החתמה ידנית');
  let punchProposalId = null;
  {
    const noteA = 'E2E-viewer-A';
    const rA = await request({
      method: 'POST', path: '/api/payroll/manual-punches', token: tokens.viewer,
      body: { employee_id: String(empA1._id), date: pastDate(5), in_time: '08:00', out_time: '16:00', note: noteA },
    });
    eq(rA.status, 200, '3a הצופה מחתימה בסניף שבניהולה → 200');
    const madeA = await punchesByNote(noteA);
    eq(madeA.length, 2, '3a נוצרו שתי החתמות (כניסה + יציאה)');
    eq([...new Set(madeA.map(p => p.approval_status))], ['pending_accountant'],
      '3a ההחתמה במצב pending_accountant (שרשרת מנהלת סניף)');

    // Per the design document a viewer WITH managed branches who acts on
    // another branch should be refused by the controller's scope check and
    // that 403 turned into a proposal.
    const noteB = 'E2E-viewer-B';
    const rB = await request({
      method: 'POST', path: '/api/payroll/manual-punches', token: tokens.viewer,
      body: { employee_id: String(empB1._id), date: pastDate(6), in_time: '08:00', out_time: '16:00', note: noteB },
    });
    const madeB = await punchesByNote(noteB);
    eq(rB.status, 202, '3b הצופה מחתימה בסניף שאינו בניהולה → 202 (נשמר לאישור)');
    eq(rB.body?.proposed, true, '3b התשובה מסמנת proposed: true');
    eq(madeB.length, 0, '3b לא נוצרה החתמה לפני אישור');

    // A viewer with NO managed branches always takes the propose() path, so
    // this is the one that reliably produces the proposal checks 4 needs.
    const noteC = 'E2E-viewer0-B';
    const rC = await request({
      method: 'POST', path: '/api/payroll/manual-punches', token: tokens.viewer0,
      body: { employee_id: String(empB1._id), date: pastDate(7), in_time: '09:00', out_time: '17:00', note: noteC },
    });
    eq(rC.status, 202, '3c צופה ללא סניפים בניהול מחתימה → 202');
    eq(rC.body?.proposed, true, '3c התשובה מסמנת proposed: true');
    ok(!!rC.body?.id, '3c התשובה מחזירה מזהה הצעה');
    eq(rC.body?.approver, 'accountant', '3c הגורם המאשר הוא הנה"ח');
    ok(typeof rC.body?.message === 'string' && rC.body.message.includes('ממתין לאישור'),
      '3c ההודעה למשתמשת מסבירה שהשינוי ממתין לאישור', rC.body?.message);
    punchProposalId = rC.body?.id || null;

    const prop = punchProposalId ? await ProposedChange.findById(punchProposalId).lean() : null;
    ok(!!prop, '3c נוצרה רשומת ProposedChange');
    eq(prop?.approver, 'accountant', '3c ההצעה מנותבת להנה"ח');
    eq(prop?.screen_label, 'שכר', '3c תווית המסך היא "שכר"');
    eq(prop?.status, 'pending', '3c ההצעה ממתינה');
    eq(prop?.method, 'POST', '3c נשמרה השיטה');
    eq(prop?.path, '/api/payroll/manual-punches', '3c נשמר הנתיב');
    eq((await punchesByNote(noteC)).length, 0, '3c לא נוצרה החתמה לפני אישור');
  }

  /* ================================================================ *
   * 4. החלטה על ההצעה
   * ================================================================ */
  head('בדיקה 4 — אישור ודחייה של הצעות');
  {
    const r = await request({
      method: 'POST', path: `/api/proposed-changes/${punchProposalId}/decide`,
      token: tokens.admin, body: { decision: 'approve', note: 'מאושר' },
    });
    eq(r.status, 200, '4a מנהל המערכת מאשר → 200');
    eq(r.body?.proposal?.status, 'approved', '4a ההצעה עברה ל-approved');
    const applyStatus = r.body?.proposal?.apply_status;
    ok(applyStatus >= 200 && applyStatus < 300, '4a ההפעלה החוזרת החזירה 2xx',
      `apply_status=${applyStatus} apply_error=${r.body?.proposal?.apply_error}`);

    const madeC = await punchesByNote('E2E-viewer0-B');
    eq(madeC.length, 2, '4a לאחר האישור נוצרו ההחתמות לעובדת סניף ב׳');
    eq([...new Set(madeC.map(p => p.approval_status))], ['approved'],
      '4a ההחתמות במצב approved (ההפעלה רצה בשם מנהל המערכת)');

    // A second proposal, rejected.
    const noteD = 'E2E-viewer0-B2';
    const rc = await request({
      method: 'POST', path: '/api/payroll/manual-punches', token: tokens.viewer0,
      body: { employee_id: String(empB2._id), date: pastDate(8), in_time: '08:30', out_time: '15:30', note: noteD },
    });
    eq(rc.status, 202, '4b הצעה שנייה נשמרה (202)');
    const rejectId = rc.body?.id;
    const rj = await request({
      method: 'POST', path: `/api/proposed-changes/${rejectId}/decide`,
      token: tokens.admin, body: { decision: 'reject', note: 'לא מאושר' },
    });
    eq(rj.status, 200, '4b הדחייה החזירה 200');
    eq(rj.body?.proposal?.status, 'rejected', '4b ההצעה עברה ל-rejected');
    eq((await punchesByNote(noteD)).length, 0, '4b לא נוצר דבר לאחר דחייה');

    const dec = await request({ path: '/api/my-decisions', token: tokens.viewer0 });
    eq(dec.status, 200, '4c GET /api/my-decisions מחזיר 200');
    const proposed = (dec.body?.items || []).filter(i => i.kind === 'proposed');
    eq(proposed.length, 2, '4c שתי ההחלטות מופיעות תחת kind: proposed');
    const statuses = proposed.map(i => i.status).sort();
    eq(statuses, ['approved', 'rejected'], '4c אחת אושרה ואחת נדחתה');
  }

  /* ================================================================ *
   * 5. הגדרות הריון — מסלול הצעה מלא
   * ================================================================ */
  head('בדיקה 5 — שמירת הגדרות (הריון)');
  {
    const before = await request({ path: '/api/payroll-month/pregnancy-settings', token: tokens.admin });
    eq(before.body?.proration_mode, 'linear', '5a המצב ההתחלתי הוא linear');

    const r = await request({
      method: 'PUT', path: '/api/payroll-month/pregnancy-settings', token: tokens.viewer,
      body: { proration_mode: 'statutory', full_time_weekly_hours: 40 },
    });
    eq(r.status, 202, '5a הצופה שומרת הגדרות → 202');
    eq(r.body?.approver, 'accountant', '5a ההצעה מנותבת להנה"ח');
    const propId = r.body?.id;
    const prop = await ProposedChange.findById(propId).lean();
    eq(prop?.approver, 'accountant', '5a ProposedChange.approver = accountant');

    const mid = await request({ path: '/api/payroll-month/pregnancy-settings', token: tokens.admin });
    eq(mid.body?.proration_mode, 'linear', '5b ההגדרה לא השתנתה לפני אישור');

    const dec = await request({
      method: 'POST', path: `/api/proposed-changes/${propId}/decide`,
      token: tokens.acc, body: { decision: 'approve' },
    });
    eq(dec.status, 200, '5c הנה"ח מאשרת → 200');
    eq(dec.body?.proposal?.status, 'approved', '5c ההצעה אושרה');

    const after = await request({ path: '/api/payroll-month/pregnancy-settings', token: tokens.admin });
    eq(after.body?.proration_mode, 'statutory', '5c ההגדרה השתנתה לאחר האישור');
    eq(after.body?.full_time_weekly_hours, 40, '5c גם שעות המשרה המלאה עודכנו');
  }

  /* ================================================================ *
   * 6. סירובים: העלאת קובץ והכרעה בהצעות
   * ================================================================ */
  head('בדיקה 6 — סירובים');
  {
    const boundary = `----ganE2E${Date.now()}`;
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await request({
      method: 'POST', path: '/api/photos/upload', token: tokens.viewer0,
      body: multipart, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    });
    eq(up.status, 403, '6a העלאת קובץ ע"י צופה ללא סניפים בניהול → 403');
    eq(up.body?.code, 'VIEWER_NO_UPLOAD', '6a קוד השגיאה הוא VIEWER_NO_UPLOAD');

    const countBefore = await ProposedChange.countDocuments({});
    const dec = await request({
      method: 'POST', path: `/api/proposed-changes/${punchProposalId}/decide`,
      token: tokens.viewer, body: { decision: 'approve' },
    });
    eq(dec.status, 403, '6b צופה מנסה להכריע הצעה → 403');
    eq(await ProposedChange.countDocuments({}), countBefore,
      '6b לא נוצרה הצעה חדשה מן הניסיון');
  }

  /* ================================================================ *
   * 7. מעקף נתיב
   * ================================================================ */
  head('בדיקה 7 — מעקף נתיב אל /api/admin');
  {
    const countBefore = await ProposedChange.countDocuments({});
    const r = await request({
      method: 'PATCH',
      path: `/api/cibus-sync/%2e%2e/admin/users/${admin._id}/role`,
      token: tokens.viewer, body: { role: 'teacher' },
    });
    eq(r.status, 403, '7a הנתיב המעוקף נחסם ב-403');
    eq(await ProposedChange.countDocuments({}), countBefore, '7b לא נוצרה הצעה');
    const stillAdmin = await User.findById(admin._id).select('role').lean();
    eq(stillAdmin.role, 'system_admin', '7c תפקיד מנהל המערכת לא השתנה');
  }

  /* ================================================================ *
   * 8. שאר התפקידים ללא שינוי
   * ================================================================ */
  head('בדיקה 8 — התפקידים הקיימים ללא שינוי');
  {
    const a = await request({
      method: 'PUT', path: '/api/payroll-month/pregnancy-settings', token: tokens.admin,
      body: { full_time_weekly_hours: 41 },
    });
    eq(a.status, 200, '8a מנהל מערכת שומר הגדרות ישירות → 200');
    const after = await request({ path: '/api/payroll-month/pregnancy-settings', token: tokens.admin });
    eq(after.body?.full_time_weekly_hours, 41, '8a ההגדרה נשמרה מיד');

    const d = await request({
      method: 'POST', path: `/api/payroll-month/change-requests/${changeRequestId}/decide`,
      token: tokens.acc, body: { decisions: ['approved'], decision_note: 'אושר' },
    });
    eq(d.status, 200, '8b הנה"ח מכריעה בקשת שינוי שכר → 200');

    const noteM = 'E2E-manager-A';
    const m = await request({
      method: 'POST', path: '/api/payroll/manual-punches', token: tokens.manager,
      body: { employee_id: String(empA2._id), date: pastDate(9), in_time: '08:00', out_time: '16:00', note: noteM },
    });
    eq(m.status, 200, '8c מנהלת סניף מחתימה בסניף שלה → 200');
    const madeM = await punchesByNote(noteM);
    eq([...new Set(madeM.map(p => p.approval_status))], ['pending_accountant'],
      '8c ההחתמה של מנהלת הסניף במצב pending_accountant');

    const t = await request({ path: '/api/employees?branch=all', token: tokens.teacher });
    ok(t.status < 500, '8d גננת קוראת /api/employees ללא שגיאת שרת', `status=${t.status}`);
    const tNames = (t.body?.employees || []).map(e => e.full_name);
    ok(t.status === 403 || !(tNames.includes('רותי מנהלת') && tNames.includes('מיכל גננת')),
      '8d הגננת אינה מקבלת את כל הסניפים', `status=${t.status} ${JSON.stringify(tNames)}`);

    const tc = await request({
      method: 'POST', path: '/api/payroll-month/change-requests', token: tokens.teacher,
      body: {
        month,
        changes: [{ employee_id: String(empB1._id), field: 'notes', current_value: '', requested_value: 'x' }],
      },
    });
    eq(tc.status, 403, '8e גננת מגישה בקשת שינוי שכר → 403');
    eq(tc.body?.code, 'NO_BRANCH_SCOPE', '8e קוד השגיאה הוא NO_BRANCH_SCOPE');
  }

  /* ================================================================ *
   * 9. קריאה של הצופה אינה כותבת החתמות (תופעת לוואי של GET)
   * ================================================================ */
  head('בדיקה 9 — קריאה של הצופה אינה כותבת החתמות מחוץ לסניפיה');
  {
    // GET /api/payroll-month runs the fixed-schedule and closure-completion
    // fillers, and those INSERT approved punches stamped with the caller. The
    // viewer reads every branch, so without a narrowing her page load would
    // file punches into every branch, in her name.
    //
    // כפר סבא is still untouched here: the only all-branch payroll read so far
    // was check 1d's, by a viewer who manages תל אביב alone.
    eq(await Punch.countDocuments({ employee_id: empFixedB._id }), 0,
      '9a אין עדיין החתמות שעות-קבועות בסניף שאינו בניהול הצופה');

    const r = await request({ path: `/api/payroll-month?month=${month}&branch=all`, token: tokens.viewer0 });
    eq(r.status, 200, '9b צופה ללא סניפים בניהול קוראת את טבלת השכר → 200');
    const rowNames = (r.body?.rows || []).map(x => x.full_name);
    ok(rowNames.includes('דנה תל אביב') && rowNames.includes('נועה כפר סבא'),
      '9b הטבלה שלה עדיין כוללת עובדות משני הסניפים',
      `קיבלנו ${JSON.stringify(rowNames)}`);
    eq(await Punch.countDocuments({ created_by: viewer0._id }), 0,
      '9c הקריאה לא יצרה ולו החתמה אחת בשמה');
    eq(await Punch.countDocuments({ employee_id: empFixedB._id }), 0,
      '9c וגם לא נכתבה החתמה בסניף שאינו בניהולה');

    // The viewer WITH a managed branch did materialize — inside her branch only.
    const mine = await Punch.find({ created_by: viewer._id, timestamp_source: 'fixed_schedule' }).lean();
    ok(mine.length > 0, '9d הקריאה של הצופה שמנהלת סניף אכן מילאה שעות קבועות',
      `קיבלנו ${mine.length}`);
    eq([...new Set(mine.map(p => String(p.branch_id)))], [String(branchA._id)],
      '9d כל ההחתמות שנוצרו בשמה שייכות לסניף שבניהולה');

    // ...and the fill genuinely works, so 9a/9c are not an empty pass.
    const ra = await request({ path: `/api/payroll-month?month=${month}&branch=all`, token: tokens.admin });
    eq(ra.status, 200, '9e מנהל המערכת קורא את אותה טבלה → 200');
    ok(await Punch.countDocuments({ employee_id: empFixedB._id }) > 0,
      '9e אצלו המילוי כן רץ — כלומר הבדיקה אינה ריקה');
  }

  /* ================================================================ *
   * 10. החתמה ידנית — גם העובד/ת חייב/ת להיות בסניף שבניהול
   * ================================================================ */
  head('בדיקה 10 — ההחתמה נבדקת גם מול הסניף של העובדת');
  {
    // branch_id comes off the request body, so checking it alone let a manager
    // name ANY employee and pass by writing her own branch in the field.
    const noteX = 'E2E-manager-cross';
    const rx = await request({
      method: 'POST', path: '/api/payroll/manual-punches', token: tokens.manager,
      body: {
        employee_id: String(empB1._id), branch_id: String(branchA._id),
        date: pastDate(10), in_time: '08:00', out_time: '16:00', note: noteX,
      },
    });
    eq(rx.status, 403, '10a מנהלת תל אביב מחתימה עובדת כפר סבא עם branch_id של תל אביב → 403');
    eq((await punchesByNote(noteX)).length, 0, '10a לא נוצרה החתמה');

    const noteY = 'E2E-viewer-cross';
    const ry = await request({
      method: 'POST', path: '/api/payroll/manual-punches', token: tokens.viewer,
      body: {
        employee_id: String(empB2._id), branch_id: String(branchA._id),
        date: pastDate(11), in_time: '08:00', out_time: '16:00', note: noteY,
      },
    });
    eq(ry.status, 202, '10b אותו תרגיל אצל הצופה → 202 (נשמר לאישור)');
    eq(ry.body?.proposed, true, '10b התשובה מסמנת proposed: true');
    eq((await punchesByNote(noteY)).length, 0, '10b לא נוצרה החתמה לפני אישור');

    // The legitimate multi-branch case still works: her card is in כפר סבא,
    // she is also paid at תל אביב, and תל אביב is what the manager signs.
    const noteZ = 'E2E-manager-multi';
    const rz = await request({
      method: 'POST', path: '/api/payroll/manual-punches', token: tokens.manager,
      body: {
        employee_id: String(empMulti._id), branch_id: String(branchA._id),
        date: pastDate(12), in_time: '08:00', out_time: '16:00', note: noteZ,
      },
    });
    eq(rz.status, 200, '10c מנהלת תל אביב מחתימה עובדת דו-סניפית בתל אביב → 200');
    eq((await punchesByNote(noteZ)).length, 2, '10c נוצרו שתי החתמות');
  }

  /* ================================================================ *
   * 11. can_decide נגזר מהתפקיד האמיתי, לא מזה שהוחלף לקריאה
   * ================================================================ */
  head('בדיקה 11 — כפתור ההכרעה בבקשות העלאת שכר');
  {
    // The read swap hands this controller `role: 'system_admin'`, so a flag
    // computed off `req.user.role` alone would light up the decide button for
    // a viewer — on a queue she is forbidden to decide (the write is a
    // proposal). It must read `actual_role` first.
    const rv = await request({ path: '/api/rate-changes', token: tokens.viewer });
    eq(rv.status, 200, '11a צופה קוראת את תור העלאות השכר → 200');
    eq(rv.body?.can_decide, false, '11a can_decide=false אף שהיא קוראת כמנהלת מערכת');

    const rv0 = await request({ path: '/api/rate-changes', token: tokens.viewer0 });
    eq(rv0.body?.can_decide, false, '11b גם לצופה ללא סניפים בניהול');

    const ra = await request({ path: '/api/rate-changes', token: tokens.admin });
    eq(ra.status, 200, '11c מנהל המערכת → 200');
    eq(ra.body?.can_decide, true, '11c ואצלו can_decide=true');

    const rm = await request({ path: '/api/rate-changes', token: tokens.manager });
    eq(rm.body?.can_decide, false, '11d מנהלת סניף — מגישה, לא מכריעה');
  }

  /* ================================================================ *
   * 12. מסלולים ללא requireRole/requireTab — הצופה עדיין אינה כותבת
   * ================================================================ */
  head('בדיקה 12 — מסלולים ללא שער תפקידים');
  {
    // The C1 hole: /api/branches, /api/suppliers and 75 more staff write
    // routes carry no requireRole and no requireTab, and the viewer decision
    // used to live inside those two. So PUT /api/branches/:id answered 200,
    // the branch was renamed, and nothing was ever filed. The decision now
    // sits in authMiddleware, which every one of them passes.
    const nameBefore = (await Branch.findById(branchB._id).select('name').lean()).name;
    const r = await request({
      method: 'PUT', path: `/api/branches/${branchB._id}`, token: tokens.viewer0,
      body: { name: 'שם שהצופה ניסתה לשנות' },
    });
    eq(r.status, 202, '12a PUT /api/branches/:id (מסלול ללא שער) → 202');
    eq(r.body?.proposed, true, '12a התשובה מסמנת proposed: true');
    const renameId = r.body?.id;
    const prop = renameId ? await ProposedChange.findById(renameId).lean() : null;
    eq(prop?.method, 'PUT', '12a נשמרה ProposedChange עם השיטה');
    eq(prop?.path, `/api/branches/${branchB._id}`, '12a ועם הנתיב');
    eq(prop?.screen_label, 'סניפים', '12a תווית המסך היא "סניפים"');
    eq((await Branch.findById(branchB._id).select('name').lean()).name, nameBefore,
      '12a שם הסניף לא השתנה במסד');

    const suppliersBefore = await Supplier.countDocuments({});
    const rs = await request({
      method: 'POST', path: '/api/suppliers', token: tokens.viewer0,
      body: { name: 'ספק שהצופה ניסתה להוסיף' },
    });
    eq(rs.status, 202, '12b POST /api/suppliers → 202');
    eq(rs.body?.proposed, true, '12b התשובה מסמנת proposed: true');
    eq(await Supplier.countDocuments({}), suppliersBefore, '12b לא נוצר ספק');

    // ...and the queued rename really happens once it is approved.
    const dec = await request({
      method: 'POST', path: `/api/proposed-changes/${renameId}/decide`,
      token: tokens.admin, body: { decision: 'approve' },
    });
    eq(dec.status, 200, '12c מנהל המערכת מאשר את שינוי השם → 200');
    eq(dec.body?.proposal?.status, 'approved', '12c ההצעה אושרה');
    const applyStatus = dec.body?.proposal?.apply_status;
    ok(applyStatus >= 200 && applyStatus < 300, '12c ההפעלה החוזרת החזירה 2xx',
      `apply_status=${applyStatus} apply_error=${dec.body?.proposal?.apply_error}`);
    eq((await Branch.findById(branchB._id).select('name').lean()).name, 'שם שהצופה ניסתה לשנות',
      '12c ורק עכשיו השם השתנה במסד');
    // Put it back so nothing downstream reads a renamed branch.
    await Branch.updateOne({ _id: branchB._id }, { $set: { name: nameBefore } });
  }
  {
    // I2: a route gated only by requireBranchScope. The viewer holds branches,
    // so she continues as a branch_manager and the controller's own scope
    // check answers 403 for another branch's employee — which the wrapper
    // installed in authMiddleware turns into a proposal instead of a wall.
    const adjBefore = await SalaryAdjustment.countDocuments({});
    const r = await request({
      method: 'POST', path: '/api/payroll-month/adjustments', token: tokens.viewer,
      body: {
        employee_id: String(empB1._id), month, type: 'money_add',
        amount: 120, reason: 'E2E-viewer-adjustment',
      },
    });
    eq(r.status, 202, '12d עדכון שכר לעובדת סניף אחר (requireBranchScope בלבד) → 202');
    eq(r.body?.proposed, true, '12d התשובה מסמנת proposed: true');
    eq(await SalaryAdjustment.countDocuments({}), adjBefore, '12d לא נוצר עדכון שכר');
    const prop = await ProposedChange.findById(r.body?.id).lean();
    eq(prop?.approver, 'accountant', '12d ההצעה מנותבת להנה"ח');
    eq(prop?.screen_label, 'שכר', '12d תווית המסך היא "שכר"');

    // The same call for her OWN branch is an ordinary manager action: filed as
    // a pending adjustment, not as a proposal.
    const rown = await request({
      method: 'POST', path: '/api/payroll-month/adjustments', token: tokens.viewer,
      body: {
        employee_id: String(empA1._id), month, type: 'money_add',
        amount: 90, reason: 'E2E-viewer-adjustment-own',
      },
    });
    eq(rown.status, 200, '12e ובסניף שבניהולה — 200, כמו כל מנהלת סניף');
    eq(rown.body?.pending, true, '12e והעדכון ממתין לאישור הנה"ח');
  }

  /* ================================================================ *
   * 13. מסלולים ללא שער — גם לצופה שמנהלת סניפים
   * ================================================================ */
  head('בדיקה 13 — שומר הכתיבה במפלס מסד הנתונים');
  {
    // Check 12 covered the viewer with NO managed branches: she is answered by
    // decideViewerWrite rule 4 before the route ever runs. THIS is the hole
    // that was left — a viewer WITH managed branches continues the request as
    // a branch_manager (rule 3), and on a route carrying no requireRole, no
    // requireTab and no requireBranchScope nothing ever answers 403, so the
    // 403→202 wrapper had nothing to convert and she wrote for real.
    //
    // src/utils/viewerWriteGuard now refuses the write at the mongoose layer:
    // no gate claimed the request, so the proposal is filed and the operation
    // rejected before the driver is called.
    const nameBefore = (await Branch.findById(branchB._id).select('name').lean()).name;
    const r = await request({
      method: 'PUT', path: `/api/branches/${branchB._id}`, token: tokens.viewer,
      body: { name: 'שם ששינתה צופה עם סניפים' },
    });
    eq(r.status, 202, '13a PUT /api/branches/:id ע"י צופה עם סניפים בניהול → 202');
    eq(r.body?.proposed, true, '13a התשובה מסמנת proposed: true');
    const renameId = r.body?.id;
    const prop = renameId ? await ProposedChange.findById(renameId).lean() : null;
    eq(prop?.method, 'PUT', '13a נשמרה ProposedChange עם השיטה');
    eq(prop?.path, `/api/branches/${branchB._id}`, '13a ועם הנתיב');
    eq(prop?.requested_role, 'admin_viewer', '13a והתפקיד הרשום הוא admin_viewer, לא ה-fallback');
    eq(prop?.status, 'pending', '13a ההצעה ממתינה');
    eq((await Branch.findById(branchB._id).select('name').lean()).name, nameBefore,
      '13a שם הסניף לא השתנה במסד');

    const suppliersBefore = await Supplier.countDocuments({});
    const rs = await request({
      method: 'POST', path: '/api/suppliers', token: tokens.viewer,
      body: { name: 'ספק שצופה עם סניפים ניסתה להוסיף' },
    });
    eq(rs.status, 202, '13b POST /api/suppliers ע"י אותה צופה → 202');
    eq(rs.body?.proposed, true, '13b התשובה מסמנת proposed: true');
    eq(await Supplier.countDocuments({}), suppliersBefore, '13b לא נוצר ספק');

    // A CLAIMED write still lands. Two shapes of claim:
    //   requireRole(...'branch_manager'...) — /api/payroll/manual-punches
    //   requireBranchScope                  — /api/payroll-month/adjustments
    const note13 = 'E2E-guard-claimed-A';
    const rp = await request({
      method: 'POST', path: '/api/payroll/manual-punches', token: tokens.viewer,
      body: { employee_id: String(empA1._id), date: pastDate(13), in_time: '08:00', out_time: '16:00', note: note13 },
    });
    ok(rp.status === 200 || rp.status === 201, '13c החתמה בסניף שבניהולה (מסלול עם שער) עדיין נכתבת',
      `status=${rp.status} ${rp.text}`);
    const made13 = await punchesByNote(note13);
    eq(made13.length, 2, '13c נוצרו שתי החתמות');
    eq([...new Set(made13.map(p => p.approval_status))], ['pending_accountant'],
      '13c ובמצב pending_accountant, כמו לכל מנהלת סניף');

    const adjBefore = await SalaryAdjustment.countDocuments({});
    const radj = await request({
      method: 'POST', path: '/api/payroll-month/adjustments', token: tokens.viewer,
      body: {
        employee_id: String(empA2._id), month, type: 'money_add',
        amount: 70, reason: 'E2E-guard-claimed-adjustment',
      },
    });
    eq(radj.status, 200, '13d עדכון שכר בסניף שבניהולה (requireBranchScope) → 200');
    eq(radj.body?.pending, true, '13d והעדכון ממתין לאישור הנה"ח');
    eq(await SalaryAdjustment.countDocuments({}), adjBefore + 1, '13d ונוצר במסד');

    // ...and the queued rename really happens once the admin approves it. The
    // replay runs as the approver, with no viewer context at all, so the guard
    // must be entirely absent from it.
    const dec = await request({
      method: 'POST', path: `/api/proposed-changes/${renameId}/decide`,
      token: tokens.admin, body: { decision: 'approve' },
    });
    eq(dec.status, 200, '13e מנהל המערכת מאשר את שינוי השם → 200');
    const applyStatus = dec.body?.proposal?.apply_status;
    ok(applyStatus >= 200 && applyStatus < 300, '13e ההפעלה החוזרת החזירה 2xx',
      `apply_status=${applyStatus} apply_error=${dec.body?.proposal?.apply_error}`);
    eq((await Branch.findById(branchB._id).select('name').lean()).name, 'שם ששינתה צופה עם סניפים',
      '13e ורק עכשיו השם השתנה במסד');
    await Branch.updateOne({ _id: branchB._id }, { $set: { name: nameBefore } });

    // Check 12's viewer — the one with no managed branches — is decided before
    // the route runs and must be untouched by any of this.
    const r12 = await request({
      method: 'PUT', path: `/api/branches/${branchB._id}`, token: tokens.viewer0,
      body: { name: 'שוב ניסיון של צופה ללא סניפים' },
    });
    eq(r12.status, 202, '13f צופה ללא סניפים בניהול — עדיין 202 (התנהגות בדיקה 12)');
    eq(r12.body?.proposed, true, '13f עם proposed: true');
    eq((await Branch.findById(branchB._id).select('name').lean()).name, nameBefore,
      '13f והשם לא השתנה');

    // AN UNGATED MULTIPART ROUTE. POST /api/documents/upload carries no gate
    // either, so the fallback manager reaches multer, multer parses the file,
    // and Document.create arrives at the guard. Filing THAT as a proposal would
    // store a JSON body under content_type: multipart/… and the replay would
    // hand busboy an object — a proposal that can never be applied and a file
    // quietly lost. So the guard refuses it the same way rule 4 refuses an
    // upload from a viewer with no branches: 403 VIEWER_NO_UPLOAD, no proposal.
    const registration = await Registration.create({
      unique_id: 'E2E-REG-13H', child_name: 'ילד לבדיקה', parent_name: 'הורה לבדיקה',
      branch_id: branchB._id, monthly_fee: 1000,
      start_date: new Date('2026-09-01'), end_date: new Date('2027-08-31'),
    });
    const docsBefore = await Document.countDocuments({});
    const propsBefore = await ProposedChange.countDocuments({});
    const boundary13 = `----ganE2E13${Date.now()}`;
    const upBody = Buffer.concat([
      Buffer.from(`--${boundary13}\r\nContent-Disposition: form-data; name="registration_id"\r\n\r\n${registration._id}\r\n`),
      Buffer.from(`--${boundary13}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(`\r\n--${boundary13}--\r\n`),
    ]);
    const up13 = await request({
      method: 'POST', path: '/api/documents/upload', token: tokens.viewer,
      body: upBody, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary13}` },
    });
    eq(up13.status, 403, '13h העלאת קובץ במסלול ללא שער ע"י צופה עם סניפים → 403');
    eq(up13.body?.code, 'VIEWER_NO_UPLOAD', '13h עם הקוד VIEWER_NO_UPLOAD');
    eq(await Document.countDocuments({}), docsBefore, '13h ולא נוצר מסמך');
    eq(await ProposedChange.countDocuments({}), propsBefore,
      '13h ולא נשמרה הצעה מתה שאי אפשר להפעיל');

    // A GATED MULTIPART ROUTE, AND THE DOUBLE-AUTH TRAP UNDER IT.
    //
    // POST /api/employment-contracts/upload puts its gate BEFORE multer
    // (requireRole(..., 'branch_manager') at employmentContracts.routes.js:33),
    // so the claim is made while the context is still alive and an upload for
    // a branch she manages must LAND — this is not the ungated 13h case.
    //
    // It nearly did not. That router mounts authMiddleware AGAIN (:31) below
    // the global one, so decideViewerWrite ran twice, built a second context
    // and a second wrapper, and left req.emit bound to the FIRST — multer
    // resumed the request inside a stale, unclaimed context and the viewer's
    // own guard answered 403 VIEWER_NO_UPLOAD for her own branch. The decision
    // is now made once, and the emit binding follows the current state.
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
      + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
      + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n'
      + 'trailer<</Root 1 0 R>>\n%%EOF\n',
      'latin1',
    );
    const contractUpload = (employeeId) => {
      const b = `----ganE2E13i${Date.now()}${Math.random().toString(16).slice(2)}`;
      const payload = Buffer.concat([
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="employee_id"\r\n\r\n${employeeId}\r\n`),
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="contract.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
        pdf,
        Buffer.from(`\r\n--${b}--\r\n`),
      ]);
      return request({
        method: 'POST', path: '/api/employment-contracts/upload', token: tokens.viewer,
        body: payload, headers: { 'Content-Type': `multipart/form-data; boundary=${b}` },
      });
    };

    const ownUp = await contractUpload(empA1._id);
    ok(ownUp.status >= 200 && ownUp.status < 300,
      '13i העלאת חוזה לעובדת בסניף שבניהולה (מסלול עם שער) → 2xx',
      `status=${ownUp.status} ${ownUp.text}`);
    eq(await EmploymentContract.countDocuments({ employee_id: empA1._id }), 1,
      '13i ונשמר חוזה במסד');

    const otherBefore = await EmploymentContract.countDocuments({ employee_id: empB1._id });
    const otherUp = await contractUpload(empB1._id);
    eq(otherUp.status, 403, '13j אותה העלאה לעובדת בסניף אחר → 403');
    eq(otherUp.body?.code, 'VIEWER_NO_UPLOAD', '13j עם הקוד VIEWER_NO_UPLOAD');
    eq(await EmploymentContract.countDocuments({ employee_id: empB1._id }), otherBefore,
      '13j ולא נשמר חוזה');

    // Every other role writes an ungated route exactly as before.
    const adminRename = await request({
      method: 'PUT', path: `/api/branches/${branchB._id}`, token: tokens.admin,
      body: { name: nameBefore, address: 'ויצמן 2' },
    });
    eq(adminRename.status, 200, '13g מנהל המערכת כותב במסלול ללא שער → 200 (ללא שינוי)');
    const mgrRename = await request({
      method: 'PUT', path: `/api/branches/${branchA._id}`, token: tokens.manager,
      body: { address: 'הרצל 1' },
    });
    ok(mgrRename.status < 400, '13g ומנהלת סניף כותבת שם כשהיה', `status=${mgrRename.status}`);
  }

  /* ================================================================ *
   * 14. הרשאת פעולה למסך רישום חיצוני (clicktac_write)
   * ================================================================ */
  head('בדיקה 14 — הרשאת קליטת קבצים ברישום חיצוני');
  {
    // The screen's actions — uploading a קליקטאק or תמ"ת file, undoing an
    // upload, applying a comparison — used to be system_admin/accountant only,
    // so the two people the office wanted doing it (a מנהל מערכת לצפייה בלבד,
    // and one back-office employee) could not be given it at all. The
    // permission is now a tab id of its own, handed out on the permissions
    // screen: `clicktac_write`, and holding it means acting for EVERY branch.
    const XLSX = require('xlsx');
    const { TmtApproval, ExternalEnrollment } = require('../src/models');

    /** A ministry export, minimal but genuinely parseable. */
    const tmtFile = (idNumber, name) => {
      const aoa = [
        ['מסמך זה חסוי'],
        ['שם פרטי', 'שם משפחה', 'תעודת זהות', 'תאריך לידה', 'החלטה', 'קבוצת גיל', 'טלפון'],
        [name, 'בדיקה', idNumber, '01/03/2025', 'התקבל', 'תינוקות', '0501234567'],
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
      return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    };

    /** A ClickTac registrations export, same idea. */
    const clicktacFile = (idNumber, name) => {
      const aoa = [
        ['שם פרטי של הנרשם', 'שם משפחה של הנרשם', 'ת.ז הנרשם', 'תאריך לידה',
          'שנת לימודים', 'טלפון של הרושם הראשון'],
        [name, 'בדיקה', idNumber, '01/03/2025', 'תשפ"ז', '0501234567'],
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
      return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    };

    const uploadSheet = ({ path, token, buffer, branchId }) => {
      const b = `----ganE2E14${Date.now()}${Math.random().toString(16).slice(2)}`;
      const payload = Buffer.concat([
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="branch_id"\r\n\r\n${branchId}\r\n`),
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="tmt.xlsx"\r\n`
          + 'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'),
        buffer,
        Buffer.from(`\r\n--${b}--\r\n`),
      ]);
      return request({
        method: 'POST', path, token, body: payload,
        headers: { 'Content-Type': `multipart/form-data; boundary=${b}` },
      });
    };

    // ---- before the grant: refused, and nothing filed --------------------
    const before0 = await TmtApproval.countDocuments({ branch_id: branchB._id });
    const noGrant = await uploadSheet({
      path: '/api/tmt/import', token: tokens.viewer,
      buffer: tmtFile('318000001', 'לפני'), branchId: String(branchB._id),
    });
    eq(noGrant.status, 403, '14a צופה בלי ההרשאה מעלה קובץ תמ"ת → 403');
    eq(noGrant.body?.code, 'VIEWER_NO_UPLOAD', '14a עם הקוד VIEWER_NO_UPLOAD');
    eq(await TmtApproval.countDocuments({ branch_id: branchB._id }), before0,
      '14a ולא נוצרה שורה');

    // ---- the admin ticks the box on the permissions screen ---------------
    const grant = await request({
      method: 'PATCH', path: `/api/admin/users/${viewer._id}/tabs`, token: tokens.admin,
      body: { add: ['clicktac_write'], remove: [] },
    });
    eq(grant.status, 200, '14b מנהל המערכת מעניק את ההרשאה במסך ההרשאות → 200');
    ok((grant.body?.user?.tab_overrides_add || []).includes('clicktac_write'),
      '14b ההרשאה נשמרה על המשתמשת', JSON.stringify(grant.body?.user?.tab_overrides_add));

    // The grant rides on the JWT, so it takes effect on the next login —
    // exactly what the app tells a user whose permissions just changed.
    const stale = await uploadSheet({
      path: '/api/tmt/import', token: tokens.viewer,
      buffer: tmtFile('318000002', 'טוקן ישן'), branchId: String(branchB._id),
    });
    eq(stale.status, 403, '14c הטוקן הישן עדיין אינו נושא את ההרשאה → 403');
    tokens.viewer = await login('אלעד צופה', '900000003');

    // ---- after the grant: an upload for a branch she does NOT manage -----
    const granted = await uploadSheet({
      path: '/api/tmt/import', token: tokens.viewer,
      buffer: tmtFile('318000003', 'אחרי'), branchId: String(branchB._id),
    });
    ok(granted.status >= 200 && granted.status < 300,
      '14d אותה צופה, עם ההרשאה, מעלה קובץ תמ"ת לסניף שאינו בניהולה → 2xx',
      `status=${granted.status} ${granted.text}`);
    const row = await TmtApproval.findOne({ 'child.id_number': '318000003' }).lean();
    ok(!!row, '14d ונוצרה שורת תמ"ת');
    eq(String(row?.branch_id || ''), String(branchB._id), '14d תחת כפר סבא — הסניף שאינו בניהולה');

    const ce = await uploadSheet({
      path: '/api/external-enrollments/import', token: tokens.viewer,
      buffer: clicktacFile('318000004', 'קליקטאק'), branchId: String(branchB._id),
    });
    ok(ce.status >= 200 && ce.status < 300,
      '14e וגם קובץ קליקטאק לאותו סניף → 2xx', `status=${ce.status} ${ce.text}`);
    const ceRow = await ExternalEnrollment.findOne({ 'child.id_number': '318000004' }).lean();
    eq(String(ceRow?.branch_id || ''), String(branchB._id), '14e הרשומה נשמרה תחת כפר סבא');

    // ---- a viewer WITHOUT the grant is unchanged ------------------------
    const beforeV0 = await TmtApproval.countDocuments({});
    const v0 = await uploadSheet({
      path: '/api/tmt/import', token: tokens.viewer0,
      buffer: tmtFile('318000005', 'ורד'), branchId: String(branchB._id),
    });
    eq(v0.status, 403, '14f צופה אחרת, ללא ההרשאה → 403');
    eq(v0.body?.code, 'VIEWER_NO_UPLOAD', '14f עם הקוד VIEWER_NO_UPLOAD');
    eq(await TmtApproval.countDocuments({}), beforeV0, '14f ולא נוצר דבר');

    // ---- any role can be granted: a teacher, with both boxes ticked ------
    const beforeT = await TmtApproval.countDocuments({});
    const tNo = await uploadSheet({
      path: '/api/tmt/import', token: tokens.teacher,
      buffer: tmtFile('318000006', 'גננת'), branchId: String(branchB._id),
    });
    eq(tNo.status, 403, '14g גננת בלי ההרשאה → 403');
    eq(await TmtApproval.countDocuments({}), beforeT, '14g ולא נוצר דבר');

    const tGrant = await request({
      method: 'PATCH', path: `/api/admin/users/${teacher._id}/tabs`, token: tokens.admin,
      body: { add: ['clicktac', 'clicktac_write'], remove: [] },
    });
    eq(tGrant.status, 200, '14h מנהל המערכת מעניק לגננת את המסך ואת ההרשאה → 200');
    tokens.teacher = await login('מיכל גננת', '900000006');

    const tYes = await uploadSheet({
      path: '/api/tmt/import', token: tokens.teacher,
      buffer: tmtFile('318000007', 'גננת מורשית'), branchId: String(branchB._id),
    });
    ok(tYes.status >= 200 && tYes.status < 300,
      '14i ואז היא מעלה קובץ לכל סניף → 2xx (כל תפקיד ניתן להסמכה)',
      `status=${tYes.status} ${tYes.text}`);
    ok(!!await TmtApproval.findOne({ 'child.id_number': '318000007' }).lean(),
      '14i ונוצרה שורה');

    // Put the teacher back as she was, so nothing downstream reads a granted
    // teacher by accident.
    await request({
      method: 'PATCH', path: `/api/admin/users/${teacher._id}/tabs`, token: tokens.admin,
      body: { add: [], remove: [] },
    });
    tokens.teacher = await login('מיכל גננת', '900000006');
  }

  // Referenced so lint/readers see the seeded users are deliberate.
  void [acc, viewer, viewer0, manager, teacher, Setting, empFixedA];
}

async function teardown() {
  try { if (server) await new Promise((r) => server.close(r)); } catch { /* already down */ }
  try { await mongoose.disconnect(); } catch { /* not connected */ }
  try { if (mongod) await mongod.stop(); } catch { /* already stopped */ }
}

// A hung request must not leave a mongod behind for ever.
const watchdog = setTimeout(async () => {
  console.error('\n❌ הבדיקה חרגה מ-120 שניות — עוצרים');
  await teardown();
  process.exit(1);
}, 120000);
watchdog.unref();

main()
  .then(async () => {
    await teardown();
    clearTimeout(watchdog);
    console.log(`\n${failures === 0 ? '✅ הכל עבר' : `❌ ${failures} מתוך ${checks} בדיקות נכשלו`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error('\n❌ הבדיקה קרסה:', err.message);
    console.error(err.stack);
    await teardown();
    clearTimeout(watchdog);
    process.exit(1);
  });

/* ------------------------------------------------------------------ *
 * CLOSED GAPS — what this test found, and where it was fixed.
 *
 * G1  The viewer's "reads every branch" rule lived only in
 *     utils/branch-scope.js#resolveBranchScope, and the list endpoints that
 *     matter never called it — each did its own inline `role ===
 *     'system_admin'` test and confined the viewer to her own / managed
 *     branch (employee.controller#getAll, payroll.controller#listEmployees,
 *     payrollMonth.controller#getMonth, and ~33 more sites).
 *     Fixed in middleware/auth.js#presentViewerAsAdminForReads: on a READ
 *     outside /api/admin and /api/auth the viewer's role becomes
 *     'system_admin' and her true role is kept as `actual_role`, so all 36
 *     inline tests are answered at once. See scripts/viewer-auth-swap.test.js.
 *     Was failing: 1a, 1b, 1d.
 *
 * G2  controllers/payroll.controller.js#createManualPunches had NO branch
 *     scope check, so rule 3 of the design (fall back to branch_manager, let
 *     the controller's own 403 become a proposal) had no 403 to convert.
 *     Fixed by a branch-scope guard there — and by the same guard on
 *     editPunch / approvePunch / rejectPunch / deletePunch, which were missing
 *     it too. Was failing: 3b.
 *
 * G1b The read swap turned a viewer's page load into a cross-branch write:
 *     getMonth / attendanceByMonth run the fixed-schedule and closure
 *     materializers on the GET, and those insert approved punches stamped with
 *     the caller. Reading as the admin meant writing as the admin, into every
 *     branch. Fixed with utils/branch-scope.js#materializeScope — the read
 *     stays all-branch, the side effect is narrowed to her write scope.
 *     Covered by check 9.
 *
 * G2b The punch guard checked the punch's branch and never the employee's, so
 *     naming any employee with branch_id set to one's own branch passed.
 *     Fixed in createManualPunches (and punchOutOfScope for the four
 *     existing-punch mutations) by requiring BOTH sides in scope.
 *     Covered by check 10.
 *
 * G3  rateChangeRequests#list computed `can_decide` off `req.user.role`, which
 *     the read swap had already turned into 'system_admin' — so the viewer's
 *     screen offered her a decide button for a queue she cannot decide. Now
 *     read from `actual_role || role`. Covered by check 11.
 * ------------------------------------------------------------------ */
