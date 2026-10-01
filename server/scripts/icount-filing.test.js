#!/usr/bin/env node
/**
 * Filing to iCount + "report paid" (spec §4-§5, port notes §7-§9). The real
 * client runs over a fake transport that records every call; nothing reaches
 * the network. The point of most checks: /expense/create is never called in a
 * preview, on an adopt, or on any refused gate.
 *
 *   node scripts/icount-filing.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

const assert = require('assert');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c || !d ? '' : `  (${d})`}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const deepEq = (a, b, l) => {
  try { assert.deepStrictEqual(a, b); ok(true, l); } catch { ok(false, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`); }
};
/** Refused with this status and code; → the error (or null). */
const refuses = async (fn, status, code, l) => {
  try { await fn(); ok(false, `${l} — לא נזרקה שגיאה`); return null; } catch (e) {
    ok(e.status === status && e.code === code, `${l} → ${status} ${code}`, `קיבלנו ${e.status} ${e.code}: ${e.message}`);
    return e;
  }
};

const TAX_A = '510000011'; // valid check digit
const TAX_B = '510000094';

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error('not loopback');
  await mongoose.connect(uri);
  const {
    ExpenseDocument, ExpensePayment, ExpenseDocDecision, ExpenseUnpaidMark, IcountExpense, IcountPaidReport,
    Setting, Supplier, BankAccount, BankTransaction,
  } = require('../src/models');
  const filing = require('../src/services/icountFiling.service');
  const { createIcountClient, BASE } = require('../src/services/ganIcount.client');
  const { clearSupplierCache } = require('../src/services/icountSuppliers.service');
  await Promise.all([ExpenseDocument.init(), ExpensePayment.init(), IcountExpense.init(), IcountPaidReport.init()]);
  await Setting.findOneAndUpdate({ key: 'expenses_start_date' }, { $set: { value: '2026-09-01' } }, { upsert: true });

  // ── fake iCount: the real client over a recording transport ──────────────
  const SUPPLIERS = [
    { supplier_id: 11, supplier_name: 'חשמל ישראל', vat_id: TAX_A },
    { supplier_id: 22, supplier_name: 'Google Ireland', vat_id: '' },
  ];
  let created = 900;
  function fakeIcount({ configured = true, handlers = {} } = {}) {
    const calls = [];
    const h = {
      '/auth/login': () => ({ status: true, sid: 'S1' }),
      '/supplier/get_list': () => ({ status: true, total_count: SUPPLIERS.length, results_list: SUPPLIERS }),
      '/expense/search': () => ({ status: true, total_count: 0, results_list: [] }),
      '/expense/create': () => { const n = created++; return { status: true, expense_id: `E${n}`, docnum: String(n - 823) }; },
      '/expense/update': () => ({ status: true }),
      ...handlers,
    };
    const transport = async ({ url, form }) => {
      const method = url.slice(BASE.length);
      const params = Object.fromEntries([...form.entries()].filter(([k]) => k !== 'sid'));
      calls.push({ method, params });
      if (!h[method]) throw new Error(`unexpected ${method}`);
      const out = await h[method](params);
      return typeof out === 'string' ? { httpStatus: 200, text: out } : { httpStatus: 200, text: JSON.stringify(out) };
    };
    const credentials = configured ? { companyId: 'c', user: 'u', pass: 'p' } : { companyId: '', user: '', pass: '' };
    const client = createIcountClient({ transport, credentials });
    return {
      client,
      calls,
      of: (m) => calls.filter(c => c.method === m),
      creates: () => calls.filter(c => c.method === '/expense/create').length,
      writes: () => calls.filter(c => c.method === '/expense/create' || c.method === '/expense/update').length,
    };
  }

  let seq = 0;
  const bank = await BankAccount.create({ external_id: 'b:1', institution: 'beinleumi', label: 'בינלאומי', type: 'bank' });
  const tx = (o) => BankTransaction.create({ account_id: bank._id, date: '2026-09-12', amount: -100, description: 'תנועה', hash: `h${++seq}`, ...o });
  const doc = (o) => ExpenseDocument.create({
    source: 'mail_sorter', mail_sorter_id: ++seq, vendor_name: 'חשמל ישראל בע"מ', supplier_tax_id: TAX_A,
    doc_type: 'tax_invoice', doc_number: `INV-${seq}`, doc_date: '2026-09-10', amount_total: 100, ...o,
  });
  const pay = async (d, amount = d.amount_total, txo = {}) => {
    const t = await tx({ amount: -amount, ...txo });
    await ExpensePayment.create({ document_id: d._id, transaction_id: t._id, amount });
    return t;
  };
  /** A document in the closed lane (covered by a bank charge). */
  const closedDoc = async (o) => { const d = await doc(o); await pay(d); return d; };
  const setType = (v) => (v == null
    ? Setting.deleteOne({ key: 'icount_expense_type_id' })
    : Setting.findOneAndUpdate({ key: 'icount_expense_type_id' }, { $set: { value: v } }, { upsert: true }));
  const fresh = (d) => ExpenseDocument.findById(d._id).lean();
  const reset = async () => {
    clearSupplierCache();
    await Promise.all([ExpenseDocument, ExpensePayment, ExpenseDocDecision, ExpenseUnpaidMark, IcountExpense, IcountPaidReport, Supplier, BankTransaction]
      .map(m => m.deleteMany({})));
    await setType(2);
  };
  const by = new mongoose.Types.ObjectId();
  const EXACT_KEYS = ['supplier_id', 'expense_type_id', 'expense_doctype', 'expense_docnum', 'expense_sum', 'expense_date', 'currency_code'];

  console.log('\n⬆️  העלאה לאייקאונט ועדכון ששולם\n');

  console.log('fileBlockers (spec §4)');
  {
    const fb = filing.fileBlockers;
    const good = { doc_type: 'tax_invoice', currency: 'ILS', fx_confirmed: true, supplier_tax_id: TAX_A, doc_number: 'A1', doc_date: '2026-09-10', amount_total: 50 };
    const ctx = { expense_type_id: 2, icount: { configured: true, complete: true, supplier: { id: '11', name: 'חשמל' } } };
    deepEq(fb(good, ctx), [], 'מסמך תקין — אין חוסמים');
    ok(/USD/.test(fb({ ...good, currency: 'USD', fx_confirmed: false, amount_original: 20 }, ctx)[0] || ''), 'מט״ח לא מאושר — החוסם הראשון');
    eq(fb({ ...good, currency: 'USD', fx_confirmed: false, supplier_tax_id: '' }, ctx).length, 1, 'מט״ח: לא דורשים ח.פ מספק מחו״ל');
    eq(fb({ ...good, currency: 'USD', fx_confirmed: true, supplier_tax_id: '' }, ctx).length, 0, 'מט״ח מאושר בלי ח.פ — עובר');
    ok(fb({ ...good, supplier_tax_id: '' }, ctx).some(b => /עוסק/.test(b)), 'אין מספר עוסק (שקלים)');
    ok(fb({ ...good, doc_number: ' ' }, ctx).some(b => /מספר מסמך/.test(b)), 'אין מספר מסמך');
    ok(fb({ ...good, amount_total: 0 }, ctx).some(b => /סכום/.test(b)), 'סכום 0');
    ok(fb({ ...good, amount_total: -5 }, ctx).some(b => /סכום/.test(b)), 'סכום שלילי');
    ok(fb({ ...good, doc_date: '' }, ctx).some(b => /תאריך/.test(b)), 'אין תאריך מסמך');
    ok(fb({ ...good, doc_type: 'receipt' }, ctx).some(b => /קבלה/.test(b)), 'קבלה בלי החלטה — חסומה');
    ok(fb({ ...good, doc_type: 'receipt', receipt_disposition: 'has_invoice' }, ctx).some(b => /החשבונית עצמה/.test(b)), 'קבלה של חשבונית — חסומה');
    deepEq(fb({ ...good, doc_type: 'receipt', receipt_disposition: 'is_document' }, ctx), [], 'קבלה שהיא המסמך — עוברת');
    deepEq(fb({ ...good, doc_type: 'receipt' }, { ...ctx, supplier: { receipt_is_document: true } }), [], 'ספק פטור (קבלה היא המסמך) — עוברת');
    ok(fb({ ...good, doc_type: 'weird' }, ctx).some(b => /סוג מסמך/.test(b)), 'סוג מסמך לא מוכר');
    ok(fb(good, { ...ctx, expense_type_id: null }).some(b => /סוג ההוצאה/.test(b)), 'סוג הוצאה לא הוגדר');
    ok(fb(good, { ...ctx, icount: { configured: true, complete: false, supplier: null } })
      .includes('רשימת הספקים מאייקאונט לא נקראה במלואה — נסו שוב'), 'רשימת ספקים חלקית');
    ok(fb(good, { ...ctx, icount: { configured: true, complete: true, supplier: null } }).some(b => /הספק לא קיים באייקאונט/.test(b)), 'ספק לא באייקאונט');
    ok(fb(good, { ...ctx, icount: { configured: false } }).some(b => /לא מחובר/.test(b)), 'לא מחובר');
    deepEq(fb(good, { expense_type_id: 2 }), [], 'בלי הקשר אייקאונט — רק בדיקות המסמך');
    eq(fb({ ...good, doc_type: 'tax_invoice', vat_amount: 0 }, ctx).length, 0, 'אין חוסם "חשבונית בלי מע״מ" (הגן לא מקזז)');
  }

  console.log('\npreviewFiling — ריצה יבשה');
  await reset();
  {
    const f = fakeIcount();
    const d = await closedDoc({ doc_number: 'P-1', amount_total: 250.5 });
    const p = await filing.previewFiling(String(d._id), { client: f.client });
    eq(p.ok, true, 'מוכן');
    deepEq(p.blockers, [], 'בלי חוסמים');
    deepEq(p.payload, {
      supplier_id: '11', expense_type_id: 2, expense_doctype: 'invoice', expense_docnum: 'P-1',
      expense_sum: 250.5, expense_date: '2026-09-10', currency_code: 'ILS',
    }, 'מה בדיוק יישלח');
    deepEq(p.icount_supplier, { id: '11', name: 'חשמל ישראל' }, 'באיזה ספק באייקאונט');
    eq(f.writes(), 0, 'שום כתיבה לאייקאונט');
    eq(f.of('/expense/search').length, 0, 'לא נעשה חיפוש');
    const p2 = await filing.previewFiling(String(d._id), { client: f.client, expense_type_id: '10' });
    eq(p2.payload.expense_type_id, 10, 'סוג הוצאה מוחלף למסמך הזה');
    const p3 = await filing.previewFiling(String(d._id), { client: f.client, expense_type_id: 'abc' });
    ok(!p3.ok && p3.payload === null && p3.blockers.some(b => /סוג ההוצאה/.test(b)), 'סוג הוצאה לא תקין — חסום, בלי payload');

    await setType(null);
    const p4 = await filing.previewFiling(String(d._id), { client: f.client });
    ok(!p4.ok && p4.payload === null && p4.blockers.some(b => /סוג ההוצאה/.test(b)), 'סוג הוצאה לא הוגדר — חסום');
    await setType(2);

    const open = await doc({ doc_number: 'P-2' });
    const p5 = await filing.previewFiling(String(open._id), { client: f.client });
    ok(!p5.ok && p5.blockers.some(b => /סגור/.test(b)), 'לא בסגור — מופיע כחוסם בתצוגה');

    const off = fakeIcount({ configured: false });
    const p6 = await filing.previewFiling(String(d._id), { client: off.client });
    ok(!p6.ok && p6.blockers.some(b => /לא מחובר/.test(b)), 'לא מחובר — חסום');
    eq(off.calls.length, 0, 'לא מחובר — אין קריאות');
    await refuses(() => filing.previewFiling(String(new mongoose.Types.ObjectId()), { client: f.client }), 404, 'NOT_FOUND', 'תצוגה למסמך שלא קיים');
    eq(f.creates(), 0, 'אף תצוגה לא יצרה מסמך');
  }

  console.log('\nfileToIcount — שערים, לפי הסדר');
  await reset();
  {
    const f = fakeIcount();
    const file = (d, o = {}) => filing.fileToIcount(String(d._id || d), { by, client: f.client, ...o });

    await refuses(() => file(new mongoose.Types.ObjectId()), 404, 'NOT_FOUND', 'מסמך שלא קיים');
    await refuses(() => file('nope'), 404, 'NOT_FOUND', 'מזהה לא תקין');

    const already = await closedDoc({ icount_id: 'E1' });
    await refuses(() => file(already), 409, 'ALREADY_FILED', 'כבר באייקאונט');

    const review = await closedDoc({ needs_review: true });
    await refuses(() => file(review), 400, 'NEEDS_REVIEW', 'קריאה שלא אושרה');

    const fromIcount = await closedDoc({ source: 'icount', mail_sorter_id: undefined });
    await refuses(() => file(fromIcount), 400, 'SOURCE_ICOUNT', 'מסמך שמקורו באייקאונט');

    const open = await doc({});
    await refuses(() => file(open), 409, 'NOT_CLOSED', 'לא סגור (אין חיוב)');
    const partial = await doc({ amount_total: 100 });
    await pay(partial, 50);
    await refuses(() => file(partial), 409, 'NOT_CLOSED', 'מכוסה חלקית');

    const noTax = await closedDoc({ supplier_tax_id: '' });
    const e = await refuses(() => file(noTax), 400, 'BLOCKED', 'חוסם — אין מספר עוסק');
    ok(e && Array.isArray(e.blockers) && e.blockers.length >= 1 && e.message === e.blockers[0], 'השגיאה נושאת את החוסמים, ההודעה = הראשון');
    const noNum = await closedDoc({ doc_number: '' });
    await refuses(() => file(noNum), 400, 'BLOCKED', 'חוסם — אין מספר מסמך');
    const receipt = await closedDoc({ doc_type: 'receipt', receipt_disposition: 'is_document' });
    await setType(null);
    await refuses(() => file(receipt), 400, 'BLOCKED', 'סוג הוצאה לא הוגדר');
    await setType(2);
    eq(f.calls.length, 0, 'עד כאן — אף קריאה לאייקאונט');

    const off = fakeIcount({ configured: false });
    const ready = await closedDoc({});
    await refuses(() => filing.fileToIcount(String(ready._id), { by, client: off.client }), 503, 'NOT_CONFIGURED', 'לא מחובר');
    eq(off.calls.length, 0, 'לא מחובר — אין קריאות');

    const unknown = await closedDoc({ vendor_name: 'ספק שלא קיים', supplier_tax_id: TAX_B });
    const e2 = await refuses(() => file(unknown), 400, 'BLOCKED', 'ספק לא באייקאונט');
    ok(e2 && /הספק לא קיים באייקאונט/.test(e2.message), 'הודעת "הספק לא קיים באייקאונט"');

    clearSupplierCache();
    const partialList = fakeIcount({ handlers: { '/supplier/get_list': () => ({ status: true, total_count: 5, results_list: SUPPLIERS }) } });
    const e3 = await refuses(() => filing.fileToIcount(String(ready._id), { by, client: partialList.client }), 400, 'BLOCKED', 'רשימת ספקים חלקית');
    eq(e3 && e3.message, 'רשימת הספקים מאייקאונט לא נקראה במלואה — נסו שוב', 'בהודעה המדויקת');
    eq(partialList.creates(), 0, 'רשימה חלקית — לא נוצר');
    clearSupplierCache();

    eq(f.creates(), 0, 'אף שער שנכשל לא קרא ל-create');
    eq((await fresh(ready)).icount_id, null, 'והמסמך לא סומן');
  }

  console.log('\nfileToIcount — הצלחה, פרמטרים מדויקים, שמירה');
  await reset();
  {
    const f = fakeIcount();
    const d = await closedDoc({ doc_number: 'F-1', amount_total: 1234.56, doc_date: '2026-09-15', vat_amount: 188, description: 'x' });
    const res = await filing.fileToIcount(String(d._id), { by, client: f.client });
    deepEq(res, { filed: true, icount_id: 'E900' }, 'תוצאה: הועלה + מזהה');
    eq(f.of('/expense/search').length, 1, 'חיפוש כפילות לפני יצירה');
    deepEq(f.of('/expense/search')[0].params, { supplier_id: '11', limit: '500', offset: '0' }, 'החיפוש אצל אותו ספק, בלי סינון תאריך');
    eq(f.creates(), 1, 'נוצר פעם אחת');
    const sent = f.of('/expense/create')[0].params;
    deepEq(sent, {
      supplier_id: '11', expense_type_id: '2', expense_doctype: 'invoice', expense_docnum: 'F-1',
      expense_sum: '1234.56', expense_date: '2026-09-15', currency_code: 'ILS',
    }, 'create — בדיוק השדות המותרים');
    deepEq(Object.keys(sent).sort(), [...EXACT_KEYS].sort(), 'אין payments, אין מע״מ, אין תיאור');
    ok(!Object.keys(sent).some(k => /payment|vat|desc|scan/i.test(k)), 'אף מפתח אסור');
    const after = await fresh(d);
    eq(after.icount_id, 'E900', 'icount_id נשמר');
    eq(after.icount_docnum, '77', 'icount_docnum נשמר');
    ok(after.icount_filed_at instanceof Date, 'icount_filed_at נשמר');
    eq(String(after.icount_filed_by), String(by), 'icount_filed_by נשמר');
    const before = f.calls.length;
    await refuses(() => filing.fileToIcount(String(d._id), { by, client: f.client }), 409, 'ALREADY_FILED', 'לחיצה שנייה');
    eq(f.calls.length, before, 'לחיצה שנייה — אין קריאות');

    // double click: two at once → one create
    const g = fakeIcount({ handlers: { '/expense/create': async () => { await new Promise(r => setTimeout(r, 30)); return { status: true, expense_id: 'E901' }; } } });
    const d2 = await closedDoc({ doc_number: 'F-2' });
    const both = await Promise.allSettled([
      filing.fileToIcount(String(d2._id), { by, client: g.client }),
      filing.fileToIcount(String(d2._id), { by, client: g.client }),
    ]);
    eq(both.filter(r => r.status === 'fulfilled').length, 1, 'לחיצה כפולה — רק אחת מצליחה');
    const rej = both.find(r => r.status === 'rejected');
    eq(rej && rej.reason.code, 'ALREADY_FILED', 'השנייה: 409 ALREADY_FILED');
    eq(g.creates(), 1, 'create נקרא פעם אחת');

    // doctype map + mark "not paid yet" (closed tab) + a foreign doc with a confirmed shekel figure
    const types = { invoice_receipt: 'invrec', receipt: 'receipt', other: 'other' };
    for (const [ours, theirs] of Object.entries(types)) {
      const h = fakeIcount({ handlers: { '/expense/create': () => ({ status: true, expense_id: `T-${ours}` }) } });
      const x = await closedDoc({ doc_type: ours, receipt_disposition: ours === 'receipt' ? 'is_document' : null });
      await filing.fileToIcount(String(x._id), { by, client: h.client });
      eq(h.of('/expense/create')[0]?.params.expense_doctype, theirs, `${ours} → ${theirs}`);
    }
    const unpaid = await doc({ doc_number: 'U-1' });
    await ExpenseUnpaidMark.create({ document_id: unpaid._id });
    const hu = fakeIcount({ handlers: { '/expense/create': () => ({ status: true, expense_id: 'EU' }) } });
    deepEq(await filing.fileToIcount(String(unpaid._id), { by, client: hu.client }), { filed: true, icount_id: 'EU' }, '"עוד לא שולמה" (לשונית סגור) — מותר');
    const anyway = await doc({ doc_number: 'CA-1' });
    await ExpenseDocDecision.create({ document_id: anyway._id, kind: 'closed_anyway' });
    const ha = fakeIcount({ handlers: { '/expense/create': () => ({ status: true, expense_id: 'EA' }) } });
    eq((await filing.fileToIcount(String(anyway._id), { by, client: ha.client })).filed, true, '"סגור בכל זאת" — מותר');
    const usd = await closedDoc({ currency: 'USD', amount_original: 30, fx_confirmed: true, amount_total: 111.4, supplier_tax_id: '', vendor_name: 'Google Ireland' });
    const hx = fakeIcount({ handlers: { '/expense/create': () => ({ status: true, expense_id: 'EX' }) } });
    await filing.fileToIcount(String(usd._id), { by, client: hx.client });
    const xs = hx.of('/expense/create')[0].params;
    ok(xs.expense_sum === '111.4' && xs.currency_code === 'ILS' && xs.supplier_id === '22', 'מט״ח: הסכום בשקלים כפי שחויב, ספק לפי שם');

    const override = await closedDoc({ doc_number: 'OV-1' });
    const ho = fakeIcount({ handlers: { '/expense/create': () => ({ status: true, expense_id: 'EO' }) } });
    await filing.fileToIcount(String(override._id), { by, client: ho.client, expense_type_id: 10 });
    eq(ho.of('/expense/create')[0].params.expense_type_id, '10', 'סוג הוצאה מוחלף למסמך');
  }

  console.log('\nfileToIcount — תשובת אייקאונט');
  await reset();
  {
    const onlyDocnum = fakeIcount({ handlers: { '/expense/create': () => ({ status: true, docnum: 'D55' }) } });
    const a = await closedDoc({});
    eq((await filing.fileToIcount(String(a._id), { by, client: onlyDocnum.client })).icount_id, 'D55', 'בלי expense_id — docnum');
    eq((await fresh(a)).icount_docnum, 'D55', 'icount_docnum = docnum');

    const noId = fakeIcount({ handlers: { '/expense/create': () => ({ status: true }) } });
    const b = await closedDoc({});
    const rb = await filing.fileToIcount(String(b._id), { by, client: noId.client });
    ok(rb.filed === true && rb.icount_id === null && !!rb.warning, 'בלי מזהה — הועלה, עם אזהרה');
    const bb = await fresh(b);
    ok(bb.icount_filed_at instanceof Date && bb.icount_id === null, 'סומן כהועלה (בלי icount_id)');
    await refuses(() => filing.fileToIcount(String(b._id), { by, client: noId.client }), 409, 'ALREADY_FILED', 'ולא יועלה שוב');
    eq(noId.creates(), 1, 'create פעם אחת בלבד');

    const refused = fakeIcount({ handlers: { '/expense/create': () => ({ status: false, reason: 'bad_expense_type_id' }) } });
    const c = await closedDoc({});
    const ec = await refuses(() => filing.fileToIcount(String(c._id), { by, client: refused.client }), 502, 'ICOUNT_ERROR', 'אייקאונט סירב');
    ok(ec && ec.message.includes('bad_expense_type_id'), 'הסיבה של אייקאונט — מילה במילה');
    const cc = await fresh(c);
    ok(cc.icount_id === null && cc.icount_filed_at === null, 'סירוב — המסמך לא סומן');

    const throttled = fakeIcount({ handlers: { '/expense/create': () => 'Too many requests' } });
    const t = await closedDoc({});
    await refuses(() => filing.fileToIcount(String(t._id), { by, client: throttled.client }), 503, 'THROTTLED', 'האטה — 503');
    eq((await fresh(t)).icount_id, null, 'האטה — לא סומן');
    const throttledSearch = fakeIcount({ handlers: { '/expense/search': () => 'Too many requests' } });
    await refuses(() => filing.fileToIcount(String(t._id), { by, client: throttledSearch.client }), 503, 'THROTTLED', 'האטה בחיפוש — 503');
    eq(throttledSearch.creates(), 0, 'האטה בחיפוש — לא נוצר');
  }

  console.log('\nבדיקת כפילות לפני יצירה');
  await reset();
  {
    const hit = (rows, total = rows.length) => fakeIcount({ handlers: { '/expense/search': () => ({ status: true, total_count: total, results_list: rows }) } });

    const d = await closedDoc({ doc_number: '0042/7' });
    const f = hit([{ expense_id: 'X1', expense_docnum: '42-7', expense_date: '2026-09-11', nis_sum: 100, supplier_id: 11 }]);
    deepEq(await filing.fileToIcount(String(d._id), { by, client: f.client }), { adopted: true, icount_id: 'X1' }, 'כבר קיים (אותו ספק + מספר) — אומץ');
    eq(f.creates(), 0, 'אימוץ — create לא נקרא');
    const da = await fresh(d);
    eq(da.icount_id, 'X1', 'המסמך שלנו קיבל את ה-icount_id');
    eq(da.icount_filed_at, null, 'לא סומן "הועלה" — אורלי הקלידה אותו');

    // the bridge had already made a document from that iCount row: ours takes its place
    const row = await IcountExpense.create({ icount_id: 'X2', supplier_id: '11', supplier_name: 'חשמל ישראל', supplier_tax_id: TAX_A, doc_number: 'K-9', doc_date: '2026-09-10', amount_total: 100, doctype: 'invoice' });
    const twin = await ExpenseDocument.create({ source: 'icount', icount_id: 'X2', vendor_name: 'חשמל ישראל', supplier_tax_id: TAX_A, doc_number: 'K-9', doc_date: '2026-09-10', amount_total: 100 });
    const mine = await closedDoc({ doc_number: 'K-9' });
    const f2 = hit([{ expense_id: 'X2', expense_docnum: 'K-9', expense_date: '2026-09-10', nis_sum: 100 }]);
    eq((await filing.fileToIcount(String(mine._id), { by, client: f2.client })).adopted, true, 'אומץ גם כשכבר יש מסמך אייקאונט');
    eq((await fresh(mine)).icount_id, 'X2', 'שלנו מחזיק את השורה');
    eq((await fresh(twin)).status, 'void', 'מסמך האייקאונט הכפול בוטל');
    eq(String((await IcountExpense.findById(row._id).lean()).matched_expense_id), String(mine._id), 'שורת המראה זוכרת את שלנו');
    eq(f2.creates(), 0, 'create לא נקרא');

    // held by ANOTHER document of ours → refuse, never create
    await ExpenseDocument.create({ source: 'manual', icount_id: 'X3', vendor_name: 'חשמל ישראל', supplier_tax_id: TAX_A, doc_number: 'Z-1', doc_date: '2026-09-10', amount_total: 100 });
    const dup = await closedDoc({ doc_number: 'Z-1' });
    const f3 = hit([{ expense_id: 'X3', expense_docnum: 'Z-1', expense_date: '2026-09-10', nis_sum: 100 }]);
    await refuses(() => filing.fileToIcount(String(dup._id), { by, client: f3.client }), 409, 'ALREADY_FILED', 'שורת אייקאונט שמוחזקת במסמך אחר שלנו');
    eq(f3.creates(), 0, 'create לא נקרא');

    // probable: same supplier, close amount/date, different number
    const p = await closedDoc({ doc_number: 'NEW-1', amount_total: 300 });
    const fp = hit([{ expense_id: 'X4', expense_docnum: 'OLD-1', expense_date: '2026-09-11', nis_sum: 300.2 }]);
    await refuses(() => filing.fileToIcount(String(p._id), { by, client: fp.client }), 409, 'PROBABLE_DUPLICATE', 'כנראה כפול — נעצר');
    eq(fp.creates(), 0, 'create לא נקרא');
    eq((await filing.fileToIcount(String(p._id), { by, client: fp.client, confirm_duplicate: true })).filed, true, 'עם אישור — הועלה');

    // cancelled rows never count; a different number far away is different
    const s = await closedDoc({ doc_number: 'S-1' });
    const fs = hit([
      { expense_id: 'X5', expense_docnum: 'S-1', expense_date: '2026-09-10', nis_sum: 100, is_storno: 1 },
      { expense_id: 'X6', expense_docnum: 'Q-1', expense_date: '2026-08-01', nis_sum: 100 },
    ]);
    eq((await filing.fileToIcount(String(s._id), { by, client: fs.client })).filed, true, 'מסמך מבוטל באייקאונט ומסמך אחר — נוצר');

    // incomplete search: cannot prove absence → stop
    const inc = await closedDoc({ doc_number: 'I-1' });
    const fi = hit([{ expense_id: 'X7', expense_docnum: 'Y', expense_date: '2026-01-01', nis_sum: 1 }], 900);
    const ei = await refuses(() => filing.fileToIcount(String(inc._id), { by, client: fi.client }), 502, 'ICOUNT_ERROR', 'חיפוש חלקי — נעצר');
    ok(ei && /900/.test(ei.message), 'ההודעה אומרת כמה לא נקראו');
    eq(fi.creates(), 0, 'create לא נקרא');
  }

  console.log('\nreportPaid / undoReportPaid (spec §5, port notes §8)');
  await reset();
  {
    const f = fakeIcount();
    const rp = (d, o = {}) => filing.reportPaid(String(d._id || d), { by, client: f.client, ...o });

    await refuses(() => rp(new mongoose.Types.ObjectId()), 404, 'NOT_FOUND', 'מסמך שלא קיים');
    const notIn = await closedDoc({});
    await refuses(() => rp(notIn), 400, 'NOT_IN_ICOUNT', 'לא באייקאונט');
    const partial = await doc({ icount_id: 'R1', amount_total: 100 });
    await pay(partial, 50);
    await refuses(() => rp(partial), 400, 'NOT_SETTLED', 'מכוסה חלקית');
    const none = await doc({ icount_id: 'R2' });
    await refuses(() => rp(none), 400, 'NOT_SETTLED', 'בלי חיוב');
    const anyway = await doc({ icount_id: 'R3' });
    await ExpenseDocDecision.create({ document_id: anyway._id, kind: 'closed_anyway' });
    await refuses(() => rp(anyway), 400, 'NOT_SETTLED', '"סגור בכל זאת" — לא מדווחים ששולם');
    const outside = await doc({ icount_id: 'R4' });
    await pay(outside, 100);
    await ExpenseDocDecision.create({ document_id: outside._id, kind: 'paid_outside_bank' });
    await refuses(() => rp(outside), 400, 'NOT_SETTLED', 'שולם מחוץ לבנק — לא מדווחים');
    const gone = await doc({ icount_id: 'R5', icount_gone_at: new Date() });
    await pay(gone, 100);
    await refuses(() => rp(gone), 409, 'ICOUNT_GONE', 'נמחק באייקאונט');
    eq(f.calls.length, 0, 'אף סירוב לא קרא לאייקאונט');

    // covered within 2 ₪ by two charges → the LATEST charge date
    const d = await doc({ source: 'icount', mail_sorter_id: undefined, icount_id: 'R9', amount_total: 300 });
    await pay(d, 150, { date: '2026-09-14' });
    await pay(d, 148.5, { date: '2026-09-20' });
    const res = await rp(d);
    deepEq(res, { reported: true, paid_date: '2026-09-20' }, 'דווח ששולם, בתאריך החיוב האחרון');
    deepEq(f.of('/expense/update')[0].params, { expense_id: 'R9', expense_paid: '1', expense_paid_date: '2026-09-20' }, 'נשלחו רק שדות התשלום');
    const rep = await IcountPaidReport.findOne({ document_id: d._id }).lean();
    ok(rep && rep.icount_id === 'R9' && rep.paid_date === '2026-09-20' && String(rep.reported_by) === String(by), 'IcountPaidReport נשמר');
    await rp(d, { date: '2026-09-21' });
    eq(await IcountPaidReport.countDocuments({ document_id: d._id }), 1, 'דיווח חוזר — שורה אחת למסמך');
    eq((await IcountPaidReport.findOne({ document_id: d._id }).lean()).paid_date, '2026-09-21', 'תאריך שניתן במפורש');
    await refuses(() => rp(d, { date: '21/09/2026' }), 400, 'BAD_DATE', 'תאריך לא תקין');

    const failing = fakeIcount({ handlers: { '/expense/update': () => ({ status: false, reason: 'expense_not_found' }) } });
    const d2 = await doc({ icount_id: 'R10' });
    await pay(d2, 100);
    const e = await refuses(() => filing.reportPaid(String(d2._id), { by, client: failing.client }), 502, 'ICOUNT_ERROR', 'אייקאונט סירב');
    ok(e && e.message.includes('expense_not_found'), 'הסיבה מילה במילה');
    eq(await IcountPaidReport.countDocuments({ document_id: d2._id }), 0, 'סירוב — לא נשמר דיווח');

    // undo
    await refuses(() => filing.undoReportPaid(String(d2._id), { by, client: f.client }), 400, 'NOT_REPORTED', 'ביטול בלי דיווח');
    const n = f.of('/expense/update').length;
    deepEq(await filing.undoReportPaid(String(d._id), { by, client: f.client }), { undone: true }, 'ביטול הדיווח');
    deepEq(f.of('/expense/update')[n].params, { expense_id: 'R9', expense_paid: '0' }, 'ביטול: expense_paid=0 בלבד, בלי תאריך');
    eq(await IcountPaidReport.countDocuments({ document_id: d._id }), 0, 'הדיווח נמחק');
    const undoFail = fakeIcount({ handlers: { '/expense/update': () => ({ status: false, reason: 'nope' }) } });
    await rp(d);
    await refuses(() => filing.undoReportPaid(String(d._id), { by, client: undoFail.client }), 502, 'ICOUNT_ERROR', 'ביטול שאייקאונט סירב');
    eq(await IcountPaidReport.countDocuments({ document_id: d._id }), 1, 'הדיווח נשאר');
    ok(f.calls.every(c => !Object.keys(c.params).some(k => /payment|sum|vat/i.test(k)) || c.method !== '/expense/update'), 'שום עדכון לא שלח payments/סכום/מע״מ');
    eq(f.creates() + failing.creates() + undoFail.creates(), 0, 'עדכון ששולם לא יוצר מסמכים');
  }

  await mongoose.disconnect(); await mongod.stop();
  console.log(failures ? `\n❌ ${failures} כשלונות` : '\n✅ הכל עבר');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
