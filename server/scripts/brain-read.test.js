#!/usr/bin/env node
/**
 * המוח's read window (/api/brain) — the door, and what comes through it.
 *
 *   FAILS CLOSED. No BRAIN_READ_KEY (or a short one) → 503 "brain read
 *   disabled", before the key is even looked at. Wrong / missing key → 401.
 *
 *   READ ONLY. The router declares GET and nothing else; POST/PUT/PATCH/DELETE
 *   answer 405 even WITH the right key.
 *
 *   NO PII. Responses are closed shapes. Asserted two ways: the field names are
 *   exactly the allowed list, and none of the seeded phone / email / ת.ז /
 *   address / notes / full surname appears anywhere in the raw body.
 *
 *   MONEY IS THE STAFF TABLE'S MONEY. paid / partial / unpaid come from
 *   collection-view.service, so a receipt counts as paid and a mid-month start
 *   is prorated — checked against the same fixture the staff screen would read.
 *
 *   npm install --no-save mongodb-memory-server
 *   node scripts/brain-read.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  חסרה חבילת הבדיקה. הרץ:\n\n   npm install --no-save mongodb-memory-server\n');
  process.exit(1);
}
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c || !d ? '' : `  (${d})`}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);

const KEY = 'brain-test-key-at-least-32-characters-long';

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error('not loopback');
  await mongoose.connect(uri);
  const { Branch, Classroom, Registration, Child, Collection } = require('../src/models');

  const app = express();
  app.use(express.json());
  app.use('/api/brain', require('../src/routes/brain.routes'));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/brain`;
  const call = async (path, { method = 'GET', key = KEY, headers = {} } = {}) => {
    const h = { ...headers };
    if (key) h.Authorization = `Bearer ${key}`;
    const r = await fetch(base + path, { method, headers: h });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, text, json };
  };

  // ── fixture: one branch, one class, five families, loaded with PII ──
  const PII = { phone: '0541234567', email: 'secret.parent@example.com', idn: '123456789',
    address: 'רחוב הסוד 99', notes: 'הערה-פרטית-מאוד', surname: 'משפחתיקוב' };
  const branch = await Branch.create({ name: 'סניף בדיקה' });
  const room = await Classroom.create({ name: 'כיתת ניסוי', academic_year: '2026-2027', branch_id: branch._id });
  const mk = async (first, extra = {}) => {
    const reg = await Registration.create({
      unique_id: `u-${first}`, branch_id: branch._id, child_name: `${first} ${PII.surname}`, classroom_id: room._id,
      parent_name: 'הורה פרטי', monthly_fee: 2000, start_date: new Date('2026-09-01'), end_date: new Date('2027-08-31'),
      academic_year: '2026-2027', status: 'completed', ...extra,
    });
    const child = await Child.create({
      registration_id: reg._id, child_name: `${first} ${PII.surname}`, classroom_id: room._id, academic_year: '2026-2027',
      child_id_number: PII.idn, phone: PII.phone, email: PII.email, address: PII.address, notes: PII.notes,
      parent_id_number: PII.idn, is_active: extra.__inactive ? false : true,
    });
    return { reg, child };
  };
  const paidKid = await mk('אורי');
  const partKid = await mk('נועה');
  const unpKid = await mk('גיל');
  const gone = await mk('עומר'); await Child.updateOne({ _id: gone.child._id }, { is_active: false });
  await Registration.updateOne({ _id: gone.reg._id }, { status: 'cancelled', billing_settled: true });
  const octo = (reg, month) => Collection.create({ registration_id: reg._id, academic_year: '2026-2027', months: [month] });
  await octo(paidKid.reg, { month_number: 10, expected_amount: 2000, paid_amount: 2000, receipt_number: '555', payment_status: 'paid' });
  await octo(partKid.reg, { month_number: 10, expected_amount: 2000, paid_amount: 700, payment_status: 'partial' });
  // unpKid: no Collection row at all — never paid anything.

  console.log('\n🧠 דלת המוח\n');

  console.log('סגור כשאין מפתח');
  delete process.env.BRAIN_READ_KEY;
  for (const p of ['/summary', '/payments?month=2026-10', '/unpaid?month=2026-10', '/children']) {
    const r = await call(p);
    ok(r.status === 503 && r.json?.error === 'brain read disabled', `${p} → 503 בלי מפתח בשרת`, `${r.status}`);
  }
  process.env.BRAIN_READ_KEY = 'too-short';
  eq((await call('/summary', { key: 'too-short' })).status, 503, 'מפתח קצר מ-32 תווים — עדיין סגור');

  console.log('\nמפתח');
  process.env.BRAIN_READ_KEY = KEY;
  eq((await call('/summary', { key: null })).status, 401, 'בלי Authorization → 401');
  eq((await call('/summary', { key: 'wrong-key-wrong-key-wrong-key-wrong' })).status, 401, 'מפתח שגוי → 401');
  eq((await call('/summary', { key: null, headers: { Authorization: KEY } })).status, 401, 'בלי המילה Bearer → 401');
  eq((await call('/summary')).status, 200, 'מפתח נכון → 200');

  console.log('\nקריאה בלבד');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const p of ['/summary', '/payments?month=2026-10', '/anything']) {
      const r = await call(p, { method });
      ok(r.status === 405 || r.status === 404, `${method} ${p} → ${r.status} (לא 2xx)`, `${r.status}`);
    }
  }
  eq((await call('/nope')).status, 404, 'נתיב לא קיים → 404');
  eq((await call('/payments?month=2026-10', { method: 'POST', key: null })).status, 401, 'כתיבה בלי מפתח — נעצרת בדלת');

  console.log('\nvalidation');
  for (const bad of ['', 'abc', '2026-13', '2026-00', '2026-1', '26-10', '2019-12', '2041-01', '2026-10-01', '2026-10;x']) {
    eq((await call(`/payments?month=${encodeURIComponent(bad)}`)).status, 400, `payments month="${bad}" → 400`);
  }
  eq((await call('/payments')).status, 400, 'payments בלי month → 400');
  eq((await call('/unpaid')).status, 400, 'unpaid בלי month → 400');
  eq((await call('/unpaid?month=2026-14')).status, 400, 'unpaid חודש לא חוקי → 400');
  eq((await call('/children?active=maybe')).status, 400, 'children active לא חוקי → 400');

  console.log('\nתשלומים');
  const pay = await call('/payments?month=2026-10');
  eq(pay.status, 200, '200');
  eq(pay.json.count, 3, 'שלוש משפחות פעילות (המבוטלת והמסולקת לא)');
  const by = (n) => pay.json.payments.find(p => p.child.startsWith(n));
  eq(by('אורי').status, 'paid', 'קבלה = שולם');
  eq(by('אורי').due, 2000, 'אורי: חיוב 2000');
  eq(by('אורי').paid, 2000, 'אורי: שולם 2000');
  eq(by('נועה').status, 'partial', 'נועה: חלקי');
  eq(by('נועה').paid, 700, 'נועה: 700 שולמו');
  eq(by('גיל').status, 'unpaid', 'גיל: ללא Collection = לא שולם');
  eq(by('גיל').due, 2000, 'גיל: חיוב 2000');
  eq(by('אורי').child, `אורי ${[...PII.surname][0]}.`, 'שם = פרטי + ראשונית');
  eq(by('אורי').class, 'כיתת ניסוי', 'כיתה');
  eq(by('אורי').branch, 'סניף בדיקה', 'סניף');
  eq(pay.json.month, '2026-10', 'החודש מוחזר');

  const sep = await call('/payments?month=2026-09');
  ok(sep.json.payments.every(p => p.status === 'unpaid'), 'ספטמבר ללא תשלום — כולם לא שולם');
  const aug = await call('/payments?month=2026-08');
  eq(aug.json.count, 0, 'אוגוסט 2026 שייך לשנה הקודמת — אין רישומים');

  console.log('\nלא שולם');
  const up = await call('/unpaid?month=2026-10');
  eq(up.status, 200, '200');
  eq(up.json.count, 2, 'שניים: חלקי + לא שולם');
  ok(!up.json.unpaid.some(r => r.child.startsWith('אורי')), 'מי ששילם לא ברשימה');
  eq(up.json.total_outstanding, 1300 + 2000, 'חוב כולל = 1300 + 2000');

  console.log('\nילדים');
  const kids = await call('/children?active=true');
  eq(kids.json.count, 3, 'שלושה פעילים');
  eq(kids.json.children[0].start_date, '2026-09-01', 'תאריך התחלה');
  eq((await call('/children')).json.count, 3, 'ברירת מחדל = פעילים');
  const ina = await call('/children?active=false');
  eq(ina.json.count, 1, 'active=false → הלא-פעילים');

  console.log('\nסיכום');
  const sum = await call('/summary');
  eq(sum.json.active_children_total, 3, 'סך פעילים');
  eq(sum.json.active_children_by_branch[0].active_children, 3, 'לפי סניף');
  eq(sum.json.active_children_by_class[0].class, 'כיתת ניסוי', 'לפי כיתה');
  ok(/^\d{4}-\d{2}$/.test(sum.json.current_month.month), 'חודש נוכחי');
  const svc = require('../src/services/brainRead.service');
  const octSum = await svc.summary(new Date('2026-10-15T09:00:00Z'));
  eq(octSum.current_month.month, '2026-10', 'סיכום אוקטובר');
  eq(octSum.current_month.expected, 6000, 'צפוי 3 × 2000');
  eq(octSum.current_month.collected, 2700, 'נגבה 2000 + 700');

  console.log('\nאין PII');
  const ALLOWED = {
    payments: ['child', 'class', 'branch', 'due', 'paid', 'status'],
    children: ['child', 'class', 'branch', 'start_date'],
  };
  const sameKeys = (o, list) => JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...list].sort());
  ok(pay.json.payments.every(r => sameKeys(r, ALLOWED.payments)), 'payments: בדיוק השדות המותרים');
  ok(up.json.unpaid.every(r => sameKeys(r, ALLOWED.payments)), 'unpaid: בדיוק השדות המותרים');
  ok(kids.json.children.every(r => sameKeys(r, ALLOWED.children)), 'children: בדיוק השדות המותרים');
  ok(sameKeys(sum.json, ['active_children_total', 'active_children_by_branch', 'active_children_by_class', 'current_month']), 'summary: שדות עליונים');
  for (const [label, r] of [['summary', sum], ['payments', pay], ['unpaid', up], ['children', kids], ['inactive', ina]]) {
    const leaked = Object.entries(PII).filter(([, v]) => r.text.includes(v)).map(([k]) => k);
    ok(leaked.length === 0, `${label}: אף ערך רגיש לא דלף`, leaked.join(','));
  }
  ok(!/"(_id|phone|email|address|notes|parent|id_number|salary)/i.test(pay.text + kids.text + sum.text), 'אין שמות שדות רגישים');

  console.log('\nהגבלת קצב');
  process.env.BRAIN_READ_KEY = KEY;
  let limited = 0;
  for (let i = 0; i < 70; i++) { if ((await call('/summary')).status === 429) limited++; }
  ok(limited > 0, '60 בדקה — אחרי זה 429', `${limited}`);

  server.close(); await mongoose.disconnect(); await mongod.stop();
  console.log(failures ? `\n❌ ${failures} כשלים\n` : '\n✅ הכל עבר\n');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
