#!/usr/bin/env node
/**
 * תיק העובד, end to end, against the REAL server.
 *
 * The screen promises one thing: that everything the system holds about a
 * person is on it. That promise is only worth as much as the six stores it
 * reads from, so this test files one of each — a contract, an uploaded
 * document, a course certificate, a sick note, an issued letter, a payslip —
 * and asserts they all come back, on the right shelf, from one request.
 *
 * It also asserts the part that is easy to get wrong in the other direction.
 * Every route on the employee-documents router admits a branch manager, and
 * until this screen was built not one of them asked which branch the employee
 * worked in — so a manager who guessed an id could read, relabel or delete
 * another branch's ת"ז scan. Checks 3 and 6 are that hole.
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL. mongodb-memory-server starts a real
 * mongod in a temp directory; nothing here can reach the production cluster:
 * dotenv is stubbed out of require.cache before anything loads it, so
 * server/.env — which on this machine points at production — is never read,
 * and the connection host is asserted to be loopback before a single document
 * is written.
 *
 *   node scripts/employee-file-e2e.test.js
 */
const net = require('net');
const http = require('http');

/* Nothing may read server/.env. Stub dotenv before anything loads it. */
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

function request({ method = 'GET', path, token, body, headers = {}, raw = false }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    let payload = null;
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) payload = body;
      else {
        payload = Buffer.from(JSON.stringify(body));
        h['Content-Type'] = h['Content-Type'] || 'application/json';
      }
      h['Content-Length'] = payload.length;
    }
    if (token) h.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (raw) return resolve({ status: res.statusCode, buffer: buf, headers: res.headers });
        const text = buf.toString('utf8');
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

/** A multipart/form-data body, built by hand — there is no browser here. */
function multipart(fields, file) {
  const boundary = `----ganfile${Date.now()}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8',
    ));
  }
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
      + `Content-Type: ${file.type}\r\n\r\n`, 'utf8',
    ));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

const lastMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

let mongod = null;
let server = null;

async function main() {
  console.log('=== תיק העובד — בדיקת קצה-אל-קצה מול השרת האמיתי ===');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_empfile_e2e' } });
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'empfile-e2e-secret';
  process.env.PARENT_SECRET = 'empfile-e2e-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  delete process.env.PLATFORM_MONGODB_URI;
  // No bucket: documents are stored inline, which is the shape every
  // installation without STORAGE_* runs today.
  for (const k of ['STORAGE_ENDPOINT', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY', 'STORAGE_BUCKET', 'R2_ACCOUNT_ID']) {
    delete process.env[k];
  }

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

  /* ---------------------------------------------------------------- *
   * Seed
   * ---------------------------------------------------------------- */
  const {
    User, Branch, Employee, EmploymentContract, EmployeeDocument, EmployeeCourse,
    EmployeeRequest, EmployeeLetter, SavedPayslip, EmployeeCommitment, Punch,
  } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const branchA = await Branch.create({ name: 'תל אביב', address: 'הרצל 1' });
  const branchB = await Branch.create({ name: 'כפר סבא', address: 'ויצמן 2' });

  const mkUser = (o) => User.create({ password_hash: passwordHash, password_set: true, is_active: true, ...o });
  await mkUser({
    email: 'admin@e2e.local', full_name: 'אורי מנהל', id_number: '900000001',
    role: 'system_admin', branch_id: branchA._id, position: 'מנהל מערכת',
  });
  await mkUser({
    email: 'mgrA@e2e.local', full_name: 'רותי מנהלת', id_number: '900000005',
    role: 'branch_manager', branch_id: branchA._id, managed_branch_ids: [branchA._id],
    position: 'מנהלת סניף',
  });
  await mkUser({
    email: 'mgrB@e2e.local', full_name: 'סיגל מנהלת', id_number: '900000006',
    role: 'branch_manager', branch_id: branchB._id, managed_branch_ids: [branchB._id],
    position: 'מנהלת סניף',
  });

  const empUser = await mkUser({
    email: 'dana@e2e.local', full_name: 'דנה גננת', id_number: '310000001',
    role: 'teacher', branch_id: branchA._id, position: 'גננת',
  });
  const emp = await Employee.create({
    full_name: 'דנה גננת', israeli_id: '310000001', phone: '050-3100001',
    email: 'dana@e2e.local', position: 'גננת', branch_id: branchA._id,
    salary_type: 'hourly', hourly_rate: 50, is_active: true,
    start_date: new Date('2024-09-01'), user_id: empUser._id,
  });
  const other = await Employee.create({
    full_name: 'נועה כפר סבא', israeli_id: '310000003', phone: '050-3100003',
    email: 'noa@e2e.local', position: 'גננת', branch_id: branchB._id,
    salary_type: 'hourly', hourly_rate: 50, is_active: true,
    start_date: new Date('2024-09-01'),
  });

  const ym = lastMonth();
  const pdf = Buffer.from('%PDF-1.4 fake', 'utf8');

  await EmploymentContract.create({
    employee_id: emp._id, branch_id: branchA._id, variant: 'hourly',
    status: 'signed', html: '<html>הסכם</html>', signed_at: new Date(),
  });
  await EmployeeDocument.create({
    employee_id: emp._id, branch_id: branchA._id, name: 'טופס 101 שנתי',
    doc_type: 'form_101', tax_year: new Date().getFullYear(),
    file_data: pdf.toString('base64'), file_name: '101.pdf', file_mimetype: 'application/pdf',
  });
  const otherDoc = await EmployeeDocument.create({
    employee_id: other._id, branch_id: branchB._id, name: 'צילום תעודת זהות',
    doc_type: 'id_document',
    file_data: pdf.toString('base64'), file_name: 'id.pdf', file_mimetype: 'application/pdf',
  });
  await EmployeeCourse.create({
    employee_id: emp._id, course_type: 'first_aid', completed_at: new Date('2026-02-01'),
    expires_at: new Date('2028-02-01'),
    file_data: pdf.toString('base64'), file_name: 'mada.pdf', file_mimetype: 'application/pdf',
  });
  await EmployeeRequest.create({
    employee_id: emp._id, user_id: empUser._id, branch_id: branchA._id,
    type: 'sick', from_date: `${ym}-04`, to_date: `${ym}-05`, reason: 'שפעת',
    medical_file_data: pdf.toString('base64'), medical_file_name: 'sick.pdf',
  });
  await EmployeeLetter.create({
    employee_id: emp._id, branch_id: branchA._id, type: 'employment_confirmation',
    title: 'אישור העסקה', html: '<html>אישור</html>', signed_by_name: 'רותי מנהלת',
  });
  await SavedPayslip.create({
    employee_id: emp._id, israeli_id: emp.israeli_id, year_month: ym,
    data: pdf, sent_at: new Date(), delivered_to_employee: true,
  });
  await EmployeeCommitment.create({
    employee_id: emp._id, branch_id: branchA._id, classroom: 'צעירים',
    days: [
      { day: 0, start_hhmm: '07:30', end_hhmm: '16:00' },
      { day: 1, start_hhmm: '07:30', end_hhmm: '16:00' },
      { day: 2, start_hhmm: '07:30', end_hhmm: '16:00' },
      { day: 3, start_hhmm: '07:30', end_hhmm: '16:00' },
      { day: 4, is_off: true },
      { day: 5, start_hhmm: '07:30', end_hhmm: '12:30' },
    ],
  });
  // One manual report waiting on the branch manager, so the queue has a row
  // whose commitment the screen must be able to state.
  await Punch.create({
    employee_id: emp._id, israeli_id: emp.israeli_id, branch_id: branchA._id,
    timestamp: new Date(`${ym}-06T13:05:00Z`), state: 1,
    // A manual report still carries a clock-record id, because the dedupe
    // index is on (branch, device_user_sn) and every punch has to have one.
    device_user_sn: 900001,
    approval_status: 'pending_manager', timestamp_source: 'manual',
    created_by: empUser._id,
  });

  const adminT = await login('אורי מנהל', '900000001');
  const mgrAT = await login('רותי מנהלת', '900000005');
  const mgrBT = await login('סיגל מנהלת', '900000006');
  const empId = String(emp._id);

  /* ---------------------------------------------------------------- */
  head('1. מנהל מערכת מקבל את כל התיק בקריאה אחת');
  const full = await request({ path: `/api/employee-file/${empId}`, token: adminT });
  eq(full.status, 200, 'התיק נפתח');
  const items = full.body?.items || [];
  const shelfOf = (s) => items.filter(i => i.shelf === s);
  eq(full.body?.employee?.full_name, 'דנה גננת', 'התיק מזהה את העובדת');
  ok(shelfOf('employment_contract').length === 1, 'חוזה העסקה');
  ok(shelfOf('form_101').length === 1, 'טופס 101');
  ok(shelfOf('certificate').length === 1, 'תעודת קורס');
  ok(shelfOf('health').length === 1, 'אישור מחלה');
  ok(shelfOf('letter').length === 1, 'מסמך שהונפק');
  ok(shelfOf('payslip').length === 1, 'תלוש שכר');
  ok(shelfOf('hours_report').length >= 1, 'דוח שעות לאותו חודש');

  head('2. כל שורה יודעת מאיפה מורידים אותה, ובאיזה אופן');
  ok(items.every(i => typeof i.href === 'string' && i.href.startsWith('/')),
    'לכל שורה יש כתובת הורדה');
  ok(items.every(i => i.fetch_mode === 'binary' || i.fetch_mode === 'base64'),
    'לכל שורה יש אופן שליפה מוכר');
  ok(shelfOf('hours_report').every(i => i.refresh_href),
    'רק לדוח שעות יש חישוב מחדש');
  ok(!shelfOf('payslip')[0]?.refresh_href, 'לתלוש אין חישוב מחדש — הוא לא מחושב');
  ok(shelfOf('payslip')[0]?.badges?.includes('נמסר לעובד/ת'), 'התלוש מסומן כנמסר');
  ok(shelfOf('hours_report').some(i => i.badges?.includes('מחושב חי')),
    'חודש בלי עותק שמור מוצג כמחושב חי');
  ok(items.every(i => !('file_data' in i)), 'שום בייט של קובץ לא נוסע ברשימה');

  head('3. מנהלת הסניף השני לא מגיעה לתיק בכלל');
  const denied = await request({ path: `/api/employee-file/${empId}`, token: mgrBT });
  eq(denied.status, 403, 'נדחית');
  ok(/סניף/.test(denied.body?.error || ''), 'והסיבה נאמרת בעברית');

  head('4. מנהלת הסניף שלה רואה את התיק המלא — כולל תלושים');
  const mine = await request({ path: `/api/employee-file/${empId}`, token: mgrAT });
  eq(mine.status, 200, 'נכנסת');
  ok((mine.body?.items || []).some(i => i.shelf === 'payslip'), 'ורואה את התלוש');
  eq((mine.body?.items || []).length, items.length, 'אותו תיק בדיוק כמו למנהל המערכת');

  head('5. העלאת מסמך מכאן יושבת על המדף הנכון');
  const up = multipart(
    { employee_id: empId, name: 'המלצה ממנהלת קודמת', doc_type: 'recommendation', description: 'מ-2023' },
    { name: 'recommendation.pdf', type: 'application/pdf', data: pdf },
  );
  const created = await request({
    method: 'POST', path: '/api/employee-documents', token: mgrAT,
    body: up.body, headers: { 'Content-Type': up.contentType },
  });
  eq(created.status, 201, 'נקלט');
  const after = await request({ path: `/api/employee-file/${empId}`, token: mgrAT });
  const rec = (after.body?.items || []).filter(i => i.shelf === 'recommendation');
  eq(rec.length, 1, 'ומופיע מיד בתיק, תחת "המלצות"');
  eq(rec[0]?.title, 'המלצה ממנהלת קודמת', 'עם השם שניתן לו');
  ok(rec[0]?.deletable === true, 'וניתן למחיקה — הוא הועלה, לא נוצר');
  const bytes = await request({ path: `/api${rec[0].href}`, token: mgrAT, raw: true });
  eq(bytes.status, 200, 'והקובץ עצמו נפתח');
  ok(bytes.buffer.equals(pdf), 'ומגיע בדיוק כפי שהועלה');

  head('6. מנהלת אינה מגיעה למסמך של עובדת בסניף אחר');
  const foreign = String(otherDoc._id);
  eq((await request({ path: `/api/employee-documents/${foreign}/download`, token: mgrAT })).status, 403,
    'לא מורידה אותו');
  eq((await request({ path: `/api/employee-documents/${foreign}/file`, token: mgrAT })).status, 403,
    'לא קוראת אותו');
  eq((await request({
    method: 'PUT', path: `/api/employee-documents/${foreign}`, token: mgrAT, body: { name: 'שונה' },
  })).status, 403, 'לא משנה את שמו');
  eq((await request({ method: 'DELETE', path: `/api/employee-documents/${foreign}`, token: mgrAT })).status, 403,
    'ולא מוחקת אותו');
  const stillThere = await EmployeeDocument.findById(foreign).lean();
  ok(stillThere && stillThere.name === 'צילום תעודת זהות', 'והמסמך אכן נשאר כפי שהיה');
  eq((await request({
    method: 'POST', path: '/api/employee-documents',
    token: mgrAT,
    body: { employee_id: String(other._id), name: 'מוברח', file_data: pdf.toString('base64') },
  })).status, 403, 'וגם לא מצרפת מסמך חדש לעובדת שאינה שלה');

  head('7. תור ההחתמות מקבל את שעות ההתחייבות יחד עם הדיווחים');
  const pending = await request({ path: '/api/payroll/punches/pending', token: mgrAT });
  eq(pending.status, 200, 'התור נטען');
  ok((pending.body?.pending_manager || []).length === 1, 'ויש בו את הדיווח הממתין');
  const c = pending.body?.commitments?.[empId];
  ok(!!c, 'ההתחייבות של אותה עובדת נשלחה איתו');
  eq(c?.days?.length, 6, 'כל ששת ימי השבוע');
  eq(c?.days?.find(d => d.day === 0)?.start_hhmm, '07:30', 'ראשון מתחיל ב-07:30');
  eq(c?.days?.find(d => d.day === 0)?.end_hhmm, '16:00', 'ומסתיים ב-16:00');
  eq(c?.days?.find(d => d.day === 4)?.is_off, true, 'וחמישי מסומן כיום חופש');
  eq(c?.is_alternating_off, false, 'ואין לה יום לסרוגין');

  head('8. מחיקה מהתיק מוציאה את השורה');
  eq((await request({ method: 'DELETE', path: `/api${rec[0].delete_href}`, token: mgrAT })).status, 200,
    'ההמלצה נמחקת');
  const afterDelete = await request({ path: `/api/employee-file/${empId}`, token: mgrAT });
  eq((afterDelete.body?.items || []).filter(i => i.shelf === 'recommendation').length, 0,
    'ואינה חוזרת בתיק');

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
