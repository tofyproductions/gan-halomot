#!/usr/bin/env node
/**
 * iCount suppliers + read-only mirror pull. Fake client only; no network.
 *
 *   node scripts/icount-mirror.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c || !d ? '' : `  (${d})`}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);

// Fake iCount: suppliers + per-supplier expense rows, paged by limit/offset.
function fakeClient({ suppliers, expenses = {}, throttleFor = [], configured = true, supplierPages = null }) {
  const calls = [];
  return {
    calls,
    isConfigured: () => configured,
    async post(method, params = {}) {
      calls.push({ method, params });
      if (method === '/supplier/get_list') {
        const off = Number(params.offset || 0); const lim = Number(params.limit || 500);
        return { status: true, total_count: suppliers.length, results_list: suppliers.slice(off, off + lim) };
      }
      if (method === '/expense/search') {
        const sid = String(params.supplier_id);
        if (throttleFor.includes(sid)) throw Object.assign(new Error('throttled'), { code: 'THROTTLED' });
        const all = expenses[sid] || [];
        const off = Number(params.offset || 0); const lim = Number(params.limit || 500);
        return { status: true, total_count: all.length, results_list: all.slice(off, off + lim) };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

const SUP = [
  { supplier_id: 11, supplier_name: 'חשמל ישראל בע"מ', vat_id: '510000011' },
  { supplier_id: 22, supplier_name: 'מים וביוב', vat_id: '' },
  { supplier_id: 33, supplier_name: 'אנטרופיק', vat_id: '' },
];
const row = (id, no, date, sum, extra = {}) => ({ expense_id: id, expense_docnum: no, expense_date: date, nis_sum: sum, ...extra });

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error('not loopback');
  await mongoose.connect(uri);
  const { IcountExpense, IcountPull, Setting, ExpenseDocument } = require('../src/models');
  const suppliersSvc = require('../src/services/icountSuppliers.service');
  const mirror = require('../src/services/icountMirror.service');
  await Setting.findOneAndUpdate({ key: 'expenses_start_date' }, { $set: { value: '2026-09-01' } }, { upsert: true });

  console.log('\n🪞 ספקים ומראה אייקאונט\n');

  console.log('listSuppliers + resolveSupplier');
  {
    suppliersSvc.clearSupplierCache();
    const many = Array.from({ length: 1203 }, (_, i) => ({ supplier_id: 1000 + i, supplier_name: `ספק ${i}`, vat_id: '' }));
    const c = fakeClient({ suppliers: many });
    const r = await suppliersSvc.listSuppliers({ client: c, refresh: true });
    eq(r.suppliers.length, 1203, 'שלושה עמודים של 500 — כולם נקראו');
    eq(r.complete, true, 'complete');
    eq(c.calls.length, 3, '3 קריאות');
    eq(c.calls[1].params.offset, 500, 'offset 500 בעמוד השני');
    await suppliersSvc.listSuppliers({ client: c });
    eq(c.calls.length, 3, 'מהמטמון — בלי קריאה נוספת');
    await suppliersSvc.listSuppliers({ client: c, refresh: true });
    eq(c.calls.length, 6, 'refresh עוקף מטמון');

    const c2 = fakeClient({ suppliers: [
      ...SUP,
      { supplier_id: 44, supplier_name: 'חשמל ישראל', vat_id: '510000099' },  // same name, different vat
      { supplier_id: 55, supplier_name: 'שם כפול', vat_id: '' },
      { supplier_id: 66, supplier_name: 'שם   כפול', vat_id: '' },
      { supplier_id: 77, supplier_name: 'ספק כפול ח"פ א', vat_id: '510000077' },
      { supplier_id: 88, supplier_name: 'ספק כפול ח"פ ב', vat_id: '510000077' },
    ] });
    const opts = { client: c2, refresh: true };
    eq((await suppliersSvc.resolveSupplier({ tax_id: '51-0000011', name: 'x' }, opts)).id, '11', 'לפי ח.פ (ספרות בלבד)');
    eq((await suppliersSvc.resolveSupplier({ tax_id: '', name: 'מים וביוב בע"מ' }, opts)).id, '22', 'לפי שם מנורמל');
    eq((await suppliersSvc.resolveSupplier({ tax_id: '', name: 'מים וביוב בע"מ' }, opts)).name, 'מים וביוב', 'מחזיר שם');
    eq(await suppliersSvc.resolveSupplier({ tax_id: '', name: 'שם כפול' }, opts), null, 'שם דו-משמעי — null');
    eq((await suppliersSvc.resolveSupplier({ tax_id: '510000077', name: '' }, opts)).id, '77', 'ח.פ כפול — הראשון מנצח');
    eq(await suppliersSvc.resolveSupplier({ tax_id: '510000011', name: 'אחר לגמרי' }, opts).then(r => r.id), '11', 'ח.פ מנצח שם');
    eq(await suppliersSvc.resolveSupplier({ tax_id: '510000555', name: 'ספק כפול ח"פ א' }, opts), null, 'לכרטיס שם יש ח.פ אחר — חברה אחרת');
    eq((await suppliersSvc.resolveSupplier({ tax_id: '510000555', name: 'מים וביוב' }, opts)).id, '22', 'לכרטיס אין ח.פ — השם מחליט');
    eq(await suppliersSvc.resolveSupplier({ tax_id: '', name: 'לא קיים' }, opts), null, 'לא נמצא — null');
    eq(await suppliersSvc.resolveSupplier({ tax_id: '', name: '' }, opts), null, 'בלי כלום — null');
  }

  console.log('pullMirror — עמודים, סטורנו, תאריך התחלה');
  {
    suppliersSvc.clearSupplierCache();
    const big = Array.from({ length: 620 }, (_, i) => row(`E${i}`, `N${i}`, '2026-09-15', 10 + i));
    const c = fakeClient({
      suppliers: SUP,
      expenses: {
        11: big,
        22: [
          row('S1', '0052 /1', '2026-09-20', 118.5, { supplier_vat_id: '123456782' }),
          row('S2', 'C-9', '2026-09-21', 50, { is_storno: 'false' }),
          row('S3', 'C-10', '2026-09-22', 60, { is_storno: '1' }),
          row('S4', 'C-11', '2026-09-23', 70, { is_stornoed: 'true' }),
          row('OLD', 'O-1', '2026-08-31', 99),                       // before start date
          { expense_id: 'BAD', expense_docnum: 'B', expense_date: 'garbage', nis_sum: 5 }, // -> 1970, before start
        ],
        33: [],
      },
    });
    const res = await mirror.pullMirror({ client: c, gapMs: 0 });
    eq(res.partial, false, 'לא חלקי');
    eq(res.suppliers, 3, '3 ספקים');
    eq(res.fetched, 624, 'נשלפו 620 + 4 (מאחרי תאריך ההתחלה)');
    eq(res.upserted, 624, 'נשמרו');
    eq(res.gone, 0, 'אף אחד לא נעלם');
    eq(res.errors.length, 0, 'בלי שגיאות');
    eq(await IcountExpense.countDocuments({}), 624, '624 במסד');
    const paged = c.calls.filter(x => x.method === '/expense/search' && x.params.supplier_id == 11);
    eq(paged.length, 2, 'ספק 11 — שני עמודים');
    eq(paged[1].params.offset, 500, 'offset 500');
    eq(paged[0].params.limit, 500, 'limit 500');
    ok(!('start_date' in paged[0].params) && !('expense_date' in paged[0].params), 'בלי פילטר תאריכים בבקשה');
    const s1 = await IcountExpense.findOne({ icount_id: 'S1' }).lean();
    eq(s1.doc_number, '0052 /1', 'מספר מסמך נשמר כמו שהוא');
    eq(s1.amount_total, 118.5, 'nis_sum');
    eq(s1.supplier_tax_id, '123456782', 'ח.פ מהשורה');
    eq(s1.supplier_name, 'מים וביוב', 'שם מהספק');
    eq(s1.supplier_id, '22', 'supplier_id');
    eq(s1.is_storno, false, 'לא סטורנו');
    const e0 = await IcountExpense.findOne({ icount_id: 'E0' }).lean();
    eq(e0.supplier_tax_id, '510000011', 'ח.פ מצטרף מכרטיס הספק');
    eq((await IcountExpense.findOne({ icount_id: 'S2' }).lean()).is_storno, false, 'is_storno:"false" אינו סטורנו');
    eq((await IcountExpense.findOne({ icount_id: 'S3' }).lean()).is_storno, true, 'is_storno:"1" סטורנו');
    eq((await IcountExpense.findOne({ icount_id: 'S4' }).lean()).is_storno, true, 'is_stornoed סטורנו');
    eq(await IcountExpense.countDocuments({ icount_id: { $in: ['OLD', 'BAD'] } }), 0, 'לפני תאריך ההתחלה — לא נשמר');
    eq(await ExpenseDocument.countDocuments({}), 0, 'המראה לא יוצר מסמכים');
    const pull = await IcountPull.findOne({}).lean();
    eq(pull.complete, true, 'IcountPull complete');
    eq(pull.date_from, '2026-09-01', 'date_from');
    eq(pull.rows_seen, 624, 'rows_seen');
    ok(!!pull.finished_at, 'finished_at');

    console.log('pullMirror — משיכה חוזרת');
    const again = await mirror.pullMirror({ client: c, gapMs: 0 });
    eq(again.partial, false, 'לא חלקי');
    eq(await IcountExpense.countDocuments({}), 624, 'אותו מספר שורות');
    eq(await IcountPull.countDocuments({}), 2, 'משיכה שנייה נרשמה');

    console.log('gone_at');
    c.calls.length = 0;
    // supplier 22 loses S1; supplier 11 loses E0
    const exp = { ...c };
    const c3 = fakeClient({ suppliers: SUP, expenses: {
      11: big.slice(1),
      22: [row('S2', 'C-9', '2026-09-21', 50), row('S3', 'C-10', '2026-09-22', 60, { is_storno: '1' }), row('S4', 'C-11', '2026-09-23', 70, { is_stornoed: 'true' })],
      33: [],
    } });
    const r3 = await mirror.pullMirror({ client: c3, gapMs: 0 });
    eq(r3.gone, 2, 'שני מסמכים נעלמו');
    ok((await IcountExpense.findOne({ icount_id: 'S1' }).lean()).gone_at instanceof Date, 'S1 gone_at');
    ok((await IcountExpense.findOne({ icount_id: 'E0' }).lean()).gone_at instanceof Date, 'E0 gone_at');
    eq(await IcountExpense.countDocuments({}), 624, 'אין מחיקה');
    eq((await IcountExpense.findOne({ icount_id: 'E1' }).lean()).gone_at, null, 'מי שחזר — לא נעלם');
    // returns -> un-gone
    await mirror.pullMirror({ client: exp, gapMs: 0 });
    eq((await IcountExpense.findOne({ icount_id: 'S1' }).lean()).gone_at, null, 'מסמך שחזר — gone_at מתאפס');
    eq((await IcountExpense.findOne({ icount_id: 'OLD' }).lean()), null, 'OLD עדיין לא קיים');
  }

  console.log('pullMirror — משיכה חלקית (ספק מוגבל)');
  {
    await IcountExpense.deleteMany({}); await IcountPull.deleteMany({}); suppliersSvc.clearSupplierCache();
    // seed: supplier 11 has an old row that would look "gone" if the pull wrongly applied gone to it
    await IcountExpense.create({ icount_id: 'KEEP', supplier_id: '11', doc_date: '2026-09-10', amount_total: 5 });
    await IcountExpense.create({ icount_id: 'VANISH', supplier_id: '22', doc_date: '2026-09-10', amount_total: 5 });
    const c = fakeClient({ suppliers: SUP, throttleFor: ['11'], expenses: {
      22: [row('S9', 'X-1', '2026-09-12', 40)], 33: [row('T9', 'Y-1', '2026-09-13', 41)],
    } });
    const r = await mirror.pullMirror({ client: c, gapMs: 0 });
    eq(r.partial, true, 'partial:true');
    eq(r.errors.length, 1, 'שגיאה אחת');
    ok(/חשמל ישראל/.test(r.errors[0]), 'השגיאה נקובה בשם הספק', r.errors[0]);
    eq(r.fetched, 2, 'שני הספקים האחרים נשמרו');
    ok(!!(await IcountExpense.findOne({ icount_id: 'S9' })), 'S9 נשמר');
    ok(!!(await IcountExpense.findOne({ icount_id: 'T9' })), 'T9 נשמר');
    eq((await IcountExpense.findOne({ icount_id: 'KEEP' }).lean()).gone_at, null, 'gone לא חל על הספק החלקי');
    ok((await IcountExpense.findOne({ icount_id: 'VANISH' }).lean()).gone_at instanceof Date, 'gone כן חל על ספק שנקרא עד הסוף');
    const pull = await IcountPull.findOne({}).lean();
    eq(pull.complete, false, 'IcountPull לא complete');
    eq(pull.suppliers_read, 2, 'suppliers_read 2');
    eq(pull.failures.length, 1, 'failures נשמר');
  }

  console.log('pullMirror — ספק שנקרא לא עד הסוף');
  {
    await IcountExpense.deleteMany({}); suppliersSvc.clearSupplierCache();
    await IcountExpense.create({ icount_id: 'K2', supplier_id: '22', doc_date: '2026-09-10', amount_total: 5 });
    const c = fakeClient({ suppliers: SUP.slice(0, 2), expenses: { 22: [row('Z1', 'Z', '2026-09-12', 1)] } });
    const orig = c.post;
    c.post = async (m, p) => {
      const d = await orig(m, p);
      if (m === '/expense/search' && p.supplier_id == 22) d.total_count = 9; // says 9, gives 1, short page
      return d;
    };
    const r = await mirror.pullMirror({ client: c, gapMs: 0 });
    eq(r.partial, true, 'total_count גדול מהנקרא — חלקי');
    eq((await IcountExpense.findOne({ icount_id: 'K2' }).lean()).gone_at, null, 'ולכן בלי gone');
  }

  console.log('pullMirror — רשימת ספקים נכשלת / לא מחובר');
  {
    await IcountPull.deleteMany({}); suppliersSvc.clearSupplierCache();
    const bad = { isConfigured: () => true, post: async () => { throw Object.assign(new Error('throttled'), { code: 'THROTTLED' }); } };
    const r = await mirror.pullMirror({ client: bad, gapMs: 0 });
    eq(r.partial, true, 'partial');
    eq(r.fetched, 0, 'לא נשלף כלום');
    ok(r.errors.length === 1, 'שגיאה אחת');
    eq((await IcountPull.findOne({}).lean()).complete, false, 'נרשם כלא-complete');
    eq((await IcountPull.findOne({}).lean()).error.length > 0, true, 'error נרשם');

    const off = fakeClient({ suppliers: SUP, configured: false });
    const r2 = await mirror.pullMirror({ client: off, gapMs: 0 });
    eq(r2.partial, true, 'לא מחובר — partial');
    eq(r2.errors[0], 'לא מחובר', 'הודעת "לא מחובר"');
    eq(off.calls.length, 0, 'לא נוגע ברשת');
  }

  console.log('mongo index');
  {
    let dup = false;
    await IcountExpense.init();
    await IcountExpense.deleteMany({});
    await IcountExpense.create({ icount_id: 'U1', doc_date: '2026-09-01', amount_total: 1 });
    try { await IcountExpense.create({ icount_id: 'U1', doc_date: '2026-09-01', amount_total: 1 }); } catch (e) { dup = e.code === 11000; }
    ok(dup, 'icount_id ייחודי');
  }

  await mongoose.disconnect(); await mongod.stop();
  console.log(failures ? `\n❌ ${failures} כשלונות` : '\n✅ הכל עבר');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
