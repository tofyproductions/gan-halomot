#!/usr/bin/env node
/**
 * Expenses — documents & pairing: the seven models and the supplier fields.
 *
 *   node scripts/expense-models.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c || !d ? '' : `  (${d})`}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const oid = () => new mongoose.Types.ObjectId();
const dupKey = async (fn) => { try { await fn(); return false; } catch (e) { return e.code === 11000; } };

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error('not loopback');
  await mongoose.connect(uri);
  const M = require('../src/models');
  const { ExpenseDocument, ExpenseFile, ExpensePayment, ExpensePairRejection,
    ExpenseUnpaidMark, ExpenseDocDecision, NoInvoiceRule, Supplier } = M;
  for (const m of [ExpenseDocument, ExpenseFile, ExpensePayment, ExpensePairRejection,
    ExpenseUnpaidMark, ExpenseDocDecision, NoInvoiceRule]) await m.init();

  console.log('\n🧾 מודלי הוצאות\n');

  console.log('ExpenseDocument');
  {
    const d = await ExpenseDocument.create({ source: 'manual', doc_date: '2026-09-10', amount_total: 118 });
    eq(d.currency, 'ILS', 'מטבע ברירת מחדל שקל');
    eq(d.fx_confirmed, true, 'שקל — שער מאושר');
    eq(d.status, 'active', 'סטטוס פעיל');
    eq(d.needs_review, false, 'לא דורש בדיקה');
    eq(d.is_general, false, 'לא כללי');
    eq(d.receipt_disposition, null, 'אין החלטת קבלה');
    ok(d.created_at instanceof Date, 'חותמות זמן');
    ok(!(await dupKey(() => ExpenseDocument.create({ source: 'manual', amount_total: 1 }))), 'שני מסמכים בלי mail_sorter_id חיים יחד');
    await ExpenseDocument.create({ source: 'mail_sorter', mail_sorter_id: 77, amount_total: 5 });
    ok(await dupKey(() => ExpenseDocument.create({ source: 'mail_sorter', mail_sorter_id: 77, amount_total: 6 })), 'אותו mail_sorter_id נדחה (E11000)');
    let bad = false;
    try { await ExpenseDocument.create({ source: 'x' }); } catch { bad = true; }
    ok(bad, 'source לא חוקי נדחה');
    const usd = await ExpenseDocument.create({ source: 'manual', currency: 'USD', amount_original: 10, amount_total: 36 });
    eq(usd.fx_confirmed, false, 'מט"ח — שער לא מאושר כברירת מחדל');
    const idx = ExpenseDocument.schema.indexes().map(([k]) => JSON.stringify(k));
    ok(idx.includes('{"status":1,"doc_date":-1}') && idx.includes('{"supplier_id":1}') && idx.includes('{"attachment_sha256":1}'), 'אינדקסים');
  }

  console.log('ExpenseFile');
  {
    const f = await ExpenseFile.create({ data: 'QUJD', name: 'a.pdf', mime: 'application/pdf', size: 3 });
    eq(f.size, 3, 'קובץ נשמר');
  }

  console.log('ExpensePayment');
  {
    const doc = oid(), tx = oid();
    const p = await ExpensePayment.create({ document_id: doc, transaction_id: tx, amount: 50 });
    eq(p.amount, 50, 'תשלום נוצר');
    ok(await dupKey(() => ExpensePayment.create({ document_id: doc, transaction_id: tx, amount: 1 })), 'זוג כפול נדחה (E11000)');
    await ExpensePayment.create({ document_id: doc, transaction_id: oid(), amount: 1 });
    ok(true, 'אותו מסמך, תנועה אחרת — מותר');
  }

  console.log('ExpensePairRejection / UnpaidMark / DocDecision');
  {
    const doc = oid(), tx = oid();
    await ExpensePairRejection.create({ document_id: doc, transaction_id: tx });
    ok(await dupKey(() => ExpensePairRejection.create({ document_id: doc, transaction_id: tx })), 'דחיית זוג כפולה נדחית');
    await ExpenseUnpaidMark.create({ document_id: doc });
    ok(await dupKey(() => ExpenseUnpaidMark.create({ document_id: doc })), 'סימון "לא שולם" ייחודי למסמך');
    const dec = await ExpenseDocDecision.create({ document_id: doc, kind: 'closed_anyway' });
    eq(dec.note, '', 'הערה ריקה כברירת מחדל');
    ok(await dupKey(() => ExpenseDocDecision.create({ document_id: doc, kind: 'paid_outside_bank' })), 'החלטה אחת למסמך');
    let bad = false;
    try { await ExpenseDocDecision.create({ document_id: oid(), kind: 'nope' }); } catch { bad = true; }
    ok(bad, 'kind לא חוקי נדחה');
  }

  console.log('NoInvoiceRule');
  {
    const r = await NoInvoiceRule.create({ label: 'ארנונה', pattern: 'ארנונה' });
    eq(r.is_active, true, 'כלל פעיל כברירת מחדל');
    eq(r.built_in, false, 'לא מובנה כברירת מחדל');
  }

  console.log('Supplier');
  {
    const s = await Supplier.create({ name: 'ספק' });
    eq(s.tax_id, '', 'tax_id ריק');
    eq(s.receipt_is_document, false, 'receipt_is_document כבוי');
  }

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n❌ ${failures} נכשלו\n` : '\n✅ הכול עבר\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
