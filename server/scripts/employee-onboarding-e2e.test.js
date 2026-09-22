#!/usr/bin/env node
/**
 * רישום עובד/ת חדש/ה, end to end.
 *
 * The link that feeds this is PERMANENT and pasted into WhatsApp, which is the
 * same as saying it will be forwarded to people we never meant to hand it to.
 * Everything below is one question asked from several directions: can anybody
 * holding that link put a person on the payroll? An Employee row is somebody
 * the salary run pays, so an endpoint that creates one is an endpoint that
 * creates payments.
 *
 * The answer has to be no at every layer — the public endpoint writes a
 * pending row and nothing else, a branch manager may read and refuse but not
 * approve, and approval itself refuses a ת"ז that is already on the payroll.
 * Check 3 is the one that matters most and is the easiest to lose in a
 * refactor, because refusing a manager looks like a bug until you remember
 * what she would be creating.
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL. dotenv is stubbed out of require.cache
 * before anything loads it, so server/.env — which on this machine points at
 * production — is never read, and the connection host is asserted to be
 * loopback before a single document is written.
 *
 *   node scripts/employee-onboarding-e2e.test.js
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
        if (raw) return resolve({ status: res.statusCode, buffer: buf });
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

/** `files` is [{ field, name, type, data }] — the field name says what it is. */
function multipart(fields, files = []) {
  const boundary = `----join${Date.now()}${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  for (const f of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\n`
      + `Content-Type: ${f.type}\r\n\r\n`, 'utf8',
    ));
    parts.push(f.data);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const join = (fields, files) => {
  const mp = multipart(fields, files);
  return request({
    method: 'POST', path: '/api/public/employee-registration',
    body: mp.body, headers: { 'Content-Type': mp.contentType },
  });
};

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
  console.log('=== רישום עובד/ת חדש/ה — בדיקת קצה-אל-קצה ===');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_onboard_e2e' } });
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'onboard-e2e-secret';
  process.env.PARENT_SECRET = 'onboard-e2e-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  delete process.env.PLATFORM_MONGODB_URI;
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

  const { User, Branch, Employee, EmployeeOnboarding, EmployeeDocument } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const ks = await Branch.create({ name: 'כפר סבא - משה דיין', address: 'משה דיין 9' });
  const tlv = await Branch.create({ name: 'תל אביב - יפו', address: 'יפו 1' });

  const mkUser = (o) => User.create({ password_hash: passwordHash, password_set: true, is_active: true, ...o });
  await mkUser({
    email: 'admin@e2e.local', full_name: 'אורי מנהל', id_number: '900000001',
    role: 'system_admin', branch_id: ks._id, position: 'מנהל מערכת',
  });
  await mkUser({
    email: 'acc@e2e.local', full_name: 'חנה חשבת', id_number: '900000002',
    role: 'accountant', branch_id: ks._id, position: 'הנהלת חשבונות',
  });
  await mkUser({
    email: 'ks@e2e.local', full_name: 'לידור כהן', id_number: '900000003',
    role: 'branch_manager', branch_id: ks._id, managed_branch_ids: [ks._id], position: 'מנהלת סניף',
  });
  await mkUser({
    email: 'tlv@e2e.local', full_name: 'אלעד בורקוב', id_number: '900000004',
    role: 'branch_manager', branch_id: tlv._id, managed_branch_ids: [tlv._id], position: 'מנהל סניף',
  });

  const pdf = Buffer.from('%PDF-1.4 doc', 'utf8');

  /* ---------------------------------------------------------------- */
  head('1. הרשימה לטופס נפתחת בלי התחברות');
  const branchList = await request({ path: '/api/public/employee-registration/branches' });
  eq(branchList.status, 200, 'נענית לאנונימי');
  ok((branchList.body?.branches || []).some(b => b.name === 'כפר סבא - משה דיין'),
    'ומחזירה את הסניפים בשמם המלא');

  head('2. הגשה יוצרת רישום ממתין — ולא עובד/ת');
  const sent = await join({
    full_name: 'שירה לוי', israeli_id: '123456782', phone: '054-1112233',
    email: 'shira@example.com', address: 'הרצל 5, כפר סבא', birth_date: '1995-04-12',
    branch_id: String(ks._id), position: 'מטפלת',
    bank_number: '12', bank_branch: '345', bank_account: '987654', bank_account_holder: 'שירה לוי',
    emergency_name: 'דוד לוי', emergency_phone: '052-9998877', emergency_relation: 'בן זוג',
    note: 'מתחילה ב-1 לחודש',
  }, [
    { field: 'id_document', name: 'id.pdf', type: 'application/pdf', data: pdf },
    { field: 'bank_details', name: 'bank.pdf', type: 'application/pdf', data: pdf },
  ]);
  eq(sent.status, 201, 'נקלטה');
  const pending = await EmployeeOnboarding.findOne({ israeli_id: '123456782' }).lean();
  ok(!!pending, 'והרישום קיים');
  eq(pending?.status, 'pending', 'במצב "ממתין"');
  eq(pending?.files?.length, 2, 'עם שני המסמכים');
  eq(await Employee.countDocuments({ israeli_id: '123456782' }), 0,
    '⚠️ ואף עובד/ת לא נוצר/ה — זו כל הנקודה');

  head('3. מנהלת הסניף רואה את הרישום, בלי פרטי הבנק');
  const ksToken = await login('לידור כהן', '900000003');
  const mine = await request({ path: '/api/employee-onboarding?status=pending', token: ksToken });
  eq(mine.status, 200, 'הרשימה נטענת');
  const row = (mine.body?.registrations || [])[0];
  eq(row?.full_name, 'שירה לוי', 'והרישום שלה שם');
  eq(row?.bank_visible, false, 'פרטי הבנק מסומנים כלא-גלויים');
  eq(row?.bank_account, undefined, 'ומספר החשבון פשוט לא נשלח');
  eq(row?.emergency_phone, '052-9998877', 'אבל איש הקשר לחירום כן — היא זו שתתקשר');

  head('4. מנהלת סניף אינה מאשרת — זה כרטיס שהשכר משלם לו');
  const tryApprove = await request({
    method: 'POST', path: `/api/employee-onboarding/${row.id}/approve`, token: ksToken,
  });
  eq(tryApprove.status, 403, 'נדחית');
  eq(await Employee.countDocuments({ israeli_id: '123456782' }), 0, 'ואיש לא נוצר');

  head('5. מנהל הסניף השני לא רואה ולא נוגע');
  const tlvToken = await login('אלעד בורקוב', '900000004');
  const notMine = await request({ path: '/api/employee-onboarding?status=pending', token: tlvToken });
  eq((notMine.body?.registrations || []).length, 0, 'הרשימה שלו ריקה');
  eq((await request({
    method: 'POST', path: `/api/employee-onboarding/${row.id}/reject`, token: tlvToken, body: { reason: 'לא שלי' },
  })).status, 403, 'ודחייה נדחית');

  head('6. הנהלת חשבונות רואה הכול ומאשרת');
  const accToken = await login('חנה חשבת', '900000002');
  const accList = await request({ path: '/api/employee-onboarding?status=pending', token: accToken });
  const accRow = (accList.body?.registrations || [])[0];
  eq(accRow?.bank_visible, true, 'פרטי הבנק גלויים לה');
  eq(accRow?.bank_account, '987654', 'ומספר החשבון מגיע');

  const file = accRow.files[0];
  const got = await request({ path: `/api/employee-onboarding/${accRow.id}/file/${file.id}`, token: accToken, raw: true });
  eq(got.status, 200, 'והמסמך נפתח');
  ok(got.buffer.equals(pdf), 'בדיוק כפי שהועלה');

  const approved = await request({
    method: 'POST', path: `/api/employee-onboarding/${accRow.id}/approve`, token: accToken,
  });
  eq(approved.status, 200, 'האישור עובר');

  head('7. האישור יוצר כרטיס מלא, והמסמכים עוברים לתיק');
  const emp = await Employee.findOne({ israeli_id: '123456782' }).lean();
  ok(!!emp, 'הכרטיס קיים');
  eq(emp?.full_name, 'שירה לוי', 'שם');
  eq(emp?.phone, '054-1112233', 'טלפון');
  eq(emp?.address, 'הרצל 5, כפר סבא', 'כתובת');
  eq(String(emp?.branch_id), String(ks._id), 'סניף');
  eq(emp?.bank_account, '987654', 'פרטי הבנק הועתקו לכרטיס');
  eq(emp?.emergency_contact?.name, 'דוד לוי', 'ואיש הקשר לחירום');
  ok(emp?.birth_date instanceof Date, 'תאריך הלידה נשמר כתאריך, לא כמחרוזת');

  const docs = await EmployeeDocument.find({ employee_id: emp._id }).lean();
  eq(docs.length, 2, 'שני המסמכים נכנסו לתיק העובדת');
  ok(docs.some(d => d.doc_type === 'id_document'), 'צילום ת"ז על המדף הנכון');
  ok(docs.some(d => d.doc_type === 'bank_details'), 'ואישור הבנק על שלו');

  const after = await EmployeeOnboarding.findById(accRow.id).lean();
  eq(after?.status, 'approved', 'הרישום סומן כמאושר');
  eq(String(after?.employee_id), String(emp._id), 'ומצביע על הכרטיס שנוצר');

  head('8. אישור פעמיים אינו יוצר שני עובדים');
  eq((await request({
    method: 'POST', path: `/api/employee-onboarding/${accRow.id}/approve`, token: accToken,
  })).status, 400, 'רישום שכבר טופל נדחה');

  head('9. ת"ז שכבר קיימת נעצרת, ואומרת את מי מצאה');
  await join({
    full_name: 'שירה לוי אחרת', israeli_id: '123456782', phone: '054-7778899',
    branch_id: String(ks._id),
  });
  const dupRow = (await request({ path: '/api/employee-onboarding?status=pending', token: accToken }))
    .body.registrations.find(r => r.full_name === 'שירה לוי אחרת');
  const dup = await request({
    method: 'POST', path: `/api/employee-onboarding/${dupRow.id}/approve`, token: accToken,
  });
  eq(dup.status, 409, 'האישור נדחה');
  ok(/שירה לוי/.test(dup.body?.error || ''), 'וההודעה נוקבת בשם הקיים');
  eq(await Employee.countDocuments({ israeli_id: '123456782' }), 1, 'ועדיין עובדת אחת');

  head('10. טופס פגום נדחה בעברית');
  eq((await join({ israeli_id: '123456782', phone: '0541112233', branch_id: String(ks._id) })).status, 400, 'בלי שם');
  eq((await join({ full_name: 'א', israeli_id: '12', phone: '0541112233', branch_id: String(ks._id) })).status, 400, 'ת"ז קצרה');
  eq((await join({ full_name: 'א', israeli_id: '123456789', phone: '12', branch_id: String(ks._id) })).status, 400, 'טלפון קצר');
  const badFile = await join(
    { full_name: 'ב', israeli_id: '123456781', phone: '0541112244', branch_id: String(ks._id) },
    [{ field: 'id_document', name: 'x.exe', type: 'application/x-msdownload', data: Buffer.from('MZ') }],
  );
  eq(badFile.status, 400, 'קובץ שאינו מסמך');
  eq(await EmployeeOnboarding.countDocuments({ israeli_id: '123456781' }), 0, 'ולא נשמר כלום');

  head('11. הדחייה נשמרת עם הסיבה');
  await join({ full_name: 'מי שלא התקבל', israeli_id: '123456783', phone: '0549998877', branch_id: String(ks._id) });
  const toReject = (await request({ path: '/api/employee-onboarding?status=pending', token: ksToken }))
    .body.registrations.find(r => r.full_name === 'מי שלא התקבל');
  eq((await request({
    method: 'POST', path: `/api/employee-onboarding/${toReject.id}/reject`, token: ksToken, body: { reason: 'לא הגיע/ה לשיחה' },
  })).status, 200, 'מנהלת הסניף דוחה — זה כן בסמכותה');
  const rejected = await EmployeeOnboarding.findById(toReject.id).lean();
  eq(rejected?.status, 'rejected', 'הסטטוס נשמר');
  eq(rejected?.reject_reason, 'לא הגיע/ה לשיחה', 'והסיבה איתו');

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
