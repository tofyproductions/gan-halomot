#!/usr/bin/env node
/**
 * The expenses & documents API (/api/expenses) and its permissions, end to end, against the REAL server.
 * Ephemeral local Mongo; dotenv is stubbed so server/.env (production on this
 * machine) is never read; the connection host is asserted loopback.
 *
 *   node scripts/expenses-api-e2e.test.js
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


const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const PASSWORD = 'test1234';
async function login(full_name, id_number) {
  const r = await request({ method: 'POST', path: '/api/auth/login-password', body: { full_name, id_number, password: PASSWORD } });
  if (r.status !== 200 || !r.body?.token) throw new Error(`התחברות נכשלה עבור ${full_name}: ${r.status} ${r.text}`);
  return r.body.token;
}

let mongod = null;
let server = null;

async function main() {
  console.log('=== הוצאות ומסמכים — API והרשאות, קצה-אל-קצה ===');
  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_expensesapi_e2e' } });
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'expensesapi-e2e-secret';
  process.env.PARENT_SECRET = 'expensesapi-e2e-parent-secret';
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

  const { User, Branch, BankTransaction, BankAccount, ExpenseDocument, ExpensePayment, NoInvoiceRule } = require('../src/models');
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

  const mongo = require('../src/models');
  const bank = await BankAccount.create({ external_id: 'b:1', institution: 'beinleumi', label: 'בנק', type: 'bank' });
  await NoInvoiceRule.init();
  await require('../src/services/noInvoiceRules.service').seed();
  const A = '/api/expenses';
  const oid = () => new mongoose.Types.ObjectId();
  const snapshot = async () => JSON.stringify([
    await ExpenseDocument.countDocuments(), await ExpensePayment.countDocuments(), await NoInvoiceRule.countDocuments(),
    await mongo.ExpenseUnpaidMark.countDocuments(), await mongo.ExpenseDocDecision.countDocuments(),
    await mongo.ExpensePairRejection.countDocuments(), await mongo.Supplier.countDocuments(),
    (await mongo.Setting.findOne({ key: 'expenses_start_date' }).lean())?.value ?? null,
  ]);

  head('הרשאות קריאה');
  for (const p of ['/pairs', '/receipts', '/closed', '/counts', '/rules', '/intake/status', '/suppliers-missing-tax-id', '/search', '/credits', '/settings/start-date']) {
    eq((await request({ path: A + p, token: teacher })).status, 403, `גננת לא קוראת ${p}`);
    eq((await request({ path: A + p })).status, 401, `בלי התחברות ${p} — 401`);
    eq((await request({ path: A + p, token: viewer })).status, 200, `צופה קורא ${p}`);
  }

  head('מסמך ידני עם קובץ');
  const fileB64 = PNG.toString('base64');
  const fields = { vendor_name: 'ספק א', doc_type: 'tax_invoice', doc_number: 'E-1', doc_date: '2026-09-10', amount_total: 100 };
  const created = await request({ method: 'POST', path: `${A}/documents`, token: admin, body: { fields, file: { name: 'חשבונית שלי.png', mime: 'image/png', data: fileB64 } } });
  eq(created.status, 201, 'מנהל מערכת יוצר מסמך ידני');
  const docId = created.body?.document?._id;
  ok(docId, 'המסמך חזר עם מזהה');
  const file = await request({ path: `${A}/documents/${docId}/file`, token: viewer, raw: true });
  eq(file.status, 200, 'צופה קורא את הקובץ');
  ok(file.buffer?.equals(PNG), 'הקובץ חוזר בתים-בתים');
  eq(file.headers['content-type'], 'image/png', 'Content-Type מהסוג שנשמר');
  ok(/^inline; filename\*=UTF-8''/.test(file.headers['content-disposition'] || ''), 'Content-Disposition inline עם filename*', file.headers['content-disposition']);
  ok((file.headers['content-disposition'] || '').includes(encodeURIComponent('חשבונית')), 'שם הקובץ בעברית מקודד');
  eq(file.headers['x-content-type-options'], 'nosniff', 'nosniff');
  const got = await request({ path: `${A}/documents/${docId}`, token: viewer });
  eq(got.body?.document?.lane, 'open', 'המסמך בנתיב "פתוח"');
  eq((await request({ path: `${A}/documents/${oid()}`, token: admin })).status, 404, 'מסמך לא קיים — 404');
  eq((await request({ path: `${A}/documents/nope`, token: admin })).status, 400, 'מזהה לא תקין — 400');
  eq((await request({ path: `${A}/documents/${oid()}/file`, token: admin })).status, 404, 'קובץ של מסמך לא קיים — 404');

  head('כפילות ואימות');
  const dup = await request({ method: 'POST', path: `${A}/documents`, token: admin, body: { fields } });
  eq(dup.status, 409, 'אותו ספק ומספר — 409');
  eq(String(dup.body?.existing_id), String(docId), 'existing_id מצביע על המקורי');
  ok(/[א-ת]/.test(dup.body?.error || ''), 'הודעה בעברית');
  eq(dup.body?.code, 'DUPLICATE', 'קוד DUPLICATE');
  eq((await request({ method: 'POST', path: `${A}/documents`, token: admin, body: { fields: { doc_date: '2026-09-10' } } })).status, 400, 'בלי שם ספק — 400');
  eq((await request({ method: 'POST', path: `${A}/documents`, token: admin, body: { fields: { ...fields, doc_number: 'E-2' }, file: { name: 'x.exe', mime: 'application/x-msdownload', data: 'AAAA' } } })).status, 400, 'סוג קובץ לא נתמך — 400');
  // up to 10MB base64 passes the 2MB JSON gate for authenticated callers
  const big = Buffer.alloc(6 * 1024 * 1024, 7).toString('base64');
  const bigRes = await request({ method: 'POST', path: `${A}/documents`, token: accountant, body: { fields: { ...fields, doc_number: 'E-BIG' }, file: { name: 'big.pdf', mime: 'application/pdf', data: big } } });
  eq(bigRes.status, 201, 'קובץ של 6MB עובר את שער ה-2MB למשתמש מחובר');
  const tooBig = Buffer.alloc(10 * 1024 * 1024 + 10, 7).toString('base64');
  eq((await request({ method: 'POST', path: `${A}/documents`, token: accountant, body: { fields: { ...fields, doc_number: 'E-HUGE' }, file: { name: 'h.pdf', mime: 'application/pdf', data: tooBig } } })).status, 400, 'מעל 10MB — 400');
  const pdfFile = await request({ path: `${A}/documents/${bigRes.body?.document?._id}/file`, token: admin, raw: true });
  ok(/^inline/.test(pdfFile.headers['content-disposition'] || ''), 'PDF מוצג inline');

  head('התאמה — חשבת מאשרת');
  const t1 = await BankTransaction.create({ account_id: bank._id, date: '2026-09-10', amount: -100, description: 'ספק א', hash: 'e2e-1' });
  const q = await request({ path: `${A}/pairs`, token: accountant });
  eq(q.status, 200, 'תור התאמות');
  ok(q.body?.pairs?.some(p => JSON.stringify(p).includes(String(docId))), 'ההצעה מופיעה בתור', JSON.stringify(q.body).slice(0, 200));
  const alt = await request({ path: `${A}/pairs/alternatives?document_id=${docId}`, token: viewer });
  eq(alt.status, 200, 'חלופות למסמך');
  ok(alt.body?.alternatives?.length >= 1, 'יש חלופה');
  eq((await request({ path: `${A}/pairs/alternatives?transaction_id=${t1._id}`, token: viewer })).status, 200, 'חלופות לחיוב');
  eq((await request({ path: `${A}/pairs/alternatives?document_id=${oid()}`, token: viewer })).status, 404, 'חלופות למסמך לא ידוע — 404');
  eq((await request({ path: `${A}/pairs/alternatives`, token: viewer })).status, 400, 'בלי פרמטר — 400');

  const beforeViewer = await snapshot();
  const vAcc = await request({ method: 'POST', path: `${A}/pairs/accept`, token: viewer, body: { document_id: docId, transaction_id: String(t1._id) } });
  ok(vAcc.status === 202 || vAcc.status === 403, 'צופה לא מאשר ישירות', `status ${vAcc.status}`);
  const vRule = await request({ method: 'POST', path: `${A}/rules`, token: viewer, body: { pattern: 'ארנונה-צופה' } });
  ok(vRule.status === 202 || vRule.status === 403, 'צופה לא יוצר כלל ישירות', `status ${vRule.status}`);
  const vDoc = await request({ method: 'POST', path: `${A}/documents`, token: viewer, body: { fields: { ...fields, doc_number: 'E-V' } } });
  ok(vDoc.status === 202 || vDoc.status === 403, 'צופה לא יוצר מסמך ישירות', `status ${vDoc.status}`);
  eq(await snapshot(), beforeViewer, 'כתיבות הצופה לא שינו את הנתונים');
  eq((await request({ method: 'POST', path: `${A}/pairs/accept`, token: teacher, body: { document_id: docId, transaction_id: String(t1._id) } })).status, 403, 'גננת לא מאשרת');

  const acc = await request({ method: 'POST', path: `${A}/pairs/accept`, token: accountant, body: { document_id: docId, transaction_id: String(t1._id) } });
  eq(acc.status, 200, 'חשבת מאשרת התאמה', acc.text);
  const pay = await ExpensePayment.findOne({ document_id: docId }).lean();
  ok(pay && pay.amount === 100, 'נוצר תשלום בסכום החשבונית');
  eq((await request({ path: `${A}/documents/${docId}`, token: admin })).body?.document?.lane, 'closed', 'המסמך נסגר');
  eq((await request({ method: 'POST', path: `${A}/pairs/accept`, token: accountant, body: { document_id: 'bad', transaction_id: 'bad' } })).status, 400, 'מזהים לא תקינים — 400');

  head('ספירות מול נתיבים');
  const d2 = await request({ method: 'POST', path: `${A}/documents`, token: admin, body: { fields: { vendor_name: 'ספק ב', doc_type: 'tax_invoice', doc_number: 'E-3', doc_date: '2026-09-01', amount_total: 500 } } });
  const d3 = await request({ method: 'POST', path: `${A}/documents`, token: admin, body: { fields: { vendor_name: 'ספק ג', doc_type: 'receipt', doc_number: 'R-1', doc_date: '2026-09-02', amount_total: 40 } } });
  eq(d2.status, 201, 'מסמך שני'); eq(d3.status, 201, 'קבלה');
  eq((await request({ method: 'POST', path: `${A}/documents/${d2.body.document._id}/unpaid`, token: accountant })).status, 200, 'סימון "לא שולם"');
  const cnt = (await request({ path: `${A}/counts`, token: viewer })).body;
  const closedList = (await request({ path: `${A}/closed`, token: viewer })).body;
  const lane = (await request({ path: `${A}/receipts`, token: viewer })).body;
  const queue2 = (await request({ path: `${A}/pairs`, token: viewer })).body;
  eq(cnt.closed + cnt.unpaid_marked, closedList.documents.length, 'closed+unpaid_marked = רשימת הסגורים');
  const closedPay = closedList.documents.find(d => String(d._id) === String(docId))?.payments?.[0];
  eq(closedPay && closedPay.date, t1.date, 'בלשונית סגור — לכל תשלום פרטי החיוב (תאריך)');
  eq(cnt.pair, queue2.pairs.length, 'pair = אורך התור');
  eq(cnt.receipts, lane.waiting.length, 'receipts = ממתינות');
  eq(cnt.overdue, lane.overdue.length, 'overdue = באיחור');
  ok(cnt.closed >= 1 && cnt.unpaid_marked === 1 && cnt.overdue + cnt.receipts >= 1, 'הספירות לא ריקות', JSON.stringify(cnt));
  eq((await request({ method: 'DELETE', path: `${A}/documents/${d2.body.document._id}/unpaid`, token: accountant })).status, 200, 'ביטול סימון');
  const s = await request({ path: `${A}/search?q=${encodeURIComponent('ספק ב')}`, token: viewer });
  eq(s.body?.documents?.length, 1, 'חיפוש לפי שם');
  eq((await request({ path: `${A}/search?min=abc`, token: viewer })).status, 400, 'סכום לא מספרי — 400');

  head('GET אינו כותב');
  const beforeGets = await snapshot();
  const rulesBefore = await NoInvoiceRule.countDocuments();
  for (const p of ['/receipts', '/rules', '/pairs', '/counts', '/closed', '/intake/status', '/suppliers-missing-tax-id', '/search?q=x']) {
    await request({ path: A + p, token: admin });
  }
  eq(await snapshot(), beforeGets, 'אחרי כל הקריאות המסד זהה');
  eq(await NoInvoiceRule.countDocuments(), rulesBefore, 'קריאת /rules לא זורעת');
  ok(rulesBefore > 0, 'הכללים המובנים נזרעו באתחול');

  head('כללים');
  const rules = (await request({ path: `${A}/rules`, token: viewer })).body?.rules || [];
  const builtIn = rules.find(r => r.built_in);
  ok(builtIn, 'יש כלל מובנה');
  const del = await request({ method: 'DELETE', path: `${A}/rules/${builtIn._id}`, token: admin });
  eq(del.status, 400, 'מחיקת כלל מובנה נדחית');
  ok(await NoInvoiceRule.exists({ _id: builtIn._id }), 'הכלל המובנה נשאר');
  const nr = await request({ method: 'POST', path: `${A}/rules`, token: accountant, body: { label: 'ארנונה', pattern: 'עיריית' } });
  eq(nr.status, 201, 'כלל חדש נוצר');
  eq(nr.body?.rule?.built_in, false, 'כלל חדש אינו מובנה');
  eq((await request({ method: 'POST', path: `${A}/rules`, token: accountant, body: { pattern: 'עיריית' } })).status, 409, 'כלל כפול — 409');
  eq((await request({ method: 'POST', path: `${A}/rules`, token: accountant, body: { pattern: ' ' } })).status, 400, 'תבנית ריקה — 400');
  eq((await request({ method: 'DELETE', path: `${A}/rules/${nr.body.rule._id}`, token: accountant })).status, 200, 'מחיקת כלל משתמש');
  eq((await request({ method: 'DELETE', path: `${A}/rules/${oid()}`, token: accountant })).status, 404, 'כלל לא קיים — 404');

  head('ספק, החלטה, ביטול, הזמנות, שאר הכתיבות');
  const sup = await request({ method: 'POST', path: `${A}/documents/${d3.body.document._id}/supplier`, token: accountant });
  eq(sup.status, 201, 'יצירת ספק מהמסמך');
  eq((await request({ method: 'POST', path: `${A}/documents/${d3.body.document._id}/supplier`, token: accountant })).status, 409, 'למסמך כבר יש ספק — 409');
  eq((await request({ path: `${A}/suppliers-missing-tax-id`, token: viewer })).body?.suppliers?.length, 1, 'ספק בלי ח.פ ברשימה');
  eq((await request({ method: 'POST', path: `${A}/suppliers/${sup.body.supplier._id}/receipt-is-document`, token: accountant, body: { value: true } })).status, 200, 'קבלה היא המסמך — ספק');
  eq((await request({ method: 'POST', path: `${A}/suppliers/${sup.body.supplier._id}/receipt-is-document`, token: accountant, body: {} })).status, 400, 'בלי ערך — 400');
  const d4 = (await request({ method: 'POST', path: `${A}/documents`, token: admin, body: { fields: { vendor_name: 'ספק ד', doc_type: 'tax_invoice', doc_number: 'E-4', doc_date: '2026-09-02', amount_total: 70 } } })).body.document._id;
  eq((await request({ method: 'POST', path: `${A}/documents/${d4}/decision`, token: accountant, body: { kind: 'bogus' } })).status, 400, 'החלטה לא תקינה — 400');
  eq((await request({ method: 'POST', path: `${A}/documents/${d4}/decision`, token: accountant, body: { kind: 'closed_anyway', note: 'ok' } })).status, 200, 'החלטה');
  eq((await request({ path: `${A}/documents/${d4}`, token: admin })).body?.document?.lane, 'closed', 'החלטה סוגרת');
  eq((await request({ method: 'DELETE', path: `${A}/documents/${d4}/decision`, token: accountant })).status, 200, 'ביטול החלטה');
  eq((await request({ method: 'PATCH', path: `${A}/documents/${d4}`, token: accountant, body: { fields: { amount_total: 75 } } })).body?.document?.amount_total, 75, 'עדכון מסמך');
  eq((await request({ method: 'POST', path: `${A}/documents/${d4}/confirm`, token: accountant, body: { fields: { doc_number: 'E-4b' } } })).body?.document?.doc_number, 'E-4b', 'אישור קריאה');
  eq((await request({ path: `${A}/documents/${d4}/orders`, token: viewer })).status, 200, 'מועמדי הזמנות');
  eq((await request({ method: 'DELETE', path: `${A}/documents/${d4}/order`, token: accountant })).status, 409, 'ביטול קישור בלי קישור — 409');
  eq((await request({ method: 'POST', path: `${A}/documents/${d4}/order`, token: accountant, body: { order_id: 'bad' } })).status, 400, 'קישור הזמנה לא תקין — 400');
  // the owner tags a mail-sorter document with its branch before reviewing it
  const ms = await ExpenseDocument.create({ source: 'mail_sorter', mail_sorter_id: 77001, vendor_name: 'מיון', doc_date: '2026-09-02', amount_total: 33, needs_review: true });
  const tag = await request({ method: 'PATCH', path: `${A}/documents/${ms._id}`, token: accountant, body: { fields: { branch_id: String(branch._id) } } });
  eq(tag.status, 200, 'סניף על מסמך לבדיקה', tag.text);
  eq(tag.body?.document?.needs_review, true, 'סניף בלבד — המסמך עדיין לבדיקה');
  eq(String(tag.body?.document?.branch_id), String(branch._id), 'הסניף נשמר');
  const qMs = (await request({ path: `${A}/pairs`, token: viewer })).body;
  ok([...qMs.pairs.map(p => p.doc), ...qMs.unmatchedDocs].some(d => String(d._id) === String(ms._id)), 'מסמך לבדיקה עם סניף עדיין במסך ההתאמות');
  eq((await request({ method: 'POST', path: `${A}/documents/${d4}/void`, token: accountant })).status, 200, 'ביטול מסמך');
  eq((await request({ method: 'PATCH', path: `${A}/documents/${d4}`, token: accountant, body: { fields: { amount_total: 1 } } })).status, 409, 'עריכת מבוטל — 409');
  eq((await request({ method: 'POST', path: `${A}/documents/${d4}/supplier`, token: accountant })).status, 409, 'ספק ממסמך מבוטל — 409');
  eq(await mongo.Supplier.countDocuments({ name: 'ספק ד' }), 0, 'לא נוצר ספק ממסמך מבוטל');
  eq((await request({ method: 'POST', path: `${A}/documents`, token: admin, body: { fields: 'x' } })).status, 400, 'fields שאינו אובייקט — 400');
  eq((await request({ method: 'POST', path: `${A}/documents`, token: admin, body: { fields, file: 'x' } })).status, 400, 'file שאינו אובייקט — 400');
  eq((await request({ method: 'PATCH', path: `${A}/documents/${docId}`, token: accountant, body: { fields: [1] } })).status, 400, 'fields מערך ב-PATCH — 400');
  const rc = d3.body.document._id;
  eq((await request({ path: `${A}/receipts/${rc}/candidates`, token: viewer })).status, 200, 'מועמדי חשבונית לקבלה');
  eq((await request({ method: 'POST', path: `${A}/receipts/${rc}/link`, token: accountant, body: { invoice_id: String(oid()) } })).status, 404, 'קישור לחשבונית לא קיימת — 404');
  eq((await request({ method: 'POST', path: `${A}/receipts/${rc}/is-document`, token: accountant })).status, 200, 'קבלה היא מסמך');
  eq((await request({ method: 'POST', path: `${A}/pairs/unpair`, token: accountant, body: { document_id: docId, transaction_id: String(t1._id) } })).status, 200, 'ניתוק זוג');
  eq((await request({ method: 'POST', path: `${A}/pairs/reject`, token: accountant, body: { document_id: docId, transaction_id: String(t1._id) } })).status, 200, 'דחיית זוג');
  eq((await request({ method: 'POST', path: `${A}/intake/pull`, token: accountant })).status, 409, 'משיכה בלי mail-sorter מוגדר — 409');
  eq((await request({ path: `${A}/intake/status`, token: viewer })).body?.mail_sorter_configured, false, 'סטטוס קליטה');

  head('תאריך התחלה, זיכויים, נעילת משיכה');
  const sd = await request({ path: `${A}/settings/start-date`, token: viewer });
  eq(sd.body?.start_date, '2026-09-01', 'ברירת המחדל של תאריך ההתחלה');
  eq((await request({ method: 'PUT', path: `${A}/settings/start-date`, token: accountant, body: { start_date: 'אתמול' } })).status, 400, 'תאריך לא תקין — 400');
  const put = await request({ method: 'PUT', path: `${A}/settings/start-date`, token: accountant, body: { start_date: '2026-08-15' } });
  eq(put.status, 200, 'חשבת משנה תאריך התחלה'); eq(put.body?.start_date, '2026-08-15', 'הערך החדש חוזר');
  eq((await request({ path: `${A}/settings/start-date`, token: viewer })).body?.start_date, '2026-08-15', 'נקרא בחזרה');
  eq((await request({ method: 'PUT', path: `${A}/settings/start-date`, token: accountant, body: { start_date: '2026-09-01' } })).status, 200, 'החזרה לברירת המחדל');
  const crd = await request({ method: 'POST', path: `${A}/documents`, token: admin, body: { fields: { vendor_name: 'ספק זיכוי', doc_type: 'credit_note', doc_number: 'CR-1', doc_date: '2026-09-03', amount_total: 60 } } });
  eq(crd.status, 201, 'זיכוי נוצר');
  const credits = await request({ path: `${A}/credits`, token: viewer });
  ok((credits.body?.documents || []).some(d => d._id === crd.body?.document?._id && d.lane === 'credit'), 'הזיכוי ברשימת הזיכויים');
  const srch = await request({ path: `${A}/search?q=${encodeURIComponent('ספק זיכוי')}`, token: viewer });
  ok((srch.body?.documents || []).some(d => d.key === crd.body?.document?._id && d.kind === 'credit' && d.lane === 'credit'), 'הזיכוי מופיע בחיפוש');
  {
    const env = require('../src/config/env');
    const saved = [env.MAIL_SORTER_URL, env.MAIL_SORTER_TOKEN];
    env.MAIL_SORTER_URL = 'http://127.0.0.1:9'; env.MAIL_SORTER_TOKEN = 'e2e';
    const { JobLock } = require('../src/services/jobLock');
    await JobLock.create({ name: 'expense-mail-pull', holder: 'other@job', expires_at: new Date(Date.now() + 60000) });
    const busy = await request({ method: 'POST', path: `${A}/intake/pull`, token: accountant });
    eq(busy.status, 409, 'משיכה בזמן שהעבודה רצה — 409'); eq(busy.body?.error, 'משיכה כבר רצה', 'הודעה: משיכה כבר רצה');
    await JobLock.deleteMany({ name: 'expense-mail-pull' });
    [env.MAIL_SORTER_URL, env.MAIL_SORTER_TOKEN] = saved;
  }

  head('מטריצת הרשאות — כל נתיבי הכתיבה');
  const mid = String(oid()); const mid2 = String(oid());
  const WRITES = [
    ['POST', '/documents', { fields: { vendor_name: 'מטריצה', doc_date: '2026-09-01', amount_total: 5 } }],
    ['PATCH', `/documents/${docId}`, { fields: { amount_total: 5 } }],
    ['POST', `/documents/${docId}/void`, {}],
    ['POST', `/documents/${docId}/confirm`, { fields: {} }],
    ['POST', `/documents/${docId}/supplier`, {}],
    ['POST', '/pairs/accept', { document_id: docId, transaction_id: mid }],
    ['POST', '/pairs/reject', { document_id: docId, transaction_id: mid }],
    ['POST', '/pairs/unpair', { document_id: docId, transaction_id: mid }],
    ['POST', `/documents/${docId}/unpaid`, {}],
    ['DELETE', `/documents/${docId}/unpaid`, undefined],
    ['POST', `/documents/${docId}/decision`, { kind: 'closed_anyway' }],
    ['DELETE', `/documents/${docId}/decision`, undefined],
    ['POST', `/receipts/${rc}/link`, { invoice_id: mid }],
    ['DELETE', `/receipts/${rc}/link`, undefined],
    ['POST', `/receipts/${rc}/is-document`, {}],
    ['POST', `/suppliers/${mid2}/receipt-is-document`, { value: true }],
    ['POST', `/documents/${docId}/order`, { order_id: mid }],
    ['DELETE', `/documents/${docId}/order`, undefined],
    ['POST', '/rules', { pattern: 'מטריצה-כלל' }],
    ['DELETE', `/rules/${builtIn._id}`, undefined],
    ['POST', '/intake/pull', {}],
    ['PUT', '/settings/start-date', { start_date: '2026-01-01' }],
    ['PUT', '/icount/settings', { expense_type_id: 7 }],
    ['POST', '/icount/pull', {}],
    ['POST', '/icount/identity', { document_id: docId, icount_expense_id: mid, same: false }],
    ['POST', `/documents/${docId}/icount-file`, {}],
    ['POST', `/documents/${docId}/icount-paid`, {}],
    ['DELETE', `/documents/${docId}/icount-paid`, undefined],
  ];
  for (const [method, path, b] of WRITES) {
    const label = `${method} ${path.replace(/[0-9a-f]{24}/g, ':id')}`;
    eq((await request({ method, path: A + path, token: teacher, body: b })).status, 403, `גננת — ${label} — 403`);
    eq((await request({ method, path: A + path, body: b })).status, 401, `אנונימי — ${label} — 401`);
    const snap = await snapshot();
    const vr = await request({ method, path: A + path, token: viewer, body: b });
    ok(vr.status === 202 || vr.status === 403, `צופה — ${label} — לא ישיר`, `status ${vr.status}`);
    eq(await snapshot(), snap, `צופה — ${label} — הנתונים לא השתנו`);
  }


  head('אייקאונט — לא מחובר');
  const icountApi = require('../src/services/ganIcount.client');
  const { Setting: SettingM, IcountExpense, IcountPaidReport, IcountPull } = mongo;
  const TAX = '510000011';
  const st0 = await request({ path: `${A}/icount/status`, token: viewer });
  eq(st0.status, 200, 'צופה קורא סטטוס אייקאונט');
  eq(st0.body?.configured, false, 'לא מוגדר — configured:false');
  ok(!/pass|user|company/i.test(JSON.stringify(st0.body)), 'הסטטוס בלי שדות הרשאות');
  for (const p of ['/icount/status', '/icount/settings', '/icount/suppliers-missing', '/icount/identity-questions', `/documents/${docId}/icount-preview`]) {
    eq((await request({ path: A + p, token: teacher })).status, 403, `גננת — ${p} — 403`);
  }
  eq((await request({ method: 'POST', path: `${A}/icount/pull`, token: accountant })).status, 503, 'משיכה בלי חיבור — 503');
  {
    const cd = await ExpenseDocument.create({ source: 'mail_sorter', mail_sorter_id: 8999, vendor_name: 'חשמל ישראל בע"מ', supplier_tax_id: TAX, doc_type: 'tax_invoice', doc_number: 'ICN-NC', doc_date: '2026-09-10', amount_total: 30 });
    const ct = await BankTransaction.create({ account_id: bank._id, date: '2026-09-12', amount: -30, description: 'נ"ק', hash: 'icn-nc' });
    await ExpensePayment.create({ document_id: cd._id, transaction_id: ct._id, amount: 30 });
    await SettingM.findOneAndUpdate({ key: 'icount_expense_type_id' }, { $set: { value: 2 } }, { upsert: true });
    const nc = await request({ method: 'POST', path: `${A}/documents/${cd._id}/icount-file`, token: accountant, body: {} });
    eq(nc.status, 503, 'מסמך סגור, אייקאונט לא מחובר — 503'); eq(nc.body?.code, 'NOT_CONFIGURED', 'קוד NOT_CONFIGURED');
    await SettingM.deleteOne({ key: 'icount_expense_type_id' });
  }

  head('אייקאונט — הגדרות והרשאות העלאה');
  eq((await request({ path: `${A}/icount/settings`, token: viewer })).body?.expense_type_id, null, 'סוג הוצאה לא מוגדר');
  eq((await request({ method: 'PUT', path: `${A}/icount/settings`, token: accountant, body: { expense_type_id: 'abc' } })).status, 400, 'סוג הוצאה לא מספר — 400');
  eq((await request({ method: 'PUT', path: `${A}/icount/settings`, token: accountant, body: { expense_type_id: 2.5 } })).status, 400, 'סוג הוצאה לא שלם — 400');
  eq((await request({ method: 'PUT', path: `${A}/icount/settings`, token: accountant, body: { expense_type_id: 7 } })).body?.expense_type_id, 7, 'סוג הוצאה נשמר');
  eq((await request({ path: `${A}/icount/settings`, token: viewer })).body?.expense_type_id, 7, 'נקרא בחזרה');

  // a closed document (covered by a charge), source mail_sorter
  const mkClosed = async (n, amount = 100) => {
    const d = await ExpenseDocument.create({
      source: 'mail_sorter', mail_sorter_id: 9000 + n, vendor_name: 'חשמל ישראל בע"מ', supplier_tax_id: TAX,
      doc_type: 'tax_invoice', doc_number: `ICN-${n}`, doc_date: '2026-09-10', amount_total: amount,
    });
    const t = await BankTransaction.create({ account_id: bank._id, date: '2026-09-12', amount: -amount, description: `ת${n}`, hash: `icn-${n}` });
    await ExpensePayment.create({ document_id: d._id, transaction_id: t._id, amount });
    return d;
  };
  const fdoc = await mkClosed(1);
  const fid = String(fdoc._id);

  // the accountant/admin may file; the viewer and teacher may not — checked BEFORE any fake is installed (nothing to call anyway)
  {
    const { requireWriteGrant } = require('../src/middleware/auth');
    const gate = requireWriteGrant('icount_upload', 'expenses', 'system_admin', 'accountant');
    const run = (user, method = 'POST') => new Promise((resolve) => {
      const res = { status(c) { this.code = c; return this; }, json() { resolve(this.code); return this; } };
      gate({ user, method, originalUrl: '/api/expenses/documents/x/icount-file', headers: {} }, res, () => resolve('next'));
    });
    eq(await run({ role: 'accountant' }), 'next', 'רואת חשבון — ברירת מחדל — עוברת');
    eq(await run({ role: 'accountant', tab_overrides_remove: ['icount_upload'] }), 403, 'הסרה אישית של icount_upload — 403');
    eq(await run({ role: 'accountant', role_tab_remove: ['icount_upload'] }), 403, 'הסרה לכל התפקיד — 403');
    eq(await run({ role: 'accountant', tab_overrides_add: ['expenses_write'], tab_overrides_remove: ['icount_upload'] }), 403, 'expenses_write לא עוקף הסרת icount_upload');
    eq(await run({ role: 'teacher', tab_overrides_add: ['icount_upload'] }), 'next', 'הענקה אישית לגננת — עוברת (ברירת מחדל לא נדרשת)');
    eq(await run({ role: 'teacher', tab_overrides_add: ['icount_upload'], tab_overrides_remove: ['expenses'] }), 403, 'הסרת מסך הוצאות מבטלת את ההענקה');
    ok((await run({ role: 'admin_viewer', tab_overrides_add: ['icount_upload'] })) !== 'next', 'צופה לעולם לא מעלה — גם עם הענקה');
    ok((await run({ role: 'admin_viewer' })) !== 'next', 'צופה — ברירת מחדל — לא עוברת');
    ok((await run({ role: 'teacher' })) !== 'next', 'גננת — ברירת מחדל — לא עוברת');
  }
  for (const [m, pth] of [['POST', 'icount-file'], ['POST', 'icount-paid'], ['DELETE', 'icount-paid']]) {
    eq((await request({ method: m, path: `${A}/documents/${fid}/${pth}`, token: teacher, body: {} })).status, 403, `גננת — ${m} ${pth} — 403`);
    const pcBefore = await mongo.ProposedChange.countDocuments();
    const vr = await request({ method: m, path: `${A}/documents/${fid}/${pth}`, token: viewer, body: {} });
    eq(vr.status, 403, `צופה — ${m} ${pth} — 403 (לא הצעה)`);
    eq(await mongo.ProposedChange.countDocuments(), pcBefore, `צופה — ${m} ${pth} — לא נשמרה הצעה`);
  }
  eq((await request({ path: `${A}/documents/${fid}/icount-preview`, token: teacher })).status, 403, 'גננת — preview — 403');

  head('אייקאונט — מחובר עם תעבורה מזויפת');
  const calls = [];
  let createN = 500;
  const SUP = [{ supplier_id: 11, supplier_name: 'חשמל ישראל', vat_id: TAX }];
  const fake = (extra = {}) => {
    const h = {
      '/auth/login': () => ({ status: true, sid: 'S1' }),
      '/supplier/get_list': () => ({ status: true, total_count: SUP.length, results_list: SUP }),
      '/expense/search': () => ({ status: true, total_count: 0, results_list: [] }),
      '/expense/create': () => { const n = createN++; return { status: true, expense_id: `E${n}`, docnum: String(n) }; },
      '/expense/update': () => ({ status: true }),
      ...extra,
    };
    return icountApi.createIcountClient({
      credentials: { companyId: 'c', user: 'u', pass: 'p' },
      transport: async ({ url, form }) => {
        const method = url.slice(icountApi.BASE.length);
        calls.push({ method, params: Object.fromEntries([...form.entries()].filter(([k]) => k !== 'sid')) });
        const out = await h[method]();
        return { httpStatus: 200, text: typeof out === 'string' ? out : JSON.stringify(out) };
      },
    });
  };
  const ofM = (m) => calls.filter(c => c.method === m);
  const { clearSupplierCache } = require('../src/services/icountSuppliers.service');
  icountApi.__setClientForTests(fake());
  clearSupplierCache();

  const stOn = await request({ path: `${A}/icount/status`, token: viewer });
  eq(stOn.body?.configured, true, 'מוגדר — configured:true');

  const before = await ExpenseDocument.findById(fid).lean();
  const supplierReads = ofM('/supplier/get_list').length;
  clearSupplierCache();
  const vpv = await request({ path: `${A}/documents/${fid}/icount-preview`, token: viewer });
  eq(vpv.status, 200, 'צופה קורא תצוגה מקדימה');
  eq(ofM('/supplier/get_list').length, supplierReads, 'תצוגה של צופה — אייקאונט לא נשאל (אין קריאת ספקים)');
  ok(vpv.body?.remote_checked === false && vpv.body?.icount_supplier === null && vpv.body?.payload === null, 'צופה — בלי ספק אייקאונט ובלי payload');
  const pv = await request({ path: `${A}/documents/${fid}/icount-preview`, token: accountant });
  eq(pv.body?.ok, true, 'התצוגה המקדימה (רואת חשבון) מאשרת');
  eq(pv.body?.remote_checked, true, 'remote_checked');
  eq(pv.body?.payload?.expense_sum, 100, 'ה-payload בתצוגה');
  eq(ofM('/expense/create').length + ofM('/expense/update').length, 0, 'תצוגה מקדימה — אפס כתיבות לאייקאונט');
  eq(JSON.stringify(await ExpenseDocument.findById(fid).lean()), JSON.stringify(before), 'תצוגה מקדימה — המסמך לא השתנה');

  const ghost = await mongo.Supplier.create({ name: 'ספק רפאים', tax_id: '' });
  await ExpenseDocument.create({ source: 'mail_sorter', mail_sorter_id: 9200, vendor_name: 'ספק רפאים', supplier_id: ghost._id, doc_type: 'tax_invoice', doc_number: 'GH-1', doc_date: '2026-09-10', amount_total: 9 });
  const sm = await request({ path: `${A}/icount/suppliers-missing`, token: viewer });
  eq(sm.status, 200, 'ספקים חסרים נקראים');
  ok(!(sm.body?.suppliers || []).some(x => /חשמל ישראל/.test(x.name)), 'ספק שקיים באייקאונט לא ברשימת החסרים');
  ok((sm.body?.suppliers || []).some(x => x.name === 'ספק רפאים'), 'ספק שלא קיים באייקאונט — ברשימת החסרים');

  eq((await request({ path: `${A}/closed`, token: viewer })).body?.documents?.find(d => d._id === fid)?.icount?.status, 'not_in_icount', '/closed — not_in_icount לפני העלאה');
  const vf = await request({ method: 'POST', path: `${A}/documents/${fid}/icount-file`, token: viewer, body: {} });
  eq(vf.status, 403, 'צופה לא מעלה — 403');
  eq(ofM('/expense/create').length, 0, 'צופה — לא נוצר דבר באייקאונט');

  const filed = await request({ method: 'POST', path: `${A}/documents/${fid}/icount-file`, token: accountant, body: {} });
  eq(filed.status, 200, 'רואת חשבון מעלה');
  eq(ofM('/expense/create').length, 1, 'נוצרה בדיוק הוצאה אחת באייקאונט');
  eq(Object.keys(ofM('/expense/create')[0].params).sort().join(','), 'currency_code,expense_date,expense_docnum,expense_doctype,expense_sum,expense_type_id,supplier_id', 'שבעה שדות בדיוק');
  const afterFile = await ExpenseDocument.findById(fid).lean();
  ok(afterFile.icount_id && afterFile.icount_filed_at, 'המסמך נשמר עם icount_id ו-filed_at');
  const again = await request({ method: 'POST', path: `${A}/documents/${fid}/icount-file`, token: admin, body: {} });
  eq(again.status, 409, 'העלאה שנייה — 409');
  eq(again.body?.code, 'ALREADY_FILED', 'קוד ALREADY_FILED');
  eq(ofM('/expense/create').length, 1, 'העלאה שנייה לא יצרה כלום');
  const cl = (await request({ path: `${A}/closed`, token: viewer })).body?.documents?.find(d => d._id === fid);
  eq(cl?.icount?.status, 'filed', '/closed — filed אחרי העלאה');
  eq(cl?.icount?.docnum, afterFile.icount_docnum, '/closed — docnum');

  // not closed → 409 NOT_CLOSED with blockers shape preserved
  const open = await ExpenseDocument.create({ source: 'mail_sorter', mail_sorter_id: 9100, vendor_name: 'חשמל ישראל בע"מ', supplier_tax_id: TAX, doc_type: 'tax_invoice', doc_number: 'ICN-OPEN', doc_date: '2026-09-10', amount_total: 40 });
  const nc2 = await request({ method: 'POST', path: `${A}/documents/${open._id}/icount-file`, token: accountant, body: {} });
  eq(nc2.status, 409, 'מסמך לא סגור — 409'); eq(nc2.body?.code, 'NOT_CLOSED', 'NOT_CLOSED');

  // report paid / undo — only once a pull has seen the document in iCount
  const nv = await request({ method: 'POST', path: `${A}/documents/${fid}/icount-paid`, token: accountant, body: {} });
  eq(nv.status, 409, 'עוד לא נמשך מאייקאונט — 409'); eq(nv.body?.code, 'NOT_VERIFIED', 'NOT_VERIFIED');
  ok(/משכו מאייקאונט קודם/.test(nv.body?.error || ''), 'ההודעה: משכו מאייקאונט קודם');
  eq(ofM('/expense/update').length, 0, 'לא אומת — לא נשלח עדכון');
  await IcountExpense.create({ icount_id: afterFile.icount_id, supplier_id: '11', supplier_name: 'חשמל ישראל', supplier_tax_id: TAX, doc_number: afterFile.doc_number, doc_date: afterFile.doc_date, amount_total: 100, doctype: 'invoice' });
  const rp = await request({ method: 'POST', path: `${A}/documents/${fid}/icount-paid`, token: accountant, body: {} });
  eq(rp.status, 200, 'דיווח ששולם'); eq(rp.body?.paid_date, '2026-09-12', 'תאריך מהחיוב');
  eq(ofM('/expense/update').length, 1, 'עדכון אחד באייקאונט');
  eq(Object.keys(ofM('/expense/update')[0].params).sort().join(','), 'expense_id,expense_paid,expense_paid_date', 'ששולם — שלושה שדות בלבד');
  eq((await request({ path: `${A}/closed`, token: viewer })).body?.documents?.find(d => d._id === fid)?.icount?.paid_reported, true, '/closed — paid_reported');
  const un = await request({ method: 'DELETE', path: `${A}/documents/${fid}/icount-paid`, token: accountant });
  eq(un.status, 200, 'ביטול דיווח'); 
  eq((await request({ method: 'DELETE', path: `${A}/documents/${fid}/icount-paid`, token: accountant })).body?.code, 'NOT_REPORTED', 'ביטול שני — NOT_REPORTED');
  eq((await IcountPaidReport.findOne({ document_id: fid }).lean())?.undone_at ? 1 : 0, 1, 'הרשומה נשארת עם undone_at');
  eq((await request({ path: `${A}/closed`, token: viewer })).body?.documents?.find(d => d._id === fid)?.icount?.paid_reported, false, 'אחרי ביטול — paid_reported:false');

  // created in iCount but not saved here → 500 SAVE_FAILED reaches the screen, with the id
  {
    const sf = await mkClosed(3);
    icountApi.__setClientForTests(fake({ '/expense/create': async () => {
      await ExpenseDocument.updateOne({ _id: sf._id }, { $set: { status: 'void' } });
      return { status: true, expense_id: 'ESF1', docnum: '901' };
    } }));
    clearSupplierCache();
    const origErr = console.error; console.error = () => {};
    let r;
    try { r = await request({ method: 'POST', path: `${A}/documents/${sf._id}/icount-file`, token: accountant, body: {} }); } finally { console.error = origErr; }
    eq(r.status, 500, 'נוצר באייקאונט ולא נשמר — 500');
    eq(r.body?.code, 'SAVE_FAILED', 'הקוד SAVE_FAILED עובר למסך');
    eq(r.body?.icount_id, 'ESF1', 'עם icount_id');
    ok(/נוצר באייקאונט אך לא נשמר כאן — ניסיון חוזר יקשר אותו/.test(r.body?.error || ''), 'ההודעה תואמת לחלון');
  }

  // iCount refusal → 502 with its reason; throttle → 503 THROTTLED
  const fdoc2 = await mkClosed(2);
  icountApi.__setClientForTests(fake({ '/expense/create': () => ({ status: false, reason: 'ספק לא פעיל' }) }));
  clearSupplierCache();
  const ref = await request({ method: 'POST', path: `${A}/documents/${fdoc2._id}/icount-file`, token: accountant, body: {} });
  eq(ref.status, 502, 'סירוב אייקאונט — 502'); ok(/ספק לא פעיל/.test(ref.body?.error || ''), 'הסיבה של אייקאונט מועברת');
  eq(ref.body?.code, 'ICOUNT_ERROR', 'קוד ICOUNT_ERROR');
  ok(!(await ExpenseDocument.findById(fdoc2._id).lean()).icount_id, 'סירוב — לא נשמר icount_id');
  icountApi.__setClientForTests(fake({ '/expense/search': () => 'Too many requests' }));
  clearSupplierCache();
  const thr = await request({ method: 'POST', path: `${A}/documents/${fdoc2._id}/icount-file`, token: accountant, body: {} });
  eq(thr.status, 503, 'הגבלת קצב — 503'); eq(thr.body?.code, 'THROTTLED', 'קוד THROTTLED');

  // pull (same lock as the daily job): 409 while held, ok when free
  icountApi.__setClientForTests(fake({ '/supplier/get_list': () => ({ status: true, total_count: 0, results_list: [] }) }));
  clearSupplierCache();
  {
    const { JobLock } = require('../src/services/jobLock');
    await JobLock.create({ name: 'icount-mirror', holder: 'other@job', expires_at: new Date(Date.now() + 60000) });
    const busy = await request({ method: 'POST', path: `${A}/icount/pull`, token: accountant });
    eq(busy.status, 409, 'משיכת אייקאונט בזמן שהעבודה רצה — 409');
    await JobLock.deleteMany({ name: 'icount-mirror' });
    const run = await request({ method: 'POST', path: `${A}/icount/pull`, token: accountant });
    eq(run.status, 200, 'משיכת אייקאונט — 200');
    ok(run.body?.pull, 'התשובה כוללת pull');
    const st2 = await request({ path: `${A}/icount/status`, token: viewer });
    ok(st2.body?.last_pull, 'הסטטוס מראה משיכה אחרונה');
  }
  eq((await request({ path: `${A}/icount/identity-questions`, token: viewer })).status, 200, 'שאלות זהות נקראות');
  eq((await request({ method: 'POST', path: `${A}/icount/identity`, token: accountant, body: { document_id: fid } })).status, 400, 'זהות בלי same — 400');

  // gone / in_icount annotation
  {
    const g = await ExpenseDocument.create({ source: 'icount', icount_id: 'X1', icount_docnum: '77', vendor_name: 'חשמל ישראל בע"מ', supplier_tax_id: TAX, doc_type: 'tax_invoice', doc_number: 'ICN-SRC', doc_date: '2026-09-10', amount_total: 55 });
    const t = await BankTransaction.create({ account_id: bank._id, date: '2026-09-12', amount: -55, description: 'מקור אייקאונט', hash: 'icn-src' });
    await ExpensePayment.create({ document_id: g._id, transaction_id: t._id, amount: 55 });
    eq((await request({ path: `${A}/closed`, token: viewer })).body?.documents?.find(d => d._id === String(g._id))?.icount?.status, 'in_icount', 'מסמך שמקורו באייקאונט — in_icount');
    await ExpenseDocument.updateOne({ _id: g._id }, { $set: { icount_gone_at: new Date() } });
    eq((await request({ path: `${A}/closed`, token: viewer })).body?.documents?.find(d => d._id === String(g._id))?.icount?.status, 'gone', 'נעלם מאייקאונט — gone');
  }
  // the mass-void brake and held rows are shown by /icount/status
  {
    await IcountPull.create({ started_at: new Date(Date.now() + 3600e3), finished_at: new Date(Date.now() + 3600e3), complete: true, foreign: 2, gone_suppressed: { count: 25, reason: 'יותר מ-20 מסמכים נעלמו במשיכה אחת' } });
    await IcountExpense.create({ icount_id: 'HELD1', supplier_id: '11', supplier_name: 'חשמל ישראל', doc_number: 'H-1', doc_date: '2026-09-11', amount_total: 12, match_kind: 'held', match_why: 'מסמך פעיל אחר כבר מחזיק' });
    await IcountExpense.create({ icount_id: 'HELDST', supplier_id: '11', supplier_name: 'חשמל ישראל', doc_number: 'H-2', doc_date: '2026-09-11', amount_total: 13, match_kind: 'held', is_storno: true });
    const st = await request({ path: `${A}/icount/status`, token: viewer });
    ok(!(st.body?.held_rows || []).some(r => r.icount_id === 'HELDST'), 'סטטוס — שורת סטורנו לא ברשימת held');
    eq(st.body?.last_pull?.gone_suppressed?.count, 25, 'סטטוס — gone_suppressed');
    eq(st.body?.last_pull?.foreign, 2, 'סטטוס — foreign');
    eq(st.body?.held_total, 1, 'סטטוס — held_total');
    eq(st.body?.held_rows?.[0]?.icount_id, 'HELD1', 'סטטוס — held_rows');
  }
  icountApi.__setClientForTests(null);

  head('שגיאת שרת לא דולפת');
  const orig = ExpenseDocument.findById;
  ExpenseDocument.findById = () => { throw new Error('secret internal detail'); };
  const boom = await request({ path: `${A}/documents/${docId}`, token: admin });
  ExpenseDocument.findById = orig;
  eq(boom.status, 500, 'שגיאה לא צפויה — 500');
  ok(!/secret/.test(boom.text) && /[א-ת]/.test(boom.body?.error || ''), 'הודעה כללית בעברית, בלי פרטים פנימיים');

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
