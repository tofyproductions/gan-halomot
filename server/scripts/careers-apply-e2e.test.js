#!/usr/bin/env node
/**
 * דף הדרושים — the public application form, end to end.
 *
 * This is the one write endpoint in the system that a paid Facebook campaign
 * sends strangers to, so it is the one place where "an anonymous caller can
 * make us create a row, store a file and email four managers" is the intended
 * behaviour rather than a finding. What keeps that safe is entirely in the
 * details below: the phone is the identity, the branch is resolved from OUR
 * list rather than trusted, the CV is type- and size-checked before a byte is
 * kept, and the whole thing is rate limited.
 *
 * The three questions the form now asks — city, mobility, experience in a גן —
 * carry a rule that is easy to get wrong in a way nobody would notice: an
 * UNANSWERED question is not a "no". Checks 4 and 5 are that rule, from both
 * directions.
 *
 * THE DATABASE IS EPHEMERAL AND LOCAL. dotenv is stubbed out of require.cache
 * before anything loads it, so server/.env — which on this machine points at
 * production — is never read, and the connection host is asserted to be
 * loopback before a single document is written.
 *
 *   node scripts/careers-apply-e2e.test.js
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

/** The multipart body a browser would send from the form. */
function multipart(fields, file) {
  const boundary = `----careers${Date.now()}${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="cv"; filename="${file.name}"\r\n`
      + `Content-Type: ${file.type}\r\n\r\n`, 'utf8',
    ));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const apply = (fields, file) => {
  const mp = multipart(fields, file);
  return request({
    method: 'POST', path: '/api/public/careers/apply',
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
  console.log('=== דף הדרושים — בדיקת קצה-אל-קצה מול השרת האמיתי ===');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_careers_e2e' } });
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'careers-e2e-secret';
  process.env.PARENT_SECRET = 'careers-e2e-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  delete process.env.PLATFORM_MONGODB_URI;
  for (const k of ['STORAGE_ENDPOINT', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY', 'STORAGE_BUCKET', 'R2_ACCOUNT_ID']) {
    delete process.env[k];
  }
  // No mail provider is configured here, so dispatchEmail fails and is caught.
  // That is deliberate: a notification channel being down must never turn a
  // successful application into an error the applicant sees (check 8).

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

  const { User, Branch, Candidate } = require('../src/models');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  // Two branches share the label "כפר סבא" — the real shape, and the reason
  // resolveBranches returns a list.
  const ks1 = await Branch.create({ name: 'כפר סבא - משה דיין', address: 'משה דיין 9' });
  const ks2 = await Branch.create({ name: 'כפר סבא - קפלן', address: 'קפלן 1' });
  const tlv = await Branch.create({ name: 'תל אביב - יפו', address: 'יפו 1' });

  const mkUser = (o) => User.create({ password_hash: passwordHash, password_set: true, is_active: true, ...o });
  await mkUser({
    email: 'admin@e2e.local', full_name: 'אורי מנהל', id_number: '900000001',
    role: 'system_admin', branch_id: ks1._id, position: 'מנהל מערכת',
  });
  await mkUser({
    email: 'ks@e2e.local', full_name: 'לידור כהן', id_number: '900000002',
    role: 'branch_manager', branch_id: ks1._id, managed_branch_ids: [ks1._id, ks2._id],
    position: 'מנהלת סניף',
  });
  await mkUser({
    email: 'tlv@e2e.local', full_name: 'אלעד בורקוב', id_number: '900000003',
    role: 'branch_manager', branch_id: tlv._id, managed_branch_ids: [tlv._id],
    position: 'מנהל סניף',
  });

  const pdf = Buffer.from('%PDF-1.4 cv', 'utf8');

  /* ---------------------------------------------------------------- */
  head('1. הרשימה לטופס נפתחת בלי התחברות');
  const list = await request({ path: '/api/public/careers/branches' });
  eq(list.status, 200, 'נענית לאנונימי');
  const labels = (list.body?.branches || []).map(b => b.value);
  ok(labels.includes('כפר סבא'), 'כפר סבא מופיע פעם אחת, לא פעמיים');
  eq(labels.filter(l => l === 'כפר סבא').length, 1, 'ולא כשני סניפים נפרדים');
  ok(labels.includes('תל אביב'), 'ותל אביב מופיע');
  eq(list.body?.office?.value, 'משרד', 'ויש אפשרות "עוד לא סגרתי"');

  head('2. הגשה מלאה יוצרת מועמדת, בלי התחברות');
  const first = await apply({
    full_name: 'נועה ישראלי', phone: '054-1112233', branch: 'כפר סבא',
    city: 'רעננה', mobility: 'yes', gan_experience: 'no',
    email: 'noa@example.com', message: 'אשמח להצטרף',
  }, { name: 'cv.pdf', type: 'application/pdf', data: pdf });
  eq(first.status, 201, 'נקלטה');
  const noa = await Candidate.findOne({ phone: '0541112233' }).lean();
  ok(!!noa, 'והמועמדת קיימת במסד');
  eq(noa?.full_name, 'נועה ישראלי', 'עם השם');
  eq(noa?.city, 'רעננה', 'עיר מגורים');
  eq(noa?.mobility, 'yes', 'ניידות');
  eq(noa?.gan_experience, 'no', 'ניסיון בגן — "לא" נשמר כ"לא"');
  eq(noa?.status, 'new', 'וממתינה לשיחה');
  eq((noa?.branch_ids || []).length, 2, 'ו"כפר סבא" פתחה את שני הסניפים');
  eq(noa?.applications?.[0]?.source, 'website', 'המקור הוא האתר ולא תיבת המייל');
  ok(!!noa?.cv?.data, 'קורות החיים נשמרו');

  head('3. המספר הוא הזהות — פנייה שנייה מצטרפת ולא משכפלת');
  const again = await apply({
    full_name: 'נועה ישראלי כהן', phone: '0541112233', branch: 'תל אביב', city: 'תל אביב',
  });
  eq(again.status, 201, 'נקלטה');
  eq(await Candidate.countDocuments({ phone: '0541112233' }), 1, 'ועדיין מועמדת אחת');
  const noa2 = await Candidate.findOne({ phone: '0541112233' }).lean();
  eq(noa2?.applications?.length, 2, 'עם שתי פניות בהיסטוריה');
  eq(noa2?.city, 'תל אביב', 'העיר התעדכנה לאחרונה שנמסרה');
  eq((noa2?.branch_ids || []).length, 1, 'והסניף המבוקש התחלף');

  head('4. שאלה שלא נענתה אינה מוחקת תשובה קודמת');
  eq(noa2?.mobility, 'yes', 'הניידות מהפנייה הראשונה נשמרה');
  eq(noa2?.gan_experience, 'no', 'וגם הניסיון');

  head('5. "לא נענה" אינו "לא"');
  await apply({ full_name: 'דנה לוי', phone: '052-7654321', branch: 'תל אביב' });
  const dana = await Candidate.findOne({ phone: '0527654321' }).lean();
  eq(dana?.mobility, '', 'ניידות ריקה');
  eq(dana?.gan_experience, '', 'וניסיון ריק — ולא "no"');
  const bogus = await apply({
    full_name: 'שרה כהן', phone: '053-1234567', branch: 'תל אביב', mobility: 'maybe',
  });
  eq(bogus.status, 201, 'ערך לא חוקי לא מפיל את ההגשה');
  eq((await Candidate.findOne({ phone: '0531234567' }).lean())?.mobility, '', 'והוא נרשם כלא-נענה');

  head('6. "מענה כללי" הוא לא ניחוש של סניף');
  await apply({ full_name: 'רות מזרחי', phone: '050-9998877', branch: 'משרד' });
  const ruth = await Candidate.findOne({ phone: '0509998877' }).lean();
  eq((ruth?.branch_ids || []).length, 0, 'לא שויכה לאף סניף');
  eq(ruth?.branch_unmatched, false, 'ולא סומנה כ"סניף לא זוהה"');

  head('7. טופס חסר נדחה, בעברית');
  eq((await apply({ phone: '0501234567', branch: 'תל אביב' })).status, 400, 'בלי שם');
  eq((await apply({ full_name: 'א', phone: '123', branch: 'תל אביב' })).status, 400, 'טלפון קצר');
  eq((await apply({ full_name: 'א', phone: '0501234567' })).status, 400, 'בלי סניף');
  const noName = await apply({ phone: '0501234567', branch: 'תל אביב' });
  ok(/[א-ת]/.test(noName.body?.error || ''), 'וההסבר בעברית');

  head('8. קובץ שאינו קורות חיים נדחה לפני שנשמר');
  const bad = await apply(
    { full_name: 'בדיקה', phone: '0501111111', branch: 'תל אביב' },
    { name: 'x.exe', type: 'application/x-msdownload', data: Buffer.from('MZ') },
  );
  eq(bad.status, 400, 'נדחה');
  eq(await Candidate.countDocuments({ phone: '0501111111' }), 0, 'ולא נוצרה מועמדת בכלל');

  head('9. קורות החיים נפתחים למנהלת הסניף — ולא לאחרת');
  const ksToken = await login('לידור כהן', '900000002');
  const tlvToken = await login('אלעד בורקוב', '900000003');
  // נועה עברה לתל אביב בפנייה השנייה, אז נשתמש במי שנשארה בכפר סבא.
  await apply(
    { full_name: 'מיכל אבני', phone: '054-2223344', branch: 'כפר סבא' },
    { name: 'michal.pdf', type: 'application/pdf', data: pdf },
  );
  const michal = await Candidate.findOne({ phone: '0542223344' }).lean();
  const cvPath = `/api/recruitment/${michal._id}/cv`;
  const mine = await request({ path: cvPath, token: ksToken, raw: true });
  eq(mine.status, 200, 'מנהלת כפר סבא פותחת');
  ok(mine.buffer.equals(pdf), 'ומקבלת בדיוק את הקובץ שהועלה');
  eq((await request({ path: cvPath, token: tlvToken })).status, 403, 'מנהל תל אביב נדחה');
  eq((await request({ path: cvPath })).status, 401, 'ובלי התחברות — נדחה');

  head('10. הצפה נחסמת');
  // The limiter allows 20 per window across the public forms; nine were used
  // above, so the rest of the window is walked to its end here.
  let blocked = 0;
  let accepted = 0;
  for (let i = 0; i < 26; i++) {
    const r = await apply({ full_name: `בדיקה ${i}`, phone: `05811${String(i).padStart(5, '0')}`, branch: 'תל אביב' });
    if (r.status === 429) blocked++;
    else if (r.status === 201) accepted++;
  }
  ok(blocked > 0, 'השרת מפסיק לקבל אחרי מכסה', `נחסמו ${blocked}, התקבלו ${accepted}`);
  ok(accepted > 0, 'אבל רק אחרי שקלט פניות אמיתיות');

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
