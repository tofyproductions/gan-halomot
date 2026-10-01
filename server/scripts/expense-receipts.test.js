#!/usr/bin/env node
/**
 * Expenses receipts — lane (pure read), candidates, link/unlink, exempt
 * supplier, move payments (port notes §5.5–§5.8). Runs on a standalone
 * server and on a replica set.
 *
 *   node scripts/expense-receipts.test.js
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

const NOW = new Date('2026-10-01T09:00:00Z');
const daysAgo = (n) => new Date(Date.UTC(2026, 9, 1) - n * 86400000).toISOString().slice(0, 10);

async function suite(label) {
  console.log(`\n🧾 קבלות — ${label}\n`);
  const { BankAccount, BankTransaction, ExpenseDocument, ExpensePayment, Supplier } = require('../src/models');
  const core = require('../src/services/expenseCore.service');
  const w = require('../src/services/expenseWrites.service');
  const r = require('../src/services/expenseReceipts.service');
  await Promise.all([BankTransaction, ExpenseDocument, ExpensePayment, Supplier].map(m => m.deleteMany({})));
  let seq = 0;
  const bank = await BankAccount.findOne({ external_id: 'b:1' }) || await BankAccount.create({ external_id: 'b:1', institution: 'beinleumi', label: 'בנק', type: 'bank' });
  const tx = (o) => BankTransaction.create({ account_id: bank._id, date: '2026-09-10', amount: -100, description: 'תנועה', hash: `h${label}${++seq}`, ...o });
  const doc = (o) => ExpenseDocument.create({ source: 'manual', vendor_name: 'ספק', doc_type: 'tax_invoice', doc_number: `N${label}${++seq}`, doc_date: daysAgo(5), amount_total: 100, ...o });
  const rec = (o) => doc({ doc_type: 'receipt', ...o });
  const pay = (d, t, amount) => ExpensePayment.create({ document_id: d._id, transaction_id: t._id, amount });
  const reset = () => Promise.all([BankTransaction, ExpenseDocument, ExpensePayment, Supplier].map(m => m.deleteMany({})));

  console.log('receiptsLane — גבולות ותוכן');
  {
    const r13 = await rec({ doc_date: daysAgo(13) });
    const r14 = await rec({ doc_date: daysAgo(14) });
    const inv = await doc({ vendor_name: 'חברת חשמל' });
    const linked = await rec({ doc_date: daysAgo(30), linked_invoice_id: inv._id, receipt_disposition: 'has_invoice' });
    const oldLinked = await rec({ doc_date: daysAgo(90), linked_invoice_id: inv._id, receipt_disposition: 'has_invoice' });
    await rec({ doc_date: daysAgo(600) });
    const isDoc = await rec({ receipt_disposition: 'is_document' });
    const voided = await rec({ status: 'void' });
    await doc({ doc_type: 'invoice_receipt' });
    const lane = await r.receiptsLane(NOW);
    const ids = (a) => a.map(x => String(x.id));
    ok(ids(lane.waiting).includes(String(r13._id)) && ids(lane.waiting).includes(String(r14._id)), 'שתי הקבלות ממתינות');
    ok(!ids(lane.overdue).includes(String(r13._id)), '13 ימים — לא באיחור');
    ok(ids(lane.overdue).includes(String(r14._id)), '14 ימים — באיחור');
    eq(lane.waiting.find(x => String(x.id) === String(r14._id)).days_waiting, 14, 'days_waiting');
    eq(lane.waiting.length, 2, 'ממתינות: רק 2 (בלי מקושרת, ישנה מ-540, פטורה, מבוטלת, חשבונית-קבלה)');
    eq(lane.linkedRecently.length, 1, 'מקושרת אחרונה: אחת (60 יום)');
    eq(String(lane.linkedRecently[0].id), String(linked._id), 'היא המקושרת מלפני 30 יום');
    eq(lane.linkedRecently[0].linked_invoice.vendor_name, 'חברת חשמל', 'פרטי החשבונית המקושרת');
    ok(!ids(lane.linkedRecently).includes(String(oldLinked._id)), 'מקושרת מלפני 90 — לא');
    ok(![isDoc, voided].some(x => ids(lane.waiting).includes(String(x._id))), 'is_document ומבוטלת לא ברשימה');
    eq(lane.grace_days, 14, 'grace_days');
  }

  console.log('receiptsLane — קריאה טהורה, אפס כתיבות');
  {
    const t = await tx({});
    const rc = await rec({ doc_date: daysAgo(20) });
    await pay(rc, t, 100);
    const snap = async () => JSON.stringify({
      d: (await ExpenseDocument.find().sort({ _id: 1 }).lean()).map(x => [x._id, x.updated_at, x.linked_invoice_id, x.receipt_disposition]),
      p: (await ExpensePayment.find().sort({ _id: 1 }).lean()).map(x => [x._id, x.updated_at, x.document_id]),
      n: [await ExpenseDocument.countDocuments(), await ExpensePayment.countDocuments(), await Supplier.countDocuments(), await BankTransaction.countDocuments()],
    });
    const before = await snap();
    await new Promise(res => setTimeout(res, 20));
    const l1 = await r.receiptsLane(NOW);
    const l2 = await r.receiptsLane(NOW);
    await r.invoiceCandidates(rc._id);
    eq(await snap(), before, 'אחרי שתי קריאות ומועמדים — שום דבר לא השתנה');
    eq(JSON.stringify(l1), JSON.stringify(l2), 'אותה תוצאה בשתי קריאות');
    const row = l1.waiting.find(x => String(x.id) === String(rc._id));
    eq(row.payments.length, 1, 'חיוב תלוי על הקבלה מוצג');
    eq(row.payments[0].amount, 100, 'עם הסכום');
    eq(row.payments[0].description, 'תנועה', 'ותיאור התנועה');
  }

  console.log('invoiceCandidates');
  {
    await reset();
    const rc = await rec({ vendor_name: 'חשמל בע"מ', doc_date: '2026-09-15', amount_total: 100 });
    const exactNear = await doc({ vendor_name: 'חשמל', doc_date: '2026-09-10', amount_total: 100 });
    const exactFar = await doc({ vendor_name: 'חשמל', doc_date: '2026-07-20', amount_total: 100 });
    const supplierOnly = await doc({ vendor_name: 'חשמל', doc_date: '2026-09-14', amount_total: 555 });
    const amountOnly = await doc({ vendor_name: 'אחר לגמרי', doc_date: '2026-09-14', amount_total: 100.5 });
    await doc({ vendor_name: 'אחר לגמרי', doc_date: '2026-09-14', amount_total: 555 });
    await doc({ vendor_name: 'חשמל', doc_date: '2026-03-01', amount_total: 100 });
    await doc({ vendor_name: 'חשמל', doc_date: '2026-09-14', amount_total: 100, status: 'void' });
    await rec({ vendor_name: 'חשמל', doc_date: '2026-09-14', amount_total: 100 });
    const c = await r.invoiceCandidates(rc._id);
    const ids = c.map(x => String(x.id));
    eq(ids.length, 4, 'ארבעה מועמדים (בלי רנדומלי, רחוק מ-120, מבוטל, קבלה)');
    eq(ids[0], String(exactNear._id), 'ראשון: ספק+סכום, קרוב');
    eq(ids[1], String(exactFar._id), 'שני: ספק+סכום, רחוק יותר');
    eq(ids[2], String(supplierOnly._id), 'שלישי: ספק בלבד');
    eq(ids[3], String(amountOnly._id), 'רביעי: סכום בלבד');
    eq(c[0].why, 'אותו ספק · אותו סכום', 'why');
    eq((await r.invoiceCandidates(rc._id, 2)).length, 2, 'limit');
    await refuses(() => r.invoiceCandidates(exactNear._id), 400, 'מסמך שאינו קבלה');
    await refuses(() => r.invoiceCandidates(new mongoose.Types.ObjectId()), 404, 'לא קיימת');
  }

  console.log('linkReceipt / unlinkReceipt');
  {
    await reset();
    const inv = await doc({ vendor_name: 'ספק א' });
    const rc = await rec({ vendor_name: 'ספק א' });
    const t1 = await tx({ amount: -60 }); const t2 = await tx({ amount: -40 });
    await pay(rc, t1, 60); await pay(rc, t2, 40);
    const by = new mongoose.Types.ObjectId();
    const res = await r.linkReceipt(rc._id, inv._id, by);
    eq(res.moved, 2, 'שני תשלומים הועברו');
    const rd = await ExpenseDocument.findById(rc._id).lean();
    eq(String(rd.linked_invoice_id), String(inv._id), 'linked_invoice_id');
    eq(rd.receipt_disposition, 'has_invoice', 'receipt_disposition');
    ok(!!rd.receipt_disposition_at, 'receipt_disposition_at');
    eq((await ExpensePayment.find({ document_id: rc._id })).length, 0, 'לקבלה לא נשארו תשלומים');
    const ip = await ExpensePayment.find({ document_id: inv._id }).lean();
    eq(ip.length, 2, 'לחשבונית יש שני תשלומים');
    eq(ip.reduce((s, p) => s + p.amount, 0), 100, 'באותם סכומים');
    eq((await core.documentsWithState()).find(d => String(d._id) === String(inv._id)).lane, 'closed', 'החשבונית נסגרה');
    eq((await r.receiptsLane(NOW)).linkedRecently.length, 1, 'הקבלה ב"מקושרות לאחרונה"');

    await r.unlinkReceipt(rc._id);
    const ud = await ExpenseDocument.findById(rc._id).lean();
    ok(ud.linked_invoice_id == null && ud.receipt_disposition == null && ud.receipt_disposition_at == null, 'ניתוק מנקה שדות');
    eq((await ExpensePayment.find({ document_id: inv._id })).length, 2, 'התשלומים נשארים בחשבונית');
    await refuses(() => r.unlinkReceipt(rc._id), 409, 'ניתוק קבלה לא מקושרת');

    // keep-both on a duplicate transaction
    const inv2 = await doc({}); const rc2 = await rec({}); const t3 = await tx({ amount: -100 });
    await pay(rc2, t3, 100); await pay(inv2, t3, 100);
    const res2 = await r.linkReceipt(rc2._id, inv2._id, by);
    eq(res2.kept, 1, 'כפילות: נשמרו שניהם');
    eq((await ExpensePayment.find({ document_id: rc2._id })).length, 1, 'התשלום נשאר על הקבלה');
    eq((await ExpensePayment.find({ document_id: inv2._id })).length, 1, 'ולא הוכפל בחשבונית');

    await refuses(() => r.linkReceipt(rc._id, rc._id), 400, 'קבלה לעצמה');
    const other = await rec({});
    await refuses(() => r.linkReceipt(rc._id, other._id), 400, 'קבלה לקבלה');
    await refuses(() => r.linkReceipt(rc._id, new mongoose.Types.ObjectId()), 404, 'חשבונית לא קיימת');
    await refuses(() => r.linkReceipt(inv._id, inv2._id), 400, 'המקור אינו קבלה');
    await refuses(() => r.linkReceipt('zzz', inv._id), 400, 'מזהה לא תקין');
    const vInv = await doc({ status: 'void' });
    await refuses(() => r.linkReceipt(rc._id, vInv._id), 404, 'חשבונית מבוטלת');
  }

  console.log('movePaymentsPlan / applyMovePayments');
  {
    await reset();
    const inv = await doc({}); const rc = await rec({ linked_invoice_id: inv._id, receipt_disposition: 'has_invoice' });
    const ta = await tx({ amount: -70 }); const tb = await tx({ amount: -30 });
    await pay(rc, ta, 70); await pay(rc, tb, 30); await pay(inv, tb, 30);
    const plan = await r.movePaymentsPlan();
    eq(plan.length, 2, 'תוכנית: שתי שורות');
    eq(plan.find(p => String(p.transaction_id) === String(ta._id)).action, 'move', 'move');
    eq(plan.find(p => String(p.transaction_id) === String(tb._id)).action, 'keep_both', 'keep_both');
    eq(await ExpensePayment.countDocuments(), 3, 'התוכנית לא כתבה');
    const res = await r.applyMovePayments(null);
    eq(res.moved, 1, 'הוחל: אחד הועבר'); eq(res.kept, 1, 'ואחד נשמר');
    eq(await ExpensePayment.countDocuments({ document_id: inv._id }), 2, 'לחשבונית שני תשלומים');
  }

  console.log('מעבר תשלומים לא מתחרה בשיוך');
  {
    await reset();
    const inv = await doc({ amount_total: 100 }); const rc = await rec({ amount_total: 100 });
    const t = await tx({ amount: -100 }); await pay(rc, t, 100);
    const d2 = await doc({ amount_total: 100 });
    const outcomes = await Promise.allSettled([
      r.linkReceipt(rc._id, inv._id, null),
      w.acceptPair({ document_id: d2._id, transaction_id: t._id }),
    ]);
    ok(outcomes[0].status === 'fulfilled', 'הקישור הצליח');
    eq(await ExpensePayment.countDocuments({ transaction_id: t._id }), 1, 'על החיוב תשלום אחד בלבד (בלי כיסוי כפול)');
  }

  console.log('ספק פטור / קבלה כמסמך');
  {
    await reset();
    const sup = await Supplier.create({ name: 'עמותה', tax_id: '580000001' });
    const a = await rec({ supplier_id: sup._id, vendor_name: 'עמותה' });
    const b = await rec({ supplier_id: sup._id, vendor_name: 'עמותה', doc_date: daysAgo(30) });
    const other = await rec({ vendor_name: 'אחר' });
    eq((await r.receiptsLane(NOW)).waiting.length, 3, 'לפני: שלוש ממתינות');
    const res = await r.setSupplierReceiptIsDocument(sup._id, true, null);
    eq(res.receipt_is_document, true, 'הדגל נקבע');
    const lane = await r.receiptsLane(NOW);
    eq(lane.waiting.length, 1, 'אחרי: רק של הספק האחר');
    eq(String(lane.waiting[0].id), String(other._id), 'היא של האחר');
    const st = await core.documentsWithState();
    eq(st.find(d => String(d._id) === String(a._id)).lane, 'open', 'קבלה של ספק פטור נעשית open');
    eq(st.find(d => String(d._id) === String(b._id)).lane, 'open', 'גם הישנה');
    await r.setSupplierReceiptIsDocument(sup._id, false, null);
    eq((await r.receiptsLane(NOW)).waiting.length, 3, 'ביטול החזיר אותן');
    await refuses(() => r.setSupplierReceiptIsDocument(new mongoose.Types.ObjectId(), true), 404, 'ספק לא קיים');
    await refuses(() => r.setSupplierReceiptIsDocument('zzz', true), 400, 'מזהה לא תקין');

    await r.markReceiptIsDocument(other._id, null);
    const od = await ExpenseDocument.findById(other._id).lean();
    eq(od.receipt_disposition, 'is_document', 'receipt_disposition=is_document');
    ok(!!od.receipt_disposition_at, 'receipt_disposition_at');
    eq((await core.documentsWithState()).find(d => String(d._id) === String(other._id)).lane, 'open', 'הבודדת נעשית open');
    eq((await r.receiptsLane(NOW)).waiting.length, 2, 'ויצאה מהמסלול');
    await refuses(() => r.markReceiptIsDocument(new mongoose.Types.ObjectId()), 404, 'לא קיימת');
    const notReceipt = await doc({});
    await refuses(() => r.markReceiptIsDocument(notReceipt._id), 400, 'לא קבלה');
  }
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error('not loopback');
  await mongoose.connect(uri);
  await suite('שרת בודד');
  await mongoose.disconnect();
  await mongod.stop();

  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const ruri = rs.getUri();
  if (!/127\.0\.0\.1|localhost/.test(ruri)) throw new Error('not loopback');
  await mongoose.connect(ruri);
  await Promise.all(['ExpensePayment', 'ExpenseDocument', 'BankTransaction', 'BankAccount', 'Supplier'].map(n => mongoose.model(n).init().catch(() => {})));
  await suite('Replica set (טרנזקציה)');
  await mongoose.disconnect();
  await rs.stop();

  console.log(failures ? `\n❌ ${failures} נכשלו` : '\n✅ הכול עבר');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
