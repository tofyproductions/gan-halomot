#!/usr/bin/env node
/**
 * The user-facing bank screen API, end to end, against the REAL server.
 * Ephemeral local Mongo; dotenv is stubbed so server/.env (production on this
 * machine) is never read; the connection host is asserted loopback.
 *
 *   node scripts/finance-api-e2e.test.js
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
const XLSX = require('xlsx');
const mongoose = require('mongoose');

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


// Max puts a title block above the header — the parser must find the header by name.
function makeXlsx(rows, { extraColumnFirst = false } = {}) {
  const header = ['תאריך עסקה', 'שם בית העסק', 'קטגוריה', '4 ספרות אחרונות של כרטיס האשראי', 'סוג עסקה', 'סכום חיוב', 'מטבע חיוב', 'תאריך חיוב', 'הערות'];
  const h = extraColumnFirst ? ['עמודה חדשה', ...header] : header;
  const body = rows.map(r => {
    const line = [r.date, r.merchant, 'מזון', r.card, 'רגילה', r.amount, '₪', r.charge || '02-10-2026', r.note || ''];
    return extraColumnFirst ? ['x', ...line] : line;
  });
  const ws = XLSX.utils.aoa_to_sheet([['פירוט עסקאות'], [], h, ...body]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'עסקאות');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}


const PASSWORD = 'test1234';
async function login(full_name, id_number) {
  const r = await request({ method: 'POST', path: '/api/auth/login-password', body: { full_name, id_number, password: PASSWORD } });
  if (r.status !== 200 || !r.body?.token) throw new Error(`התחברות נכשלה עבור ${full_name}: ${r.status} ${r.text}`);
  return r.body.token;
}

let mongod = null;
let server = null;

async function main() {
  console.log('=== מסך הבנק — API משתמשים, קצה-אל-קצה ===');
  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_financeapi_e2e' } });
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'financeapi-e2e-secret';
  process.env.PARENT_SECRET = 'financeapi-e2e-parent-secret';
  process.env.DISABLE_JOBS = '1';
  process.env.PORT = String(PORT);
  process.env.FRONTEND_URL = 'http://localhost:4173';
  process.env.NODE_ENV = 'development';
  process.env.GC_REEXEC = '1';
  delete process.env.PLATFORM_MONGODB_URI;
  delete process.env.FINANCE_INGEST_KEY;

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
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) throw new Error(`מסד הנתונים אינו מקומי (${host}) — עוצרים`);
  console.log(`\nשרת עלה על :${PORT}, מסד נתונים בזיכרון (${host})`);

  const { User, Branch, BankTransaction, FinanceSyncLog } = require('../src/models');
  const hash = await bcrypt.hash(PASSWORD, 10);
  const branch = await Branch.create({ name: 'תל אביב', address: 'הרצל 1' });
  const mk = (o) => User.create({ password_hash: hash, password_set: true, is_active: true, branch_id: branch._id, ...o });
  await mk({ email: 'a@e2e.local', full_name: 'אורי מנהל', id_number: '900000001', role: 'system_admin', position: 'מנהל' });
  await mk({ email: 'b@e2e.local', full_name: 'דנה חשבת', id_number: '900000002', role: 'accountant', position: 'הנהלת חשבונות' });
  await mk({ email: 'v@e2e.local', full_name: 'אלעד צופה', id_number: '900000003', role: 'admin_viewer', position: 'צופה' });
  await mk({ email: 't@e2e.local', full_name: 'גילי גננת', id_number: '900000004', role: 'teacher', position: 'גננת' });
  const admin = await login('אורי מנהל', '900000001');
  const accountant = await login('דנה חשבת', '900000002');
  const viewer = await login('אלעד צופה', '900000003');
  const teacher = await login('גילי גננת', '900000004');

  head('ייבוא');
  const b64 = makeXlsx([{ date: '05-09-2026', merchant: 'שופרסל', card: '7996', amount: 300 }]).toString('base64');
  const imp = await request({ method: 'POST', path: '/api/finance/import/max', token: admin, body: { file_data: b64 } });
  eq(imp.status, 200, 'מנהל מערכת מייבא');
  eq(imp.body?.inserted, 1, 'תנועה אחת נכנסה');
  eq((await request({ method: 'POST', path: '/api/finance/import/max', token: accountant, body: { file_data: b64 } })).status, 200, 'הנה״ח מייבאת');
  eq(await BankTransaction.countDocuments(), 1, 'ייבוא חוזר לא מכפיל');
  const before = await BankTransaction.countDocuments();
  const b64b = makeXlsx([{ date: '09-09-2026', merchant: 'פז', card: '7996', amount: 10 }]).toString('base64');
  const vimp = await request({ method: 'POST', path: '/api/finance/import/max', token: viewer, body: { file_data: b64b } });
  ok(vimp.status !== 200 || vimp.body?.proposal, 'צופה לא מייבא ישירות', `status ${vimp.status}`);
  eq(await BankTransaction.countDocuments(), before, 'ייבוא הצופה לא שינה את הנתונים');
  eq((await request({ method: 'POST', path: '/api/finance/import/max', token: admin, body: {} })).status, 400, 'בלי קובץ — 400');
  eq((await request({ method: 'POST', path: '/api/finance/import/max', token: admin, body: { file_data: Buffer.from('not a file').toString('base64') } })).status, 400, 'קובץ שגוי — 400');

  head('קריאה');
  const tx = await request({ path: '/api/finance/transactions?month=2026-09', token: viewer });
  eq(tx.status, 200, 'צופה רואה תנועות');
  eq(tx.body?.totals?.out, -300, 'סך היוצא בחודש');
  eq(tx.body?.totals?.net, -300, 'נטו');
  eq((await request({ path: '/api/finance/transactions', token: teacher })).status, 403, 'גננת לא רואה');
  eq((await request({ path: '/api/finance/transactions' })).status, 401, 'בלי התחברות — 401');
  eq((await request({ path: '/api/finance/transactions?month=2026-10', token: admin })).body?.transactions?.length, 0, 'חודש אחר — ריק');
  eq((await request({ path: '/api/finance/transactions?month=bad', token: admin })).status, 400, 'חודש לא תקין — 400');
  eq((await request({ path: '/api/finance/transactions?direction=in', token: admin })).body?.transactions?.length, 0, 'סינון הכנסות — ריק');
  eq((await request({ path: `/api/finance/transactions?q=${encodeURIComponent('שופר')}`, token: admin })).body?.transactions?.length, 1, 'חיפוש טקסט');
  eq((await request({ path: '/api/finance/transactions?q=.*', token: admin })).body?.transactions?.length, 0, 'חיפוש לא נחשב ביטוי רגולרי');
  const acc = await request({ path: '/api/finance/accounts', token: viewer });
  eq(acc.status, 200, 'צופה רואה חשבונות');
  ok(acc.body?.accounts?.some(a => a.external_id === 'max:••••7996' && a.last_tx_date === '2026-09-05'), 'חשבון הכרטיס עם תאריך תנועה אחרונה');

  head('סימון');
  const id = tx.body.transactions[0]._id;
  const f = await request({ method: 'PATCH', path: `/api/finance/transactions/${id}`, token: admin, body: { is_one_time: true } });
  eq(f.body?.transaction?.is_one_time, true, 'סימון חד פעמי נשמר');
  ok(f.body?.transaction?.flagged_by, 'ונשמר מי סימן');
  await request({ method: 'PATCH', path: `/api/finance/transactions/${id}`, token: viewer, body: { is_one_time: false } });
  const still = await request({ path: '/api/finance/transactions?month=2026-09', token: admin });
  eq(still.body?.transactions?.[0]?.is_one_time, true, 'צופה לא שינה את הסימון בפועל');
  const it = await request({ method: 'PATCH', path: `/api/finance/transactions/${id}`, token: accountant, body: { is_internal_transfer: true } });
  eq(it.body?.transaction?.is_internal_transfer, true, 'הנה״ח מסמנת העברה פנימית');
  const excl = await request({ path: '/api/finance/transactions?month=2026-09', token: admin });
  eq(excl.body?.totals?.out, 0, 'העברה פנימית לא נספרת בסכומים');
  eq((await request({ method: 'PATCH', path: '/api/finance/transactions/nope', token: admin, body: {} })).status, 400, 'מזהה לא תקין — 400');
  eq((await request({ method: 'PATCH', path: `/api/finance/transactions/${new mongoose.Types.ObjectId()}`, token: admin, body: {} })).status, 404, 'לא קיים — 404');

  head('סנכרן עכשיו');
  const s1 = await request({ method: 'POST', path: '/api/finance/sync/request', token: admin });
  const s2 = await request({ method: 'POST', path: '/api/finance/sync/request', token: admin });
  eq(String(s1.body?.request?._id), String(s2.body?.request?._id), 'לחיצה כפולה — בקשה אחת');
  const vs = await request({ method: 'POST', path: '/api/finance/sync/request', token: viewer });
  ok(vs.status !== 200 || vs.body?.proposal, 'צופה לא מבקש סנכרון ישירות');
  eq(await require('../src/models').FinanceSyncRequest.countDocuments(), 1, 'נשארה בקשה אחת במסד');
  const st = await request({ path: '/api/finance/status', token: admin });
  eq(st.body?.stale, true, 'אין קליטה מהבנק — מסומן "שותק"');
  eq(st.body?.last_request?.status, 'pending', 'הבקשה האחרונה ממתינה');
  await FinanceSyncLog.create({ source: 'agent', status: 'ok' });
  const st2 = await request({ path: '/api/finance/status', token: admin });
  eq(st2.body?.stale, false, 'אחרי קליטה — לא שותק');

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
