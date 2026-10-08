#!/usr/bin/env node
/**
 * תשלומי חוגים — שולם, החשבונית, והדרך לאייקאונט.
 *
 * The payment summary says what is OWED; this layer says whether it was PAID.
 * What must hold:
 *
 *   marking שולם/לא שולם upserts one row per (branch, month, provider) —
 *     flipping it twice is an update, not a second row;
 *   the uploaded invoice becomes a regular ExpenseDocument in the provider's
 *     name, on the right branch, confirmed (needs_review=false);
 *   an UNPAID month's invoice is marked "עוד לא שולמה" the moment it lands,
 *     so iCount filing accepts it without a detour through the expenses tab;
 *   marking the month paid takes that mark DOWN, and unmarking puts it back —
 *     two screens, one story;
 *   a second invoice for the same month is refused while the first stands;
 *   and only accounting hands (system_admin / accountant) may write any of
 *     it — a branch manager reads, a branch outside the caller's scope is
 *     refused.
 *
 *   node scripts/class-payments.test.js
 */
try { require.resolve('mongodb-memory-server'); } catch {
  console.error('\n❌  npm install --no-save mongodb-memory-server\n'); process.exit(1);
}
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };
const { MongoMemoryServer } = require('mongodb-memory-server');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${!c && d ? `  (${d})` : ''}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);

(async () => {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri() + 'gan_test';
  process.env.JWT_SECRET = 'class-payments-test';
  delete process.env.PLATFORM_MONGODB_URI;
  const mongoose = require('mongoose');
  const jwt = require('jsonwebtoken');
  await mongoose.connect(process.env.MONGODB_URI);
  const { Branch, ClassProvider, ClassPayment, ExpenseDocument, ExpenseUnpaidMark } = require('../src/models');

  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/classes', require('../src/routes/classes.routes'));
  app.use((err, req, res, _n) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/classes`;

  const tokenOf = (payload) => jwt.sign({ id: String(new mongoose.Types.ObjectId()), ...payload }, process.env.JWT_SECRET);
  const admin = tokenOf({ role: 'system_admin' });
  const call = async (m, p, b, tok = admin) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, ...(b ? { body: JSON.stringify(b) } : {}) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const hz = await Branch.create({ name: 'הרצליה הרצוג' });
  const other = await Branch.create({ name: 'כפר סבא' });
  const provider = await ClassProvider.create({ name: 'טל יוגה בע״מ', vat_mode: 'registered', branch_ids: [hz._id] });
  const MONTH = '2026-10';
  const file = { data: Buffer.from('%PDF-1.4 fake invoice bytes').toString('base64'), name: 'invoice.pdf', mime: 'application/pdf' };

  console.log('\n💰 שולם / לא שולם\n');

  let r = await call('POST', '/payments/mark', {
    branch_id: String(hz._id), month: MONTH, provider_id: String(provider._id), provider_name: provider.name, paid: true,
  });
  eq(r.status, 200, 'סימון שולם נענה');
  eq(r.body.payment.paid, true, 'והשורה אומרת שולם');
  ok(!!r.body.payment.paid_at, 'עם תאריך');

  r = await call('POST', '/payments/mark', {
    branch_id: String(hz._id), month: MONTH, provider_id: String(provider._id), provider_name: provider.name, paid: false,
  });
  eq(r.body.payment.paid, false, 'ביטול הסימון מעדכן את אותה שורה');
  eq(await ClassPayment.countDocuments({}), 1, 'שורה אחת, לא שתיים');
  eq(r.body.payment.paid_at, null, 'והתאריך נמחק');

  console.log('\n🧾 החשבונית\n');

  r = await call('POST', '/payments/invoice', {
    branch_id: String(hz._id), month: MONTH, provider_id: String(provider._id),
    fields: { doc_type: 'tax_invoice', doc_number: '1001', doc_date: '2026-10-31', amount_total: 3469 },
    file,
  });
  eq(r.status, 201, 'החשבונית נשמרה');
  const docId = r.body.document && r.body.document._id;
  const doc = await ExpenseDocument.findById(docId).lean();
  eq(doc.vendor_name, 'טל יוגה בע״מ', 'בשם הספק — לא טקסט חופשי');
  eq(String(doc.branch_id), String(hz._id), 'על הסניף הנכון');
  eq(doc.needs_review, false, 'מאושרת — הוקלדה ביד');
  eq(doc.amount_total, 3469, 'בסכום שהוקלד');
  ok(!!(await ExpenseUnpaidMark.findOne({ document_id: docId })), 'חודש שלא שולם → המסמך מסומן "עוד לא שולמה" (זמין לאייקאונט)');

  r = await call('POST', '/payments/invoice', {
    branch_id: String(hz._id), month: MONTH, provider_id: String(provider._id),
    fields: { doc_number: '1002', doc_date: '2026-10-31', amount_total: 3469 },
    file: { ...file, data: Buffer.from('another pdf').toString('base64') },
  });
  eq(r.status, 409, 'חשבונית שנייה לאותו חודש — נדחית');

  console.log('\n🔄 הסימון והמסמך מספרים סיפור אחד\n');

  r = await call('POST', '/payments/mark', {
    branch_id: String(hz._id), month: MONTH, provider_id: String(provider._id), provider_name: provider.name, paid: true,
  });
  eq(r.status, 200, 'שולם — אחרי שיש חשבונית');
  ok(!(await ExpenseUnpaidMark.findOne({ document_id: docId })), 'הסימון "עוד לא שולמה" ירד');
  await call('POST', '/payments/mark', {
    branch_id: String(hz._id), month: MONTH, provider_id: String(provider._id), provider_name: provider.name, paid: false,
  });
  ok(!!(await ExpenseUnpaidMark.findOne({ document_id: docId })), 'ביטול שולם — הסימון חזר');

  console.log('\n📋 הרשימה\n');

  r = await call('GET', `/payments?branch=${hz._id}&month=${MONTH}`);
  eq(r.status, 200, 'הרשימה נענית');
  eq(r.body.payments.length, 1, 'שורה אחת לחודש');
  eq(r.body.payments[0].document.doc_number, '1001', 'עם מספר החשבונית');
  eq(r.body.payments[0].provider_key, String(provider._id), 'במפתח שהמסך מצפה לו');

  r = await call('GET', `/payments?branch=${hz._id}&month=לא-חודש`);
  eq(r.status, 400, 'חודש לא תקין — נדחה');

  console.log('\n🔒 מי רשאי\n');

  const manager = tokenOf({ role: 'branch_manager', managed_branch_ids: [String(hz._id)] });
  r = await call('POST', '/payments/mark', {
    branch_id: String(hz._id), month: MONTH, provider_id: String(provider._id), provider_name: provider.name, paid: true,
  }, manager);
  eq(r.status, 403, 'מנהלת סניף לא מסמנת תשלומים');
  r = await call('GET', `/payments?branch=${hz._id}&month=${MONTH}`, null, manager);
  eq(r.status, 403, 'וגם לא רואה את המשבצת — חשבונאות בלבד');

  const accountant = tokenOf({ role: 'accountant' });
  r = await call('POST', '/payments/mark', {
    branch_id: String(other._id), month: MONTH, provider_name: 'מדריכה בלי ספק', paid: true,
  }, accountant);
  eq(r.status, 200, 'חשבת מסמנת — גם ספק לפי שם');
  eq(r.body.payment.provider_key, 'name:מדריכה בלי ספק', 'במפתח של ספק-לפי-שם');

  await server.close();
  await mongoose.disconnect();
  await mongo.stop();
  console.log(failures ? `\n❌ ${failures} בדיקות נכשלו\n` : '\n✅ כל הבדיקות עברו\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
