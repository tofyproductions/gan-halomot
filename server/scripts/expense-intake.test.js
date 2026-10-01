#!/usr/bin/env node
/**
 * Expenses intake — manual entry, update, supplier from document, mail-sorter
 * pull (fake client), file serving. Standalone server, loopback only.
 *
 *   node scripts/expense-intake.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c || !d ? '' : `  (${d})`}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const refuses = async (fn, status, l, code) => {
  try { await fn(); ok(false, `${l} — לא נזרקה שגיאה`); return null; } catch (e) {
    eq(e.status, status, `${l} → ${status}`);
    if (code) eq(e.code, code, `${l} → code ${code}`);
    return e;
  }
};

async function suite() {
  const { ExpenseDocument, ExpenseFile, Supplier } = require('../src/models');
  const intake = require('../src/services/expenseIntake.service');
  await ExpenseDocument.init();
  const reset = () => Promise.all([ExpenseDocument, ExpenseFile, Supplier].map(m => m.deleteMany({})));
  const user = new mongoose.Types.ObjectId();
  const base = { vendor_name: 'חשמל בע"מ', doc_type: 'tax_invoice', doc_number: '100', doc_date: '2026-09-10', amount_total: 250 };

  const item = (id, extracted = {}, o = {}) => ({
    id, doc_type: 'invoice', attachment_sha256: `sha${id}`,
    extracted: { vendor_name: 'ספק חדש', supplier_tax_id: '', doc_number: `D${id}`, doc_date: '2026-09-01', amount_total: 118, doc_type: 'tax_invoice', currency: 'ILS', ...extracted },
    ...o,
  });
  const fake = (byKind, { ackThrows = false } = {}) => {
    const acks = [];
    return { acks,
      listDocuments: async (k) => byKind[k] || [],
      ack: async (id) => { acks.push(id); if (ackThrows) throw new Error('ack down'); },
      fetchFile: async (id) => ({ buffer: Buffer.from(`ms-${id}`), filename: 'a.pdf', mime: 'application/pdf' }) };
  };

  console.log('createManual');
  await reset();
  {
    const d = await intake.createManual({ fields: base, by: user });
    eq(d.source, 'manual', 'source manual');
    eq(d.needs_review, false, 'needs_review=false');
    eq(String(d.confirmed_by), String(user), 'confirmed_by');
    eq(d.fx_confirmed, true, 'ILS → fx_confirmed');
    const e = await refuses(() => intake.createManual({ fields: { ...base, vendor_name: 'חשמל' }, by: user }), 409, 'כפילות ספק+מספר', 'DUPLICATE');
    eq(e.existing_id, String(d._id), 'existing_id');
    await refuses(() => intake.createManual({ fields: { ...base, doc_number: '1', doc_date: 'x' } }), 400, 'תאריך לא תקין');
    await refuses(() => intake.createManual({ fields: { ...base, doc_number: '1', doc_type: 'zzz' } }), 400, 'סוג לא תקין');
    await refuses(() => intake.createManual({ fields: { ...base, doc_number: '1', vendor_name: '' } }), 400, 'חסר ספק');

    const withFile = await intake.createManual({ fields: { ...base, doc_number: '2' }, file: { data: Buffer.from('hello'), name: 'x.pdf', mime: 'application/pdf' }, by: user });
    ok(!!withFile.file_id && withFile.attachment_sha256.length === 64, 'קובץ נשמר + sha');
    eq(await ExpenseFile.countDocuments(), 1, 'ExpenseFile אחד');
    const f = await intake.getFile(withFile._id);
    eq(f.buffer.toString(), 'hello', 'getFile מחזיר את הבתים');
    eq(f.mime, 'application/pdf', 'getFile mime');
    const same = await refuses(() => intake.createManual({ fields: { ...base, doc_number: '3', vendor_name: 'אחר' }, file: { data: Buffer.from('hello'), name: 'y.pdf', mime: 'application/pdf' } }), 409, 'אותו קובץ', 'DUPLICATE');
    eq(same.existing_id, String(withFile._id), 'existing_id לפי sha');
    eq(await ExpenseFile.countDocuments(), 1, 'הקובץ הכפול לא נשמר');
    await refuses(() => intake.createManual({ fields: { ...base, doc_number: '4' }, file: { data: Buffer.alloc(11 * 1024 * 1024, 1), name: 'big.pdf', mime: 'application/pdf' } }), 400, 'קובץ 11MB');
    eq(await ExpenseFile.countDocuments(), 1, 'הגדול לא נשמר');
    await refuses(() => intake.createManual({ fields: { ...base, doc_number: '4b' }, file: { data: Buffer.from('x'), name: 'a.exe', mime: 'application/x-msdownload' } }), 400, 'mime לא מורשה');
    await refuses(() => intake.createManual({ fields: { ...base, doc_number: '4c' }, file: { data: Buffer.from('x'), name: 'a', mime: '' } }), 400, 'בלי mime');
    eq(await ExpenseFile.countDocuments(), 1, 'לא נשמר קובץ עם mime אסור');
    const b64 = await intake.createManual({ fields: { ...base, doc_number: '5' }, file: { data: Buffer.from('b64').toString('base64'), name: 'z.png', mime: 'image/png' } });
    eq((await intake.getFile(b64._id)).buffer.toString(), 'b64', 'data כ-base64 מתקבל');

    const sup = await Supplier.create({ name: 'ספק קיים', tax_id: '515-123456' });
    const m = await intake.createManual({ fields: { ...base, doc_number: '6', vendor_name: 'משהו', supplier_tax_id: '515123456' } });
    eq(String(m.supplier_id), String(sup._id), 'ספק זוהה לפי מספר עוסק');

    const fx = await intake.createManual({ fields: { ...base, doc_number: '7', currency: 'USD', amount_total: 100 } });
    eq(fx.fx_confirmed, false, 'מט"ח בלי סכום מקורי → לא מאושר');
    eq(fx.amount_original, 100, 'הסכום שהוקלד נשמר כמקורי');
    const fx2 = await intake.createManual({ fields: { ...base, doc_number: '8', currency: 'USD', amount_total: 370, amount_original: 100 } });
    eq(fx2.fx_confirmed, true, 'מט"ח עם סכום מקורי → מאושר');
  }

  console.log('updateDocument');
  await reset();
  {
    const d = await intake.createManual({ fields: base });
    const other = await intake.createManual({ fields: { ...base, doc_number: '200' } });
    const u = await intake.updateDocument(d._id, { amount_total: 300, status: 'void', source: 'mail_sorter', is_general: true }, user);
    eq(u.amount_total, 300, 'סכום עודכן');
    eq(u.is_general, true, 'is_general');
    eq(u.status, 'active', 'status לא ברשימה הלבנה');
    eq(u.source, 'manual', 'source לא ברשימה הלבנה');
    await refuses(() => intake.updateDocument(d._id, { doc_number: '200' }, user), 409, 'שינוי למספר קיים', 'DUPLICATE');
    await refuses(() => intake.updateDocument(new mongoose.Types.ObjectId(), { amount_total: 1 }), 404, 'לא קיים');
    await refuses(() => intake.updateDocument('zzz', {}), 400, 'מזהה לא תקין');
    await refuses(() => intake.updateDocument(d._id, { supplier_id: new mongoose.Types.ObjectId() }), 404, 'ספק לא קיים');
    const usd = await intake.updateDocument(d._id, { currency: 'USD' }, user);
    eq(usd.fx_confirmed, false, 'שינוי למט"ח → לא מאושר');
    eq(usd.amount_original, 300, 'המקורי נשמר מהסכום');
    const usd2 = await intake.updateDocument(d._id, { amount_total: 1100, amount_original: 300 }, user);
    eq(usd2.fx_confirmed, true, 'שקלים הוקלדו → מאושר');
    const back = await intake.updateDocument(d._id, { currency: 'ILS' }, user);
    eq(back.fx_confirmed, true, 'חזרה ל-ILS → מאושר');
    await ExpenseDocument.updateOne({ _id: other._id }, { status: 'void' });
    await refuses(() => intake.updateDocument(other._id, { amount_total: 1 }), 409, 'מסמך מבוטל');
    // a mail-sorter row becomes confirmed by an edit
    const ms = await ExpenseDocument.create({ source: 'mail_sorter', mail_sorter_id: 9001, vendor_name: 'x', needs_review: true });
    // tagging only (branch / general / order) keeps the reading unconfirmed
    const branchId = new mongoose.Types.ObjectId();
    const tagged = await intake.updateDocument(ms._id, { branch_id: String(branchId) }, user);
    eq(tagged.needs_review, true, 'סניף בלבד — needs_review נשאר true');
    eq(String(tagged.branch_id), String(branchId), 'הסניף נשמר');
    ok(!tagged.confirmed_by, 'סניף בלבד — confirmed_by לא נקבע');
    const gen = await intake.updateDocument(ms._id, { is_general: true, branch_id: null }, user);
    eq(gen.needs_review, true, 'כללי בלבד — needs_review נשאר true');
    const mu = await intake.updateDocument(ms._id, { amount_total: 5 }, user);
    eq(mu.needs_review, false, 'עריכה מאשרת מסמך ממערכת המיון');
    eq(String(mu.confirmed_by), String(user), 'confirmed_by אחרי עריכה');
  }

  console.log('createSupplierFromDocument');
  await reset();
  {
    const d = await intake.createManual({ fields: { ...base, supplier_tax_id: '514000111' } });
    eq(d.supplier_id, null, 'אין ספק אוטומטי');
    eq(await Supplier.countDocuments(), 0, 'לא נוצר ספק בלי לחיצה');
    const s = await intake.createSupplierFromDocument(d._id, user);
    eq(s.name, base.vendor_name, 'שם הספק');
    eq(s.tax_id, '514000111', 'מספר עוסק');
    eq(String((await ExpenseDocument.findById(d._id)).supplier_id), String(s._id), 'המסמך קושר');
    await refuses(() => intake.createSupplierFromDocument(d._id), 409, 'כבר יש ספק');
    const d2 = await ExpenseDocument.create({ source: 'manual', vendor_name: 'חשמל', supplier_tax_id: '514000111', doc_number: '77' });
    await refuses(() => intake.createSupplierFromDocument(d2._id), 409, 'ספק כזה קיים', 'SUPPLIER_EXISTS');
    await refuses(() => intake.createSupplierFromDocument(new mongoose.Types.ObjectId()), 404, 'מסמך לא קיים');
  }

  console.log('pullFromMailSorter');
  await reset();
  {
    await require('../src/models').Setting.updateOne({ key: 'expense_mail_pulled_from' }, { $set: { value: '2024-10-01' } }, { upsert: true });
    const sup = await Supplier.create({ name: 'ספק ידוע', tax_id: '511111111' });
    const c = fake({
      invoice: [item(1), item(1), item(2, { vendor_name: 'משהו', supplier_tax_id: '511-111-111' }), item(3, { currency: 'USD', amount_total: 40 })],
      receipt: [item(4, { doc_type: 'receipt' }, { doc_type: 'receipt' }), item(5, { doc_type: undefined }, { doc_type: 'receipt' })],
    });
    const r = await intake.pullFromMailSorter({ client: c });
    eq(r.fetched, 6, 'fetched');
    eq(r.created, 5, 'created');
    eq(r.skipped, 1, 'הפריט הכפול דולג');
    eq(r.errors, 0, 'בלי שגיאות');
    eq(await ExpenseDocument.countDocuments(), 5, 'חמישה מסמכים');
    eq(c.acks.filter(x => x === 1).length, 2, 'הפריט הכפול: ack בשמירה + ack חוזר');
    eq(c.acks.length, 6, 'ack לכל פריט (כולל החוזר)');
    const d1 = await ExpenseDocument.findOne({ mail_sorter_id: 1 });
    eq(d1.needs_review, true, 'needs_review');
    eq(d1.source, 'mail_sorter', 'source');
    eq(d1.attachment_sha256, 'sha1', 'sha נשמר');
    eq(d1.amount_total, 118, 'סכום ממופה');
    eq(String((await ExpenseDocument.findOne({ mail_sorter_id: 2 })).supplier_id), String(sup._id), 'ספק זוהה לפי מספר עוסק');
    eq((await ExpenseDocument.findOne({ mail_sorter_id: 4 })).doc_type, 'receipt', 'קבלה ממופה');
    eq((await ExpenseDocument.findOne({ mail_sorter_id: 5 })).doc_type, 'receipt', 'בלי doc_type → לפי סוג הרשימה');
    const fx = await ExpenseDocument.findOne({ mail_sorter_id: 3 });
    eq(fx.fx_confirmed, false, 'מט"ח לא מאושר');
    eq(fx.amount_original, 40, 'הסכום המקורי');
    eq(await Supplier.countDocuments(), 1, 'לא נוצר ספק');

    const again = await intake.pullFromMailSorter({ client: fake({ invoice: [item(1)] }) });
    eq(again.created, 0, 'הרצה חוזרת — כלום חדש');
    // void rows keep their mail_sorter_id and must not be re-created
    await ExpenseDocument.updateOne({ mail_sorter_id: 1 }, { status: 'void' });
    const c2 = fake({ invoice: [item(1)] });
    const v = await intake.pullFromMailSorter({ client: c2 });
    eq(v.created, 0, 'מסמך מבוטל לא נוצר מחדש');
    eq(v.skipped, 1, 'דולג');
    eq(c2.acks.length, 1, 'ack חוזר גם למבוטל');
    // wrapped list shape
    const w = await intake.pullFromMailSorter({ client: { ...fake({}), listDocuments: async (k) => (k === 'invoice' ? { items: [item(50)] } : []) } });
    eq(w.created, 1, 'תומך ב-{items}');
  }
  await reset();
  {
    // a failed save never acks and never blocks the others
    const c = fake({ invoice: [item(10), item(11)] });
    const realCreate = ExpenseDocument.create;
    ExpenseDocument.create = async function (d, ...rest) { if (d.mail_sorter_id === 10) throw new Error('db down'); return realCreate.call(this, d, ...rest); };
    const orig = console.error; console.error = () => {};
    let r;
    try { r = await intake.pullFromMailSorter({ client: c }); } finally { ExpenseDocument.create = realCreate; console.error = orig; }
    eq(r.errors, 1, 'שגיאה אחת');
    eq(r.created, 1, 'השני נשמר');
    ok(!c.acks.includes(10), 'אין ack לפריט שנכשל');
    ok(c.acks.includes(11), 'ack לשני');
    // a failing ack leaves the saved doc in place
    const c3 = fake({ invoice: [item(20)] }, { ackThrows: true });
    const orig2 = console.error; console.error = () => {};
    let r3; try { r3 = await intake.pullFromMailSorter({ client: c3 }); } finally { console.error = orig2; }
    eq(r3.created, 1, 'נשמר למרות ack שנכשל');
    eq(r3.errors, 1, 'השגיאה נספרה');
    // run 2 re-acks what a failed ack left behind
    const c3b = fake({ invoice: [item(20)] });
    const r3b = await intake.pullFromMailSorter({ client: c3b });
    eq(r3b.created, 0, 'הרצה שנייה לא יוצרת');
    eq(r3b.skipped, 1, 'דולג');
    ok(c3b.acks.includes(20), 'הרצה שנייה עושה ack שחסר');
    // dedupe skip (same supplier+number as an active doc) is acked and not an error
    await ExpenseDocument.create({ source: 'manual', vendor_name: 'כפול בע"מ', doc_number: 'X1' });
    const c5 = fake({ invoice: [item(40, { vendor_name: 'כפול', doc_number: 'X1' })] });
    const r5 = await intake.pullFromMailSorter({ client: c5 });
    eq(r5.skipped, 1, 'כפילות לוגית דולגה');
    eq(r5.errors, 0, 'לא שגיאה');
    ok(c5.acks.includes(40), 'וגם ack');
    // an ack failure on a skip is an error but does not block the next item
    const c6 = fake({ invoice: [item(20), item(41)] });
    c6.ack = async (id) => { c6.acks.push(id); if (id === 20) throw new Error('down'); };
    const orig6 = console.error; console.error = () => {};
    let r6; try { r6 = await intake.pullFromMailSorter({ client: c6 }); } finally { console.error = orig6; }
    eq(r6.errors, 1, 'כשל ack בדילוג נספר שגיאה');
    eq(r6.created, 1, 'הבא אחריו נשמר');
    // an item with no id is an error, never a query on undefined
    const c7 = fake({ invoice: [{ extracted: {} }, item(42)] });
    const orig7 = console.error; console.error = () => {};
    let r7; try { r7 = await intake.pullFromMailSorter({ client: c7 }); } finally { console.error = orig7; }
    eq(r7.errors, 1, 'פריט בלי id → שגיאה');
    eq(r7.created, 1, 'והבא נשמר');
    // a list that fails does not stop the other kind
    const c4 = { ...fake({ receipt: [item(30, {}, { doc_type: 'receipt' })] }), listDocuments: async (k) => { if (k === 'invoice') throw new Error('down'); return [item(30)]; } };
    const orig3 = console.error; console.error = () => {};
    let r4; try { r4 = await intake.pullFromMailSorter({ client: c4 }); } finally { console.error = orig3; }
    eq(r4.created, 1, 'הקבלות נמשכו');
    eq(r4.errors, 1, 'כשל הרשימה נספר');
  }

  console.log('getFile — mail-sorter');
  {
    const ms = await ExpenseDocument.create({ source: 'mail_sorter', mail_sorter_id: 777, vendor_name: 'x' });
    const f = await intake.getFile(ms._id, { client: fake({}) });
    eq(f.buffer.toString(), 'ms-777', 'נמשך לפי דרישה');
    eq(f.name, 'a.pdf', 'שם');
    const none = await ExpenseDocument.create({ source: 'manual', vendor_name: 'x' });
    await refuses(() => intake.getFile(none._id), 404, 'אין קובץ');
    await refuses(() => intake.getFile(new mongoose.Types.ObjectId()), 404, 'מסמך לא קיים');
  }

  console.log('\nמשיכה — רק מה שלא אושר, ותאריך התחלה');
  await reset();
  {
    const { Setting } = require('../src/models');
    await Setting.deleteMany({});
    await require('../src/services/expenseCore.service').setStartDate('2026-09-01');
    const opts = [];
    const c = fake({ invoice: [item(60, { doc_date: '2026-08-31' }), item(61, { doc_date: '' }), item(62)] });
    c.listDocuments = async (k, o) => { opts.push(o); return k === 'invoice' ? [item(60, { doc_date: '2026-08-31' }), item(61, { doc_date: '' }), item(62)] : []; };
    const r = await intake.pullFromMailSorter({ client: c });
    ok(opts.length === 2 && opts.every(o => o && o.all === false), 'המשיכה מבקשת בלי all (רק מה שלא אושר)');
    eq(r.skipped_old, 1, 'פריט לפני תאריך ההתחלה — skipped_old');
    eq(r.created, 2, 'פריט בלי תאריך ופריט רגיל — נוצרו');
    ok(c.acks.includes(60), 'הפריט הישן קיבל ack (יורד מהרשימה)');
    eq(await ExpenseDocument.countDocuments({ mail_sorter_id: 60 }), 0, 'ולא נוצר ממנו מסמך');
    eq(c.acks.length, 3, 'ack אחד לכל פריט');

    // the mail-sorter client itself: `all=1` only when asked (form101/recruitment keep it)
    const env = require('../src/config/env');
    const ms = require('../src/services/mailSorter.service');
    const saved = { url: env.MAIL_SORTER_URL, token: env.MAIL_SORTER_TOKEN, fetch: global.fetch };
    env.MAIL_SORTER_URL = 'http://127.0.0.1:9'; env.MAIL_SORTER_TOKEN = 't';
    const urls = [];
    global.fetch = async (u) => { urls.push(String(u)); return { ok: true, status: 200, json: async () => [] }; };
    try {
      await ms.listDocuments('invoice', { all: false });
      await ms.listDocuments('form101');
    } finally { env.MAIL_SORTER_URL = saved.url; env.MAIL_SORTER_TOKEN = saved.token; global.fetch = saved.fetch; }
    ok(!/all=1/.test(urls[0]) && /system=gan/.test(urls[0]) && /doc_type=invoice/.test(urls[0]), 'הוצאות: בלי all=1');
    ok(/all=1/.test(urls[1]), 'טופס 101: עדיין all=1');
  }

  console.log('\nמשיכה מלאה — הורדת תאריך ההתחלה ושחזור היסטוריה');
  await reset();
  {
    const { Setting } = require('../src/models');
    const core = require('../src/services/expenseCore.service');
    await Setting.deleteMany({});
    await core.setStartDate('2026-09-01');
    const calls = [];
    const mk = (items) => ({ ...fake({}), listDocuments: async (k, o) => { calls.push({ k, ...o }); return k === 'invoice' ? items : []; } });
    const old = item(70, { doc_date: '2025-03-01' });

    await intake.pullFromMailSorter({ client: mk([]) });
    ok(calls.every(c => c.all === false), 'בלי הורדת תאריך — משיכה רגילה (all=false)');
    eq((await Setting.findOne({ key: 'expense_mail_pulled_from' }).lean()).value, '2026-09-01', 'סימן המים הנמוך נרשם');

    await core.setStartDate('2024-10-01');
    calls.length = 0;
    const r1 = await intake.pullFromMailSorter({ client: mk([old]) });
    ok(calls.length === 2 && calls.every(c => c.all === true), 'הורדת תאריך — המשיכה הבאה all=true');
    eq(r1.created, 1, 'הפריט הישן נכנס');
    eq((await Setting.findOne({ key: 'expense_mail_pulled_from' }).lean()).value, '2024-10-01', 'סימן המים הנמוך ירד');

    calls.length = 0;
    await intake.pullFromMailSorter({ client: mk([]) });
    ok(calls.every(c => c.all === false), 'המשיכה שאחריה — רגילה שוב (בדיוק פעם אחת)');

    // a full pull never duplicates what is already filed
    calls.length = 0;
    const r2 = await intake.pullFromMailSorter({ client: mk([old]), full: true });
    ok(calls.every(c => c.all === true), 'משיכה מלאה ידנית — all=true');
    eq(r2.created, 0, 'מזהה שכבר קיים — לא נוצר שוב');
    eq(r2.skipped, 1, 'נספר כדולג');
    eq(await ExpenseDocument.countDocuments({ mail_sorter_id: 70 }), 1, 'מסמך אחד בלבד');

    // paging: a server that honours offset is walked to the end; one that ignores it is flagged
    const page = (from, n) => Array.from({ length: n }, (_, i) => item(1000 + from + i, { doc_date: '2025-01-01' }));
    const offs = [];
    const paged = { ...fake({}), listDocuments: async (k, o) => { offs.push(o.offset); return k === 'invoice' ? (o.offset === 0 ? page(0, 500) : o.offset === 500 ? page(500, 30) : []) : []; } };
    const r3 = await intake.pullFromMailSorter({ client: paged, full: true });
    eq(r3.created, 530, 'דפדוף: כל 530 הפריטים נמשכו');
    ok(offs.includes(500) && !r3.capped, 'הדפדוף ביקש offset=200 ולא סומן כחתוך');
    const stuck = { ...fake({}), listDocuments: async (k) => (k === 'invoice' ? page(5000, 500) : []) };
    const r4 = await intake.pullFromMailSorter({ client: stuck, full: true });
    ok(r4.capped && r4.note, 'שרת שמתעלם מ-offset — מסומן capped עם הסבר');
  }

  console.log('\nסימן המים הנמוך — שני הכיוונים, ניסיונות, מרוץ');
  await reset();
  {
    const { Setting } = require('../src/models');
    const core = require('../src/services/expenseCore.service');
    const mark = async () => (await Setting.findOne({ key: 'expense_mail_pulled_from' }).lean())?.value;
    const calls = [];
    const mk = (items, o = {}) => ({ ...fake({}), listDocuments: async (k, opt) => { calls.push({ k, ...opt }); if (o.fail) throw new Error('down'); return k === 'invoice' ? items : []; } });
    await Setting.deleteMany({});
    await core.setStartDate('2024-10-01');
    await intake.pullFromMailSorter({ client: mk([]) });
    eq(await mark(), '2024-10-01', 'סימן = תאריך ההתחלה');
    await core.setStartDate('2026-01-01');
    calls.length = 0;
    await intake.pullFromMailSorter({ client: mk([]) });
    eq(await mark(), '2026-01-01', 'העלאת התאריך מעלה את הסימן');
    ok(calls.every(c => c.all === false && c.limit === 500), 'משיכה רגילה: בלי all, limit=500');
    await core.setStartDate('2025-01-01');
    calls.length = 0;
    await intake.pullFromMailSorter({ client: mk([]) });
    ok(calls.every(c => c.all === true), 'הורדה אחרי העלאה — משיכה מלאה');
    eq(await mark(), '2025-01-01', 'והסימן ירד');

    // a per-item error does not block the marker
    await core.setStartDate('2024-06-01');
    const bad = item(80, {}, { id: null });
    await intake.pullFromMailSorter({ client: mk([bad]) });
    eq(await mark(), '2024-06-01', 'שגיאת פריט לא חוסמת את הסימן');

    // failing paging: 3 automatic attempts, then no more all=true; button still full
    await core.setStartDate('2023-01-01');
    for (let i = 0; i < 3; i++) await intake.pullFromMailSorter({ client: mk([], { fail: true }) });
    eq(await mark(), '2024-06-01', 'סימן לא זז כשהדפדוף נכשל');
    calls.length = 0;
    await intake.pullFromMailSorter({ client: mk([]) });
    ok(calls.every(c => c.all === false), 'אחרי 3 ניסיונות — אין all=true אוטומטי');
    calls.length = 0;
    await intake.pullFromMailSorter({ client: mk([]), full: true });
    ok(calls.every(c => c.all === true), 'הכפתור עדיין עובד');
    eq(await mark(), '2023-01-01', 'ומשיכה שהושלמה מורידה את הסימן');

    // full run: existing items are not re-acked; E11000 counts as skipped
    await reset();
    const c = mk([item(90)]);
    await intake.pullFromMailSorter({ client: c, full: true });
    c.acks.length = 0;
    await intake.pullFromMailSorter({ client: c, full: true });
    eq(c.acks.length, 0, 'מסמך קיים במשיכה מלאה — בלי ack חוזר');
    await reset();
    const real = ExpenseDocument.create;
    ExpenseDocument.create = async () => { throw Object.assign(new Error('dup'), { code: 11000 }); };
    let r; try { r = await intake.pullFromMailSorter({ client: mk([item(91)]) }); } finally { ExpenseDocument.create = real; }
    ok(r.errors === 0 && r.skipped === 1 && r.created === 0, 'E11000 — נספר כדולג, לא כשגיאה');
  }

  console.log('\nעריכת מסמך עם תשלומים');
  await reset();
  {
    const { ExpensePayment } = require('../src/models');
    const d = await intake.createManual({ fields: { ...base, doc_number: 'P-1', amount_total: 500 }, by: user });
    await ExpensePayment.create({ document_id: d._id, transaction_id: new mongoose.Types.ObjectId(), amount: 400 });
    await refuses(() => intake.updateDocument(d._id, { amount_total: 397 }, user), 409, 'סכום מתחת לשולם פחות 2 ₪');
    try { await intake.updateDocument(d._id, { amount_total: 300 }, user); } catch (e) { ok(/בטלו קודם את השיוך/.test(e.message), 'ההודעה: בטלו קודם את השיוך'); }
    eq((await intake.updateDocument(d._id, { amount_total: 398 }, user)).amount_total, 398, 'עד 2 ₪ מתחת — מתקבל');
    await refuses(() => intake.updateDocument(d._id, { doc_type: 'receipt' }, user), 409, 'שינוי לקבלה כשיש שיוך');
    await refuses(() => intake.updateDocument(d._id, { doc_type: 'credit_note' }, user), 409, 'שינוי לזיכוי כשיש שיוך');
    eq((await intake.updateDocument(d._id, { doc_type: 'invoice_receipt' }, user)).doc_type, 'invoice_receipt', 'שינוי לחשבונית/קבלה — מותר');
    const free = await intake.createManual({ fields: { ...base, doc_number: 'P-2', amount_total: 500 }, by: user });
    eq((await intake.updateDocument(free._id, { doc_type: 'receipt', amount_total: 1 }, user)).doc_type, 'receipt', 'בלי שיוך — מותר');
    await ExpensePayment.deleteMany({});
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
