#!/usr/bin/env node
/**
 * Expenses ↔ orders link (spec §9): candidates, link/unlink, mismatch.
 *
 *   node scripts/expense-orders.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c || !d ? '' : `  (${d})`}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const refuses = async (fn, status, l) => {
  try { await fn(); ok(false, `${l} — לא נזרקה שגיאה`); } catch (e) { eq(e.status, status, `${l} → ${status}`); }
};

async function suite() {
  console.log('\n📦 קישור להזמנה\n');
  const { ExpenseDocument, Order, Supplier, Branch } = require('../src/models');
  const o = require('../src/services/expenseOrders.service');
  let seq = 0;
  const sup = await Supplier.create({ name: 'ספק א', vat_rate: 1.18 });
  const sup2 = await Supplier.create({ name: 'ספק ב' });
  const br = await Branch.create({ name: 'סניף 1' });
  const at = (ymd) => new Date(`${ymd}T10:00:00Z`);
  const order = (x) => Order.create({
    order_number: `O${++seq}`, branch_id: br._id, supplier_id: sup._id, status: 'received',
    items: [], total_amount: 100, received_at: at('2026-09-10'), ...x,
  });
  const doc = (x) => ExpenseDocument.create({
    source: 'manual', vendor_name: 'ספק א', supplier_id: sup._id, doc_type: 'tax_invoice',
    doc_number: `D${++seq}`, doc_date: '2026-09-15', amount_total: 100, ...x,
  });

  console.log('orderCandidates');
  {
    const d = await doc({});
    const good = await order({ total_amount: 100 });
    await order({ supplier_id: sup2._id });
    await order({ status: 'cancelled' });
    await order({ status: 'draft' });
    await order({ received_at: at('2026-05-01') });            // doc 137 days after
    await order({ received_at: at('2026-10-20') });            // doc 35 days BEFORE order
    const near = await order({ total_amount: 130, received_at: at('2026-09-01') });
    let list = await o.orderCandidates(d._id);
    eq(list.length, 2, 'רק ספק נכון, סטטוס נכון, בתוך החלון');
    eq(String(list[0].order._id), String(good._id), 'הקטן ביותר בהפרש ראשון');
    eq(list[0].diff, 0, 'diff 0');
    eq(String(list[1].order._id), String(near._id), 'השנייה');
    eq(list[1].diff, -30, 'diff = מסמך פחות הזמנה');

    const edgeBefore = await order({ received_at: at('2026-10-14') }); // doc 29 days before order: in
    const edgeAfter = await order({ received_at: at('2026-07-17') });  // doc 60 days after order: in
    const outAfter = await order({ received_at: at('2026-07-16') });   // 61 days: out
    list = await o.orderCandidates(d._id);
    const ids = list.map(x => String(x.order._id));
    ok(ids.includes(String(edgeBefore._id)) && ids.includes(String(edgeAfter._id)), 'שולי החלון בפנים');
    ok(!ids.includes(String(outAfter._id)), '61 ימים — בחוץ');

    const noRec = await order({ received_at: null, created_at: at('2026-09-12'), total_amount: 101 });
    list = await o.orderCandidates(d._id);
    ok(list.some(x => String(x.order._id) === String(noRec._id)), 'בלי received_at — לפי created_at');

    await Order.deleteMany({}); await ExpenseDocument.deleteMany({});
    await refuses(() => o.orderCandidates('zzz'), 400, 'מזהה לא תקין');
    await refuses(() => o.orderCandidates(new mongoose.Types.ObjectId()), 404, 'מסמך לא קיים');
  }

  console.log('סכום להשוואה — הכמות שהתקבלה קובעת (מחיר כולל מע״מ, בלי הכפלה)');
  {
    const d = await doc({ amount_total: 59 });
    const partial = await order({
      total_amount: 118,
      items: [{ name: 'א', qty: 10, unit_price: 11.8, total: 118, qty_received: 5 },
        { name: 'ב', qty: 4, unit_price: 0, total: 0, qty_received: 0 }],
    });
    const none = await order({ total_amount: 77, items: [{ name: 'א', qty: 1, unit_price: 77, total: 77, qty_received: 0 }] });
    const list = await o.orderCandidates(d._id);
    const p = list.find(x => String(x.order._id) === String(partial._id));
    const n = list.find(x => String(x.order._id) === String(none._id));
    eq(p.compare_amount, 59, 'Σ qty_received×unit_price = 59');
    eq(n.compare_amount, 77, 'בלי קבלה — total_amount');
    eq(String(list[0].order._id), String(partial._id), 'ההזמנה שהתקבלה חלקית הכי קרובה');
    eq(o.orderMismatch(d, partial.toObject()).warning, null, 'אין אזהרה');
    await Order.deleteMany({}); await ExpenseDocument.deleteMany({});
  }

  console.log('orderMismatch');
  {
    const ord = await order({ total_amount: 100 });
    eq(o.orderMismatch({ amount_total: 102 }, ord.toObject()).warning, null, 'בדיוק 2 ₪ — בלי אזהרה');
    const hi = o.orderMismatch({ amount_total: 150 }, ord.toObject());
    eq(hi.diff, 50, 'diff 50');
    eq(hi.warning, 'החשבונית גבוהה ב-50 ₪ ממה שהתקבל', 'טקסט האזהרה');
    ok(/נמוכה ב-20 ₪/.test(o.orderMismatch({ amount_total: 80 }, ord.toObject()).warning), 'נמוכה');
    await Order.deleteMany({});
  }

  console.log('linkOrder / unlinkOrder');
  {
    const ord = await order({});
    const d = await doc({});
    const res = await o.linkOrder(d._id, ord._id, null);
    eq(String(res.document.order_id), String(ord._id), 'order_id נקבע');
    eq(String(res.document.branch_id), String(br._id), 'סניף מולא מההזמנה');
    eq(res.warning, null, 'בלי אזהרה');

    const d2 = await doc({});
    await refuses(() => o.linkOrder(d2._id, ord._id, null), 409, 'חשבונית שנייה על אותה הזמנה');
    const rcpt = await doc({ doc_type: 'receipt' });
    ok(!!(await o.linkOrder(rcpt._id, ord._id, null)), 'קבלה אינה חשבונית — מותר');
    await o.linkOrder(d._id, ord._id, null);
    ok(true, 'קישור חוזר של אותו מסמך — שקט');
    await ExpenseDocument.updateOne({ _id: d._id }, { status: 'void' });
    ok(!!(await o.linkOrder(d2._id, ord._id, null)), 'מסמך מבוטל משחרר את ההזמנה');

    const other = await order({ supplier_id: sup2._id });
    const d3 = await doc({});
    await refuses(() => o.linkOrder(d3._id, other._id, null), 409, 'ספק אחר');
    const draft = await order({ status: 'draft' });
    await refuses(() => o.linkOrder(d3._id, draft._id, null), 409, 'סטטוס לא נשלח');
    await refuses(() => o.linkOrder(d3._id, new mongoose.Types.ObjectId(), null), 404, 'הזמנה לא קיימת');
    await refuses(() => o.linkOrder(d3._id, 'zzz', null), 400, 'מזהה לא תקין');

    const br2 = await Branch.create({ name: 'סניף 2' });
    const keep = await doc({ branch_id: br2._id });
    const gen = await doc({ is_general: true });
    const o2 = await order({}); const o3 = await order({});
    eq(String((await o.linkOrder(keep._id, o2._id, null)).document.branch_id), String(br2._id), 'סניף קיים לא נדרס');
    eq((await o.linkOrder(gen._id, o3._id, null)).document.branch_id, null, 'כללי — בלי סניף');

    const un = await o.unlinkOrder(keep._id);
    eq(un.order_id, null, 'unlink מנקה');
    await refuses(() => o.unlinkOrder(keep._id), 409, 'לא מקושר');
  }
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error('not loopback');
  await mongoose.connect(uri);
  await suite();
  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n❌ ${failures} נכשלו` : '\n✅ הכול עבר');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
