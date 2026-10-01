#!/usr/bin/env node
/**
 * The income API (/api/income), its permissions and the collections bank_allocated indicator, end to end, against the REAL server.
 * Ephemeral local Mongo; dotenv is stubbed so server/.env (production on this
 * machine) is never read; the connection host is asserted loopback.
 *
 *   node scripts/income-api-e2e.test.js
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
const XLSX = require('xlsx');

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

// The real header row, in the vendor's order.
const HEADER = ['מוסד', 'חודש', 'שם פרטי', 'שם משפחה', 'ת.ז. או דרכון', 'סטטוס', 'כל חיובי החודש', 'מגבלה חודשית',
  'יעד החודש לאחר מגבלה', 'יעד מצטבר עד החודש (לאחר מגבלה)', 'סומן לגבייה החודש (ללא נכשל)', 'תשלומי החודש',
  'סומן כטופל', 'התאמות עד החודש', 'סטטוס הכנת גביה', 'סטטוס גביה', 'יש משלם שני', 'אמצעי תשלום'];
// Excel serial 46296 = 01/10/2026; the real file stores it as a number with a date format.
const serial = (y, m) => Math.round(Date.UTC(y, m - 1, 1) / 86400000) + 25569;
const row = (o = {}) => [o.inst ?? 'כפר סבא', o.month ?? serial(2026, 10), o.first ?? 'דנה', o.last ?? 'בדיקה',
  o.id ?? '000000018', o.status ?? 'התקבל', o.charges ?? 3000, o.limit ?? null, o.target ?? 3000, o.cum ?? 3000, 0,
  o.paid ?? 0, false, o.adj ?? 0, 'לחיוב', o.cstatus ?? 'לא שולם', false, o.method ?? 'ויזה - 1111'];
const debtBook = (rows, header = HEADER) => {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Worksheet 1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

const MONTHS = ['אוגוסט ', 'ספטמבר ', 'אוקטובר', 'נובמבר', 'דצמבר', 'ינואר ', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני ', 'יולי ', 'אוגוסט'];
const LABELS = ['חודשים ', 'גבייה מהמערכת', 'העברת הורים ', 'החזרים להורים', 'תשלומי ממשלה', 'תשלומי רווחה '];
// Per block: system collection for month index i = base + i (August of the start year is X).
const BLOCKS = [
  { name: 'הרצליה ', year: 'שנה שלישית', base: 1000 },
  { name: 'כפר סבא ', year: 'שנה רביעית', base: 2000 },
  { name: 'אייזיק חריף', year: 'שנה שנייה', base: 3000 },
];

/** The workbook as an array of rows; `rowOff`/`colOff` shift everything to prove nothing is hard-coded. */
function sheetRows({ rowOff = 0, colOff = 0, payments = null, yearLabel = 'תשפ"ו ', collision = false } = {}) {
  const grid = [];
  const put = (r, c, v) => {
    r += rowOff; c += colOff;
    while (grid.length <= r) grid.push([]);
    grid[r][c] = v;
  };
  put(1, 1, 'נתונים חדשים'); put(1, 8, 'דו"ח הוצאות והכנסות החל מ-9/25'); put(1, 15, yearLabel);
  BLOCKS.forEach((b, k) => {
    const c0 = 1 + k * 7;
    put(2, c0 + 4, '40-60'); put(2, c0 + 5, '60-82');
    put(3, c0 + 1, b.year); put(3, c0 + 2, b.name); put(3, c0 + 4, 1500); put(3, c0 + 5, 1800);
    put(4, c0, 'הכנסות ');
    LABELS.forEach((l, j) => put(5, c0 + j, l));
    MONTHS.forEach((m, i) => {
      const r = 6 + i;
      put(r, c0, m);
      if (i === 12) return; // August of the ending year: label only
      if (i === 0) { put(r, c0 + 1, 'X'); put(r, c0 + 2, 'X'); put(r, c0 + 4, 10); put(r, c0 + 5, 20); return; }
      put(r, c0 + 1, b.base + i);
      put(r, c0 + 2, 100.5);
      put(r, c0 + 3, i === 1 ? -50 : 'X');
      put(r, c0 + 4, i === 1 ? 'X' : 300);
      put(r, c0 + 5, 40);
    });
    put(19, c0, 'סה"כ'); put(19, c0 + 1, 99999); // the file's own total (stored, not trusted)
    put(20, c0 + 1, 123456); // block total under the total row
  });
  if (collision) { // block titles with a number beside them — not the summary
    put(2, 1, 'הוצאות'); put(2, 2, 777);
    put(23, 4, 'הכנסות'); put(23, 5, 888);
  }
  put(22, 13, 'סיכום ');
  put(23, 1, 'הוצאות '); put(23, 6, 'תשלומים ששולמו '); put(23, 13, 'הכנסות '); put(23, 14, 500000);
  put(24, 1, 'חודשים '); put(24, 2, 'שכר דירה '); put(24, 3, 'שונות ');
  put(24, 6, 'תאריך העברה '); put(24, 7, 'סכום '); put(24, 8, 'עבור חודש ');
  put(24, 13, 'הוצאות '); put(24, 14, 40000);
  const expenses = [
    ['ספטמבר', 5000, 250.25], ['אוקטובר ', 5000, 'X'], ['הוצאות תשפ"ה', 7000, null],
    ['נובמבר ', 5000, 100], ['הוצאות מים תשפ"ה (כפ"ס)', 900, null], ['דצמבר ', 5000, 0], ['אוגוסט', null, null],
  ];
  expenses.forEach((e, i) => { put(25 + i, 1, e[0]); if (e[1] != null) put(25 + i, 2, e[1]); if (e[2] != null) put(25 + i, 3, e[2]); });
  put(25 + expenses.length, 2, 99999); // expenses total, no label
  const pays = payments || [['20.9.25', 30000, 9], ['20.10.25', 31000.5, 10], ['20.11.25', 32000, 11], ['5.1.26', 15000, 'דצמבר']];
  pays.forEach((p, i) => { put(25 + i, 6, p[0]); put(25 + i, 7, p[1]); put(25 + i, 8, p[2]); });
  put(25 + pays.length + 2, 6, 'סה"כ'); put(25 + pays.length + 2, 7, 999999);
  put(25, 13, 'תשלומים ששולמו '); put(25, 14, 108000.5);
  put(26, 13, 'יתרה לתשלום'); put(26, 14, 351999.5);
  return grid;
}
const emunahBook = (opts) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetRows(opts)), 'תשפ"ו ');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

let mongod = null;
let server = null;

async function main() {
  console.log('=== הכנסות — API, הרשאות ואינדיקטור גבייה, קצה-אל-קצה ===');
  mongod = await MongoMemoryServer.create({ instance: { dbName: 'gan_incomeapi_e2e' } });
  PORT = await freePort();

  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'incomeapi-e2e-secret';
  process.env.PARENT_SECRET = 'incomeapi-e2e-parent-secret';
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

  const M = require('../src/models');
  const { User, Branch, BankAccount, BankTransaction, Registration, Child, Collection, IncomeAllocation,
    IncomeRule, IncomeRejection, IncomePayerAlias, ClickTacMonthRow, ClickTacImport, EmunahStatement, ExternalEnrollment } = M;
  const hash = await bcrypt.hash(PASSWORD, 10);
  const kaplan = await Branch.create({ name: 'גן החלומות קפלן', address: 'א' });
  const dayan = await Branch.create({ name: 'כפר סבא - משה דיין', address: 'ב' });
  const mk = (o) => User.create({ password_hash: hash, password_set: true, is_active: true, branch_id: kaplan._id, ...o });
  await mk({ email: 'a@e2e.local', full_name: 'אורי מנהל', id_number: '900000001', role: 'system_admin', position: 'מנהל' });
  await mk({ email: 'b@e2e.local', full_name: 'דנה חשבת', id_number: '900000002', role: 'accountant', position: 'הנהלת חשבונות' });
  await mk({ email: 'v@e2e.local', full_name: 'אלעד צופה', id_number: '900000003', role: 'admin_viewer', position: 'צופה' });
  await mk({ email: 't@e2e.local', full_name: 'גילי גננת', id_number: '900000004', role: 'teacher', position: 'גננת' });
  const admin = await login('אורי מנהל', '900000001');
  const accountant = await login('דנה חשבת', '900000002');
  const viewer = await login('אלעד צופה', '900000003');
  const teacher = await login('גילי גננת', '900000004');

  await IncomeRule.init();
  await require('../src/services/incomeRules.service').seed();
  const bank = await BankAccount.create({ external_id: 'b:1', institution: 'beinleumi', label: 'בנק', type: 'bank' });
  let seq = 0;
  const reg = (o) => Registration.create({
    unique_id: `U${++seq}`, child_name: `ילד ${seq}`, parent_name: 'הורה', monthly_fee: 3000,
    start_date: new Date(2025, 8, 1), end_date: new Date(2026, 7, 31), academic_year: '2025-2026',
    status: 'completed', branch_id: kaplan._id, ...o,
  });
  const tx = (o) => BankTransaction.create({
    account_id: bank._id, date: '2025-09-05', amount: 3000, description: 'העברה', hash: `h${++seq}`, ...o,
  });
  const levi = await reg({ child_name: 'נועה לוי', parent_name: 'דנה לוי', parent_id_number: '000000018' });
  await reg({ child_name: 'עומר כהן', parent_name: 'רותם כהן', parent_id_number: '000000026' });
  await Child.create({ registration_id: levi._id, child_name: 'נועה לוי', academic_year: '2025-2026' });
  await Collection.create({ registration_id: levi._id, academic_year: '2025-2026', months: [{ month_number: 10, receipt_number: '777' }] });

  const A = '/api/income';
  const oid = () => new mongoose.Types.ObjectId();
  const snapshot = async () => JSON.stringify([
    await IncomeAllocation.countDocuments(), await IncomeRejection.countDocuments(), await IncomePayerAlias.countDocuments(),
    await IncomeRule.countDocuments(), await ClickTacMonthRow.countDocuments(), await ClickTacImport.countDocuments(),
    await EmunahStatement.countDocuments(),
  ]);
  const protectedSnapshot = async () => JSON.stringify([
    await Collection.find({}).sort({ _id: 1 }).lean(), await Registration.find({}).sort({ _id: 1 }).lean(),
    await ExternalEnrollment.find({}).sort({ _id: 1 }).lean(),
  ]);
  const protectedBefore = await protectedSnapshot();

  head('הרשאות קריאה');
  const t0 = await tx({ amount: 3000, description: 'העברה מדנה לוי' });
  const readPaths = ['/kaplan/queue', '/kaplan/report', '/kaplan/matched', '/kaplan/households', '/clicktac/summary', '/emunah', '/rules',
    `/kaplan/alternatives?transaction_id=${t0._id}`];
  for (const p of readPaths) {
    eq((await request({ path: A + p, token: teacher })).status, 403, `גננת לא קוראת ${p}`);
    eq((await request({ path: A + p })).status, 401, `בלי התחברות ${p} — 401`);
    eq((await request({ path: A + p, token: viewer })).status, 200, `צופה קורא ${p}`);
    eq((await request({ path: A + p, token: accountant })).status, 200, `חשבת קוראת ${p}`);
  }
  const rulesList = (await request({ path: A + '/rules', token: admin })).body?.rules || [];
  ok(rulesList.length === 3 && rulesList.every(r => r.built_in), 'שלושת הכללים המובנים נקראים', String(rulesList.length));

  head('הרשאות כתיבה');
  {
    const before = await snapshot();
    const b64 = Buffer.from('x').toString('base64');
    const attempts = [
      ['POST', '/kaplan/accept', { transaction_id: String(t0._id), household_key: 'x' }],
      ['POST', '/kaplan/reject', { transaction_id: String(t0._id), household_key: 'x' }],
      ['POST', '/kaplan/unallocate', { transaction_id: String(t0._id) }],
      ['POST', '/clicktac/import', { branch_id: String(dayan._id), file_data: b64 }],
      ['POST', '/emunah/import', { file_data: b64 }],
      ['POST', '/rules', { pattern: 'בדיקת צופה' }],
      ['DELETE', `/rules/${rulesList[0]?._id}`, undefined],
    ];
    for (const [method, p, bodyObj] of attempts) {
      eq((await request({ method, path: A + p, token: teacher, body: bodyObj })).status, 403, `גננת — ${method} ${p} — 403`);
      eq((await request({ method, path: A + p, body: bodyObj })).status, 401, `בלי התחברות — ${method} ${p} — 401`);
      const v = await request({ method, path: A + p, token: viewer, body: bodyObj });
      ok(v.status === 202 || v.status === 403, `צופה — ${method} ${p} — הצעה או סירוב`, String(v.status));
    }
    eq(await snapshot(), before, 'כתיבות של צופה לא שינו נתונים');
  }

  head('קפלן — קבלה, דחייה, ביטול הקצאה');
  const households = (await request({ path: `${A}/kaplan/households?year=2025-2026`, token: accountant })).body?.households || [];
  const lv = households.find(h => h.parents.includes('דנה לוי'));
  const co = households.find(h => h.parents.includes('רותם כהן'));
  ok(lv && co, 'המשפחות נקראות עם household_key');
  const queue = (await request({ path: `${A}/kaplan/queue`, token: accountant })).body;
  ok(Array.isArray(queue?.pairs) && Array.isArray(queue?.unmatched_tx), 'תור — pairs / unmatched_tx');
  ok(queue.pairs.some(p => String(p.tx._id) === String(t0._id)), 'ההעברה מדנה לוי מוצעת');
  const alts = await request({ path: `${A}/kaplan/alternatives?transaction_id=${t0._id}`, token: accountant });
  eq(alts.status, 200, 'חלופות — 200');
  ok(Array.isArray(alts.body?.alternatives) && alts.body.alternatives.length > 0, 'חלופות — רשימה');
  eq((await request({ path: `${A}/kaplan/alternatives?transaction_id=nope`, token: accountant })).status, 400, 'חלופות — מזהה לא תקין 400');
  eq((await request({ path: `${A}/kaplan/alternatives?transaction_id=${oid()}`, token: accountant })).status, 404, 'חלופות — תנועה לא קיימת 404');

  const colBefore = (await request({ path: '/api/collections?year=2025-2026', token: admin })).body;
  eq(colBefore && !colBefore.error, true, 'GET /collections עונה');
  const flatBefore = Object.values(colBefore.collections).flat();
  ok(flatBefore.length === 2, 'שני רישומים בגבייה', String(flatBefore.length));
  ok(flatBefore.every(r => r.months.every(m => m.bank_allocated === 0)), 'לפני הקצאה — bank_allocated=0 בכל חודש');

  const acc = await request({ method: 'POST', path: A + '/kaplan/accept', token: accountant,
    body: { transaction_id: String(t0._id), household_key: lv.household_key } });
  eq(acc.status, 200, 'חשבת מקבלת הצעה');
  ok(Array.isArray(acc.body?.allocations) && acc.body.allocations.length === 1, 'הקצאה אחת');
  eq(await IncomeAllocation.countDocuments({ transaction_id: t0._id }), 1, 'נשמרה בבסיס הנתונים');
  eq(acc.body?.alias, 'created', 'סטטוס כינוי משלם — created', JSON.stringify(acc.body?.alias));
  eq((await request({ method: 'POST', path: A + '/kaplan/accept', token: accountant, body: { transaction_id: String(t0._id), household_key: lv.household_key } })).status, 409, 'קבלה כפולה — 409');
  eq((await request({ method: 'POST', path: A + '/kaplan/accept', token: accountant, body: { transaction_id: 'x', household_key: lv.household_key } })).status, 400, 'מזהה לא תקין — 400');
  eq((await request({ method: 'POST', path: A + '/kaplan/accept', token: accountant, body: { transaction_id: String(oid()), household_key: lv.household_key } })).status, 404, 'תנועה לא קיימת — 404');

  {
    const m = await request({ path: `${A}/kaplan/matched?year=2025-2026`, token: viewer });
    eq(m.status, 200, 'שויכו — 200');
    const row = (m.body?.matched || []).find(r => String(r.transaction_id) === String(t0._id));
    ok(row && row.tx.amount === 3000 && row.tx.description === 'העברה מדנה לוי', 'שויכו — פרטי ההעברה', JSON.stringify(row?.tx));
    ok(row && row.parents.includes('דנה לוי'), 'שויכו — שמות ההורים');
    ok(row && row.allocations.length === 1 && row.allocations[0].month_number === 9 && row.allocations[0].amount === 3000 && row.allocations[0].child_name, 'שויכו — ילד, חודש וסכום');
    ok(row && row.created_at && row.created_by, 'שויכו — מי ומתי');
    eq((await request({ path: `${A}/kaplan/matched?year=2024-2025`, token: viewer })).body?.matched?.length, 0, 'שויכו — שנה אחרת ריקה');
    eq((await request({ path: `${A}/kaplan/matched?year=nope`, token: viewer })).status, 400, 'שויכו — שנה לא תקינה 400');
  }

  head('GET /collections — רק bank_allocated נוסף');
  {
    const after = (await request({ path: '/api/collections?year=2025-2026', token: admin })).body;
    const flatAfter = Object.values(after.collections).flat();
    const levAfter = flatAfter.find(r => String(r.registration_id) === String(levi._id));
    const levBefore = flatBefore.find(r => String(r.registration_id) === String(levi._id));
    eq(levAfter.months.find(m => m.month === 9).bank_allocated, 3000, 'ספטמבר — bank_allocated=3000');
    eq(levAfter.months.filter(m => m.bank_allocated).length, 1, 'רק חודש אחד עם הקצאה');
    const strip = (body) => JSON.stringify({
      ...body,
      collections: Object.fromEntries(Object.entries(body.collections).map(([g, rows]) => [g, rows.map(r => ({
        ...r, months: r.months.map(({ bank_allocated, ...m }) => m),
      }))])),
    });
    eq(strip(after), strip(colBefore), 'כל שאר השדות זהים לפני ואחרי ההקצאה');
    const sameKeys = (a, b) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());
    ok(levAfter.months.every(m => 'bank_allocated' in m), 'bank_allocated בכל חודש');
    ok(Object.keys(levAfter.months[0]).filter(k => k !== 'bank_allocated').length > 5, 'שדות החודש הקיימים נשארו');
    ok(sameKeys(levAfter, levBefore), 'מפתחות הרישום ללא שינוי');
    eq(Object.keys(after).sort().join(','), Object.keys(colBefore).sort().join(','), 'מפתחות התשובה ללא שינוי');
    const t = (await request({ path: '/api/collections?year=2025-2026', token: teacher }));
    ok(t.status !== 500, 'GET /collections לגננת — ללא קריסה', String(t.status));
  }

  const t1 = await tx({ amount: 3000, description: 'העברה אחרת', date: '2025-10-03' });
  const rej = await request({ method: 'POST', path: A + '/kaplan/reject', token: admin, body: { transaction_id: String(t1._id), household_key: co.household_key } });
  eq(rej.status, 200, 'דחיית משפחה');
  eq(await IncomeRejection.countDocuments({ transaction_id: t1._id }), 1, 'הדחייה נשמרה');
  eq((await request({ method: 'POST', path: A + '/kaplan/reject', token: admin, body: { transaction_id: 'x', household_key: 'k' } })).status, 400, 'דחייה — מזהה לא תקין 400');
  const unal = await request({ method: 'POST', path: A + '/kaplan/unallocate', token: accountant, body: { transaction_id: String(t0._id) } });
  eq(unal.status, 200, 'ביטול הקצאה');
  eq(unal.body?.removed, 1, 'הוסרה הקצאה אחת');
  eq(await IncomeAllocation.countDocuments({}), 0, 'אין הקצאות');
  eq((await request({ path: `${A}/kaplan/matched?year=2025-2026`, token: viewer })).body?.matched?.length, 0, 'אחרי ביטול — שויכו ריק');
  eq((await request({ method: 'POST', path: A + '/kaplan/unallocate', token: accountant, body: { transaction_id: 'x' } })).status, 400, 'ביטול — מזהה לא תקין 400');
  const rep = await request({ path: `${A}/kaplan/report?year=2025-2026`, token: viewer });
  eq(rep.status, 200, 'דוח חודשי');
  eq(rep.body?.academic_year, '2025-2026', 'הדוח של השנה המבוקשת');

  head('קליקטאק — ייבוא חוב');
  {
    const enc = (buf) => buf.toString('base64');
    const ok1 = await request({ method: 'POST', path: A + '/clicktac/import', token: accountant,
      body: { branch_id: String(dayan._id), file_name: 'debt.xlsx', file_data: enc(debtBook([
        row({ id: '18', target: 1634, paid: 0 }), row({ id: '000000026', first: 'ה', last: 'ו', target: 3000, paid: 1000 }),
      ])) } });
    eq(ok1.status, 200, 'ייבוא חוב — 200');
    eq(ok1.body?.month, '2026-10', 'חודש הקובץ');
    eq(ok1.body?.rows, 2, 'שתי שורות');
    eq(await ClickTacMonthRow.countDocuments({ month: '2026-10' }), 2, 'נשמרו');
    const sum = await request({ path: `${A}/clicktac/summary?branch_id=${dayan._id}`, token: viewer });
    eq(sum.status, 200, 'סיכום חוב — 200');
    eq(sum.body?.summary?.length, 1, 'קבוצה אחת');
    eq(sum.body?.summary?.[0]?.unpaid_count, 2, 'שני ילדים בחוב');
    // a staged month never reaches the summary
    await ClickTacMonthRow.create({ branch_id: dayan._id, month: '2026-11~abc', child_id_number: '000000099', child_name: 'מבוים', status: 'התקבל', target: 5, paid: 0 });
    const sum2 = await request({ path: `${A}/clicktac/summary`, token: viewer });
    ok(!(sum2.body?.summary || []).some(g => /~/.test(g.month)), 'חודש מבוים לא מופיע בסיכום');
    eq((await request({ path: `${A}/clicktac/summary?month=2026-11~abc`, token: viewer })).status, 400, 'בקשה לחודש מבוים — 400');
    eq((await require('../src/services/clicktacDebt.service').debtSummary({ month: '2026-11~abc' })).length, 0, 'השירות עצמו — חודש מבוים ריק');
    await ClickTacMonthRow.deleteMany({ month: /~/ });
    eq((await request({ method: 'POST', path: A + '/clicktac/import', token: accountant, body: { branch_id: String(kaplan._id), file_data: enc(debtBook([row()])) } })).status, 400, 'קפלן נדחה — 400');
    eq((await request({ method: 'POST', path: A + '/clicktac/import', token: accountant, body: { branch_id: 'x', file_data: enc(debtBook([row()])) } })).status, 400, 'סניף לא תקין — 400');
    eq((await request({ method: 'POST', path: A + '/clicktac/import', token: accountant, body: { branch_id: String(dayan._id) } })).status, 400, 'בלי קובץ — 400');
    eq((await request({ method: 'POST', path: A + '/clicktac/import', token: accountant, body: { branch_id: String(dayan._id), file_data: '!!!' } })).status, 400, 'קובץ לא תקין — 400');
    eq((await request({ method: 'POST', path: A + '/clicktac/import', token: accountant, body: { branch_id: String(dayan._id), file_data: enc(Buffer.from('not an xlsx')) } })).status, 400, 'קובץ שאינו אקסל — 400');
    const huge = Buffer.alloc(10 * 1024 * 1024 + 10, 7).toString('base64');
    eq((await request({ method: 'POST', path: A + '/clicktac/import', token: accountant, body: { branch_id: String(dayan._id), file_data: huge } })).status, 400, 'מעל 10MB — 400');
    const mid = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64');
    const midRes = await request({ method: 'POST', path: A + '/clicktac/import', token: accountant, body: { branch_id: String(dayan._id), file_data: mid } });
    eq(midRes.status, 400, 'קובץ של 3MB עובר את שער ה-2MB ונדחה רק בגלל התוכן — 400');
    ok(/[א-ת]/.test(midRes.body?.error || ''), 'הודעה בעברית');
  }

  head('אמונה — ייבוא תחשיב');
  {
    const r = await request({ method: 'POST', path: A + '/emunah/import', token: accountant, body: { file_name: 'e.xlsx', file_data: emunahBook().toString('base64') } });
    eq(r.status, 200, 'ייבוא אמונה — 200');
    eq(await EmunahStatement.countDocuments({}), 1, 'נשמר תחשיב');
    const v = await request({ path: A + '/emunah', token: viewer });
    eq(v.status, 200, 'תצוגת אמונה — 200');
    ok(v.body?.emunah && Array.isArray(v.body.emunah.branches || v.body.emunah.blocks || [1]), 'תצוגה לא ריקה');
    eq((await request({ method: 'POST', path: A + '/emunah/import', token: accountant, body: { file_data: Buffer.from('junk').toString('base64') } })).status, 400, 'קובץ זר — 400');
  }

  head('כללי "לא הכנסת הורים"');
  {
    const created = await request({ method: 'POST', path: A + '/rules', token: accountant, body: { pattern: 'דמי ועד', label: 'ועד' } });
    eq(created.status, 201, 'יצירת כלל');
    const id = created.body?.rule?._id;
    ok(id && created.body.rule.built_in === false, 'כלל ידני, לא מובנה');
    eq((await request({ method: 'POST', path: A + '/rules', token: accountant, body: { pattern: 'דמי ועד' } })).status, 409, 'כלל כפול — 409');
    eq((await request({ method: 'POST', path: A + '/rules', token: accountant, body: { pattern: 'ב' } })).status, 400, 'תבנית קצרה — 400');
    const builtIn = rulesList.find(r => r.pattern === 'אמונה');
    eq((await request({ method: 'DELETE', path: `${A}/rules/${builtIn._id}`, token: accountant })).status, 400, 'מחיקת מובנה נדחית — 400');
    eq(await IncomeRule.countDocuments({ pattern: 'אמונה' }), 1, 'הכלל המובנה נשאר');
    eq((await request({ method: 'DELETE', path: `${A}/rules/nope`, token: accountant })).status, 400, 'מזהה לא תקין — 400');
    eq((await request({ method: 'DELETE', path: `${A}/rules/${oid()}`, token: accountant })).status, 404, 'כלל לא קיים — 404');
    eq((await request({ method: 'DELETE', path: `${A}/rules/${id}`, token: accountant })).status, 200, 'מחיקת כלל ידני');
    eq(await IncomeRule.countDocuments({ pattern: 'דמי ועד' }), 0, 'נמחק');
  }

  head('שגיאת שרת לא דולפת');
  {
    const orig = IncomeRule.find;
    IncomeRule.find = () => { throw new Error('secret internal detail'); };
    const boom = await request({ path: A + '/rules', token: admin });
    IncomeRule.find = orig;
    eq(boom.status, 500, 'שגיאה לא צפויה — 500');
    ok(!/secret/.test(boom.text) && /[א-ת]/.test(boom.body?.error || ''), 'הודעה כללית בעברית, בלי פרטים פנימיים');
  }

  head('הנתונים המוגנים לא נכתבו');
  eq(await protectedSnapshot(), protectedBefore, 'Collection / Registration / ExternalEnrollment ללא שינוי בכל התהליך');

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
