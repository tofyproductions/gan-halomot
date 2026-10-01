#!/usr/bin/env node
/**
 * Expenses search + counts (port notes §7). Pure reads.
 *
 *   node scripts/expense-search.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c || !d ? '' : `  (${d})`}`); if (!c) failures++; };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const refuses = async (fn, status, l) => {
  try { await fn(); ok(false, `${l} — לא נזרקה שגיאה`); } catch (e) { eq(e.status, status, `${l} → ${status}`); }
};

const NOW = new Date('2026-10-01T09:00:00Z');
const daysAgo = (n) => new Date(Date.UTC(2026, 9, 1) - n * 86400000).toISOString().slice(0, 10);

async function suite() {
  console.log('\n🔎 חיפוש וספירות\n');
  const { BankAccount, BankTransaction, ExpenseDocument, ExpensePayment, ExpenseDocDecision, ExpenseUnpaidMark, Branch } = require('../src/models');
  const s = require('../src/services/expenseSearch.service');
  const core = require('../src/services/expenseCore.service');
  const pairs = require('../src/services/expensePairs.service');
  const receipts = require('../src/services/expenseReceipts.service');
  let seq = 0;
  const bank = await BankAccount.create({ external_id: 'b:1', institution: 'beinleumi', label: 'בנק', type: 'bank' });
  const card = await BankAccount.create({ external_id: 'c:1', institution: 'max', label: 'כרטיס', type: 'card' });
  const br1 = await Branch.create({ name: 'סניף 1' });
  const br2 = await Branch.create({ name: 'סניף 2' });
  const tx = (o) => BankTransaction.create({ account_id: bank._id, date: daysAgo(3), amount: -100, description: 'תנועה', hash: `h${++seq}`, ...o });
  const doc = (o) => ExpenseDocument.create({ source: 'manual', vendor_name: 'ספק', doc_type: 'tax_invoice', doc_number: `N${++seq}`, doc_date: daysAgo(5), amount_total: 100, ...o });

  console.log('search — טקסט');
  {
    const d1 = await doc({ vendor_name: 'חברת חשמל בע"מ', doc_number: 'A-22140', supplier_tax_id: '520000001', amount_total: 250, branch_id: br1._id });
    const d2 = await doc({ vendor_name: 'ספק ממתקים', doc_number: 'X1', amount_total: 100, branch_id: br2._id });
    const d3 = await doc({ vendor_name: 'ציוד a.*b', doc_number: 'X2', amount_total: 40 });
    const t1 = await tx({ description: 'העברה', counterparty: 'דוד כהן', transfer_note: 'חשבונית 7', amount: -250.5, bank_ref: 'inst:2/3' });
    await tx({ description: 'חיוב כרטיס', account_id: card._id, amount: -100 });
    await tx({ description: 'זיכוי', amount: 500 }); // money in

    const names = (r) => r.documents.map(d => d.title).sort();
    eq(names(await s.search({ q: 'חשמל' })), ['חברת חשמל בע"מ'], 'לפי שם');
    eq(names(await s.search({ q: 'חברת חשמל בעמ' })), ['חברת חשמל בע"מ'], 'בע"מ == בעמ');
    eq(names(await s.search({ q: 'a22140' })).length, 0, 'מספר מסמך עם מקף — מנורמל כמו אצל טופי (רווח)');
    eq(names(await s.search({ q: 'A-22140' })), ['חברת חשמל בע"מ'], 'לפי מספר מסמך');
    eq(names(await s.search({ q: '520000001' })), ['חברת חשמל בע"מ'], 'לפי ח.פ');
    eq(names(await s.search({ q: '.*' })), ['ציוד a.*b'], "q='.*' הוא טקסט — רק מי שמכיל אותו, לא הכול");
    eq(names(await s.search({ q: '.' })), [], "q='.' לא תופס הכול");
    eq((await s.search({ q: '(' })).documents.length, 0, 'סוגריים לא שוברים');
    eq((await s.search({})).documents.length, 3, 'בלי q — הכול');

    const c = await s.search({ q: 'דוד' });
    eq(c.charges.length, 1, 'חיוב לפי counterparty');
    eq(c.charges[0].title, 'אל: דוד כהן', 'כותרת חיוב');
    eq(c.charges[0].subtitle, 'בנק · תשלום 2 מתוך 3 · הערה: חשבונית 7 · העברה', 'כותרת משנה');
    eq(c.charges[0].amount, 250.5, 'סכום מוחלט');
    eq(c.charges[0].lane, 'pair', 'מסלול pair');
    eq((await s.search({ q: 'חיוב כרטיס' })).charges[0].kind, 'card', 'כרטיס');
    eq((await s.search({})).charges.length, 2, 'הכנסה לא נכללת');

    console.log('search — סכום וסניף');
    eq(names(await s.search({ min: 100, max: 250 })), ['חברת חשמל בע"מ', 'ספק ממתקים'], 'טווח כולל בשני הקצוות');
    eq(names(await s.search({ min: 100.01 })), ['חברת חשמל בע"מ'], 'מינימום מעל');
    eq(names(await s.search({ max: 99.99 })), ['ציוד a.*b'], 'מקסימום מתחת');
    eq((await s.search({ min: 100, max: 100 })).charges.length, 1, 'טווח חיובים על |סכום|');
    eq(names(await s.search({ branch: String(br1._id) })), ['חברת חשמל בע"מ'], 'סינון סניף במסמכים');
    eq((await s.search({ branch: String(br1._id) })).charges, [], 'חיובים אין להם סניף');
    await refuses(() => s.search({ min: 'abc' }), 400, 'סכום לא מספרי');
    await refuses(() => s.search({ branch: 'zzz' }), 400, 'סניף לא תקין');

    console.log('search — מסלול חיוב ומגבלה');
    await ExpensePayment.create({ document_id: d1._id, transaction_id: t1._id, amount: 250 });
    eq((await s.search({ q: 'דוד' })).charges[0].lane, 'closed', 'חיוב מקושר = closed');
    const ex = await tx({ description: 'עמלה על פעולה', amount: -5 });
    const noInv = require('../src/services/noInvoiceRules.service');
    await noInv.seed();
    eq((await s.search({ q: 'עמלה על פעולה' })).charges[0].lane, 'no_invoice', 'חיוב פטור');
    await tx({ description: 'פנימי', is_internal_transfer: true });
    eq((await s.search({ q: 'פנימי' })).charges[0].lane, null, 'פנימי — מחוץ למסך');
    await ExpenseDocument.deleteMany({}); await ExpensePayment.deleteMany({}); await BankTransaction.deleteMany({});
    await Promise.all(Array.from({ length: 205 }, (_, i) => doc({ doc_number: `L${i}`, vendor_name: 'מוצר' })));
    eq((await s.search({ q: 'מוצר' })).documents.length, 200, 'מוגבל ל-200');
    await ExpenseDocument.deleteMany({});
  }

  console.log('counts — נגזר מאותן פונקציות');
  {
    const inv = await doc({ vendor_name: 'חשמל', amount_total: 100 });
    await tx({ description: 'חשמל', amount: -100, date: daysAgo(4) });          // pairs with inv
    await doc({ needs_review: true, vendor_name: 'אחר', amount_total: 77 });    // review
    await doc({ doc_type: 'receipt', doc_date: daysAgo(20), amount_total: 33 }); // overdue receipt
    await doc({ doc_type: 'receipt', doc_date: daysAgo(2), amount_total: 34 });  // waiting receipt
    const closed = await doc({ vendor_name: 'סגור', amount_total: 10 });
    await ExpenseDocDecision.create({ document_id: closed._id, kind: 'closed_anyway' });
    const unp = await doc({ vendor_name: 'לא שולם', amount_total: 11 });
    await ExpenseUnpaidMark.create({ document_id: unp._id });

    const c = await s.counts(NOW);
    const q = await pairs.pairQueue();
    const docs = await core.documentsWithState();
    const lane = await receipts.receiptsLane(NOW);
    eq(c.pair, q.pairs.length, 'pair = pairQueue');
    ok(c.pair >= 1, 'יש זוג מוצע');
    eq(c.review, docs.filter(d => d.lane === 'review').length, 'review');
    eq(c.review, 1, 'review = 1');
    eq(c.receipts, lane.waiting.length, 'receipts = waiting');
    eq(c.receipts, 2, 'שתי קבלות');
    eq(c.overdue, 1, 'אחת באיחור');
    eq(c.closed, 1, 'closed');
    eq(c.unpaid_marked, 1, 'unpaid_marked');
    const before = [await ExpenseDocument.countDocuments(), await ExpensePayment.countDocuments(), await BankTransaction.countDocuments()];
    await s.counts(NOW); await s.search({ q: 'חשמל' });
    eq([await ExpenseDocument.countDocuments(), await ExpensePayment.countDocuments(), await BankTransaction.countDocuments()], before, 'אין כתיבות');
    void inv;
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
