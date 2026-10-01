#!/usr/bin/env node
/**
 * Expenses writes — accept / reject / unpair / unpaid / decide / confirm /
 * void (port notes §3, §4). Runs once on a standalone server (ordered writes
 * with compensation) and once on a replica set (real transactions).
 *
 *   node scripts/expense-writes.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

const { MongoMemoryServer, MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c || !d ? '' : `  (${d})`}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const refuses = async (fn, status, l) => {
  try { await fn(); ok(false, `${l} — לא נזרקה שגיאה`); } catch (e) { eq(e.status, status, `${l} → ${status}`); }
};

async function suite(label) {
  console.log(`\n✍️  כתיבות — ${label}\n`);
  const { BankAccount, BankTransaction, ExpenseDocument, ExpensePayment, ExpensePairRejection, Supplier } = require('../src/models');
  const rules = require('../src/services/noInvoiceRules.service');
  const core = require('../src/services/expenseCore.service');
  const pairs = require('../src/services/expensePairs.service');
  const w = require('../src/services/expenseWrites.service');
  await Promise.all([BankTransaction, ExpenseDocument, ExpensePayment, ExpensePairRejection, Supplier].map(m => m.deleteMany({})));
  await rules.seed();
  let seq = 0;
  const bank = await BankAccount.findOne({ external_id: 'b:1' }) || await BankAccount.create({ external_id: 'b:1', institution: 'beinleumi', label: 'בנק', type: 'bank' });
  const tx = (o) => BankTransaction.create({ account_id: bank._id, date: '2026-09-10', amount: -100, description: 'תנועה', hash: `h${label}${++seq}`, ...o });
  const doc = (o) => ExpenseDocument.create({ source: 'manual', vendor_name: 'ספק', doc_type: 'tax_invoice', doc_number: `N${label}${++seq}`, doc_date: '2026-09-10', amount_total: 100, ...o });
  const stateOf = async (id) => (await core.documentsWithState()).find(d => String(d._id) === String(id));
  const poolHas = async (id) => (await core.chargePool()).open.some(t => String(t._id) === String(id));
  const paysOf = (id) => ExpensePayment.find({ document_id: id }).lean();

  console.log('acceptPair');
  {
    const d = await doc({ needs_review: true, vendor_name: 'קרא-לא-נכון', amount_total: 100 });
    const t = await tx({ amount: -100 });
    const r = await w.acceptPair({ document_id: d._id, transaction_id: t._id, review: { vendor_name: 'ספק נכון', doc_number: 'A-1', evil: 'x' }, by: new mongoose.Types.ObjectId() });
    eq(r.payment.amount, 100, 'סכום התשלום = יתרה');
    const s = await stateOf(d._id);
    eq(s.needs_review, false, 'needs_review נוקה');
    eq(s.vendor_name, 'ספק נכון', 'תיקון שדה הוחל');
    eq(s.doc_number, 'A-1', 'תיקון מספר');
    eq(s.lane, 'closed', 'המסמך נסגר');
    ok(!!s.confirmed_at, 'confirmed_at נקבע');
    ok(!(await poolHas(t._id)), 'החיוב יצא מהמאגר');
    await refuses(() => w.acceptPair({ document_id: d._id, transaction_id: t._id }), 409, 'אותו זוג פעמיים');
    const d2 = await doc({});
    await refuses(() => w.acceptPair({ document_id: d2._id, transaction_id: t._id }), 409, 'חיוב מכוסה במלואו');
    eq((await paysOf(d2._id)).length, 0, 'ולא נוצר תשלום');
    await refuses(() => w.acceptPair({ document_id: 'zzz', transaction_id: t._id }), 400, 'מזהה לא תקין');
    await refuses(() => w.acceptPair({ document_id: new mongoose.Types.ObjectId(), transaction_id: t._id }), 404, 'מסמך לא קיים');
    const inc = await tx({ amount: 50 });
    await refuses(() => w.acceptPair({ document_id: d2._id, transaction_id: inc._id }), 400, 'תקבול נכנס');
    const t3 = await tx({ amount: -100 });
    await refuses(() => w.acceptPair({ document_id: d2._id, transaction_id: t3._id, review: { amount_total: -5 } }), 400, 'סכום תיקון שלילי');
    const rc = await doc({ doc_type: 'receipt' });
    const t4 = await tx({ amount: -100 });
    await refuses(() => w.acceptPair({ document_id: rc._id, transaction_id: t4._id }), 409, 'קבלה אינה ניתנת לשיוך');
  }

  console.log('\nסכום חלקי ויתרות');
  {
    const d = await doc({ amount_total: 1000 });
    const t = await tx({ amount: -400 });
    const r = await w.acceptPair({ document_id: d._id, transaction_id: t._id });
    eq(r.payment.amount, 400, 'חיוב קטן מהמסמך — תשלום חלקי (min)');
    const s = await stateOf(d._id);
    eq(s.state, 'partial', 'partial');
    eq(s.remaining, 600, 'נשארו 600');
    const big = await tx({ amount: -5000 });
    const r2 = await w.acceptPair({ document_id: d._id, transaction_id: big._id });
    eq(r2.payment.amount, 600, 'חיוב גדול מהמסמך — רק היתרה');
    eq((await stateOf(d._id)).state, 'settled', 'settled');
    ok(await poolHas(big._id), 'החיוב הגדול נשאר במאגר עם יתרה');
    const d3 = await doc({ amount_total: 300 });
    await refuses(() => w.acceptPair({ document_id: d3._id, transaction_id: big._id, amount: 99999 }), 409, 'סכום מעל יתרת החיוב');
    const r3 = await w.acceptPair({ document_id: d3._id, transaction_id: big._id, amount: 250 });
    eq(r3.payment.amount, 250, 'סכום מפורש מכובד');
  }

  console.log('\nמטבע חוץ');
  {
    const d = await doc({ currency: 'USD', amount_total: 200, fx_confirmed: false });
    eq((await stateOf(d._id)).state, 'awaiting_fx', 'לפני: awaiting_fx');
    const t = await tx({ amount: -731.4 });
    await w.acceptPair({ document_id: d._id, transaction_id: t._id });
    const s = await stateOf(d._id);
    eq(s.amount_total, 731.4, 'amount_total = שקלים מהחיוב');
    eq(s.fx_confirmed, true, 'fx_confirmed');
    eq(s.state, 'settled', 'נסגר');
    eq((await paysOf(d._id))[0].amount, 731.4, 'תשלום = החיוב');
  }

  console.log('\nדחייה ופירוק שיוך');
  {
    const d = await doc({ amount_total: 777 });
    const t = await tx({ amount: -777 });
    ok((await pairs.pairQueue()).pairs.some(p => String(p.doc._id) === String(d._id)), 'לפני: הזוג מוצע');
    await w.rejectPair({ document_id: d._id, transaction_id: t._id });
    await w.rejectPair({ document_id: d._id, transaction_id: t._id });
    eq(await ExpensePairRejection.countDocuments({ document_id: d._id }), 1, 'דחייה אידמפוטנטית');
    ok(!(await pairs.pairQueue()).pairs.some(p => String(p.doc._id) === String(d._id)), 'הזוג נעלם מהתור');

    const d2 = await doc({ amount_total: 888 });
    const t2 = await tx({ amount: -888 });
    await w.acceptPair({ document_id: d2._id, transaction_id: t2._id });
    ok(!(await poolHas(t2._id)), 'מכוסה');
    await w.unpairCharge({ document_id: d2._id, transaction_id: t2._id });
    ok(await poolHas(t2._id), 'אחרי פירוק — החיוב חוזר למאגר');
    eq((await stateOf(d2._id)).state, 'needs_match', 'המסמך חזר ל-needs_match');
    eq(await ExpensePairRejection.countDocuments({ document_id: d2._id, transaction_id: t2._id }), 1, 'נרשמה דחייה');
    ok(!(await pairs.pairQueue()).pairs.some(p => String(p.doc._id) === String(d2._id)), 'לא מוצע שוב מיד');
    await refuses(() => w.unpairCharge({ document_id: d2._id, transaction_id: t2._id }), 404, 'פירוק שאין לו שיוך');
  }

  console.log('\nלא שולם, החלטות, אישור, ביטול');
  {
    const d = await doc({ amount_total: 500 });
    await w.markUnpaid(d._id); await w.markUnpaid(d._id);
    eq((await stateOf(d._id)).lane, 'unpaid_marked', 'סומן כלא שולם');
    await w.unmarkUnpaid(d._id);
    eq((await stateOf(d._id)).lane, 'open', 'חזר ל-open');

    await w.decide(d._id, 'closed_anyway', '  ניכוי במקור ', null);
    let s = await stateOf(d._id);
    eq(s.lane, 'closed', 'closed_anyway → closed');
    eq(s.decision.note, 'ניכוי במקור', 'הערה נחתכה');
    await w.decide(d._id, 'paid_outside_bank', '', null);
    eq((await stateOf(d._id)).decision.kind, 'paid_outside_bank', 'החלטה חדשה מחליפה');
    await w.undecide(d._id);
    eq((await stateOf(d._id)).lane, 'open', 'undecide מחזיר');
    await refuses(() => w.decide(d._id, 'bogus', '', null), 400, 'סוג החלטה לא תקין');

    const r = await doc({ needs_review: true, amount_total: 10 });
    await w.confirmDocument(r._id, { amount_total: 12, doc_type: 'bogus' }).then(() => ok(false, 'doc_type רע התקבל'), e => eq(e.status, 400, 'confirm: doc_type רע → 400'));
    const c = await w.confirmDocument(r._id, { amount_total: 12 }, null);
    eq(c.needs_review, false, 'confirm: needs_review נוקה');
    eq(c.amount_total, 12, 'confirm: תיקון הוחל');
    eq((await paysOf(r._id)).length, 0, 'confirm: בלי שיוך');

    const v = await doc({ amount_total: 100 });
    const vt = await tx({ amount: -100 });
    await w.acceptPair({ document_id: v._id, transaction_id: vt._id });
    const out = await w.voidDocument(v._id, null);
    eq(out.removed_payments, 1, 'ביטול מסיר תשלומים');
    ok(await poolHas(vt._id), 'החיוב חזר למאגר');
    for (const [name, fn] of [
      ['accept', () => w.acceptPair({ document_id: v._id, transaction_id: vt._id })],
      ['reject', () => w.rejectPair({ document_id: v._id, transaction_id: vt._id })],
      ['unpair', () => w.unpairCharge({ document_id: v._id, transaction_id: vt._id })],
      ['markUnpaid', () => w.markUnpaid(v._id)],
      ['unmarkUnpaid', () => w.unmarkUnpaid(v._id)],
      ['decide', () => w.decide(v._id, 'closed_anyway', '', null)],
      ['undecide', () => w.undecide(v._id)],
      ['confirm', () => w.confirmDocument(v._id, {}, null)],
      ['void', () => w.voidDocument(v._id)],
    ]) await refuses(fn, 409, `מסמך מבוטל: ${name}`);
  }

  console.log('\nכשל באמצע — גלגול לאחור');
  {
    const d = await doc({ needs_review: true, vendor_name: 'מקורי', amount_total: 100 });
    const t = await tx({ amount: -100 });
    const orig = ExpensePayment.create;
    ExpensePayment.create = async () => { throw new Error('boom'); };
    try { await w.acceptPair({ document_id: d._id, transaction_id: t._id, review: { vendor_name: 'חדש' } }); ok(false, 'לא נכשל'); }
    catch (e) { eq(e.message, 'boom', 'השגיאה עלתה'); }
    finally { ExpensePayment.create = orig; }
    const after = await ExpenseDocument.findById(d._id).lean();
    eq(after.vendor_name, 'מקורי', 'התיקון בוטל');
    eq(after.needs_review, true, 'needs_review נשאר');
    eq((await paysOf(d._id)).length, 0, 'אין תשלום');

    const v = await doc({ amount_total: 100 });
    const vt = await tx({ amount: -100 });
    await w.acceptPair({ document_id: v._id, transaction_id: vt._id });
    const origUpd = ExpenseDocument.updateOne;
    ExpenseDocument.updateOne = () => { throw new Error('boom2'); };
    try { await w.voidDocument(v._id); ok(false, 'ביטול לא נכשל'); } catch (e) { eq(e.message, 'boom2', 'ביטול נכשל'); }
    finally { ExpenseDocument.updateOne = origUpd; }
    eq((await paysOf(v._id)).length, 1, 'ביטול שנכשל לא מחק את התשלום');
    eq((await ExpenseDocument.findById(v._id).lean()).status, 'active', 'והמסמך נשאר פעיל');
  }
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error('not loopback');
  await mongoose.connect(uri);
  await suite('שרת בודד (כתיבות מסודרות + פיצוי)');
  await mongoose.disconnect();
  await mongod.stop();

  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const ruri = rs.getUri();
  if (!/127\.0\.0\.1|localhost/.test(ruri)) throw new Error('not loopback');
  await mongoose.connect(ruri);
  await Promise.all(["ExpensePayment", "ExpensePairRejection", "ExpenseUnpaidMark", "ExpenseDocDecision", "ExpenseDocument", "BankTransaction", "BankAccount", "Supplier"].map(n => mongoose.model(n).init().catch(() => {})));
  await suite('Replica set (טרנזקציה)');
  await mongoose.disconnect();
  await rs.stop();

  console.log(failures ? `\n❌ ${failures} נכשלו` : '\n✅ הכול עבר');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
