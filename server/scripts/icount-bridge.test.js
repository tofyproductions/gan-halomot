#!/usr/bin/env node
/**
 * iCount bridge — mirror rows → expense documents, identity decisions, gone
 * rows, mail item attached to an iCount document. Memory Mongo, fake client
 * only; no network.
 *
 *   node scripts/icount-bridge.test.js
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

const TAX_A = '510000011'; // valid check digit
const TAX_B = '510000094'; // valid, a different company
const TAX_BAD = '510000555'; // fails the check digit — ignored

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error('not loopback');
  await mongoose.connect(uri);
  const {
    IcountExpense, ExpenseDocument, ExpensePayment, ExpenseIdentityDecision, Setting, Supplier, BankAccount, BankTransaction,
  } = require('../src/models');
  const bridge = require('../src/services/icountBridge.service');
  const intake = require('../src/services/expenseIntake.service');
  const { pairQueue } = require('../src/services/expensePairs.service');
  await Setting.findOneAndUpdate({ key: 'expenses_start_date' }, { $set: { value: '2026-09-01' } }, { upsert: true });
  await Promise.all([ExpenseDocument.init(), IcountExpense.init(), ExpensePayment.init(), ExpenseIdentityDecision.init()]);

  let seq = 0;
  const bank = await BankAccount.create({ external_id: 'b:1', institution: 'beinleumi', label: 'בינלאומי', type: 'bank' });
  const tx = (o) => BankTransaction.create({ account_id: bank._id, date: '2026-09-10', amount: -100, description: 'תנועה', hash: `h${++seq}`, ...o });
  const mirrorRow = (o) => IcountExpense.create({
    icount_id: `I${++seq}`, supplier_id: '11', supplier_name: 'חשמל ישראל בע"מ', supplier_tax_id: TAX_A,
    doc_number: `N${seq}`, doc_date: '2026-09-10', amount_total: 100, doctype: 'invoice', ...o,
  });
  const ours = (o) => ExpenseDocument.create({
    source: 'mail_sorter', mail_sorter_id: ++seq, vendor_name: 'חשמל ישראל', supplier_tax_id: TAX_A,
    doc_type: 'tax_invoice', doc_number: `M${seq}`, doc_date: '2026-09-10', amount_total: 100, ...o,
  });
  const reset = () => Promise.all([IcountExpense, ExpenseDocument, ExpensePayment, ExpenseIdentityDecision, Supplier, BankTransaction]
    .map(m => m.deleteMany({})));
  const id = (x) => String(x._id);

  console.log('\n🌉 גשר אייקאונט → מסמכי הוצאה\n');

  console.log('compareToIcount (port notes §6)');
  {
    const c = bridge.compareToIcount;
    const base = { supplier_tax_id: TAX_A, supplier_name: 'חשמל', doc_number: '0052 /1', amount_total: 100, doc_date: '2026-09-10' };
    eq(c(base, { ...base, doc_number: '52/1' }), 'same_document', 'אותו ח.פ + אותו מספר (בלי סימנים ואפסים מובילים)');
    eq(c(base, { ...base, doc_number: '52-1', supplier_name: 'שם אחר לגמרי' }), 'same_document', 'ח.פ זהה — השם לא משנה');
    eq(c(base, { ...base, supplier_tax_id: TAX_B }), 'different', 'שני ח.פ תקינים שונים — שונה, גם עם אותו שם ומספר');
    eq(c({ ...base, supplier_tax_id: '' }, { ...base, supplier_name: 'חשמל בע"מ' }), 'same_document', 'לצד אחד אין ח.פ — השם מחליט');
    eq(c({ ...base, supplier_tax_id: TAX_BAD }, { ...base, supplier_tax_id: TAX_B }), 'same_document', 'ח.פ לא תקין מתעלמים ממנו — השם מחליט');
    eq(c({ ...base, supplier_tax_id: '' }, { ...base, supplier_tax_id: '', supplier_name: 'מים' }), 'different', 'ספק אחר, אותו מספר — שונה');
    eq(c({ ...base, vendor_name: 'חשמל', supplier_name: undefined, supplier_tax_id: '' }, { ...base, supplier_tax_id: '' }), 'same_document', 'vendor_name של מסמך שלנו נחשב שם ספק');
    eq(c(base, { ...base, doc_number: '999', amount_total: 100.4, doc_date: '2026-09-13' }), 'probable', 'אותו ספק, סכום ±0.5, 3 ימים — סביר');
    eq(c(base, { ...base, doc_number: '999', doc_date: '2026-09-14' }), 'different', '4 ימים — שונה');
    eq(c(base, { ...base, doc_number: '999', amount_total: 100.5 }), 'different', 'הפרש 0.5 — שונה');
    eq(c({ ...base, doc_number: '' }, { ...base, doc_number: '' }), 'probable', 'בלי מספר — לכל היותר סביר');
    eq(c(base, { ...base, supplier_tax_id: TAX_B, doc_number: '999' }), 'different', 'ספק אחר — לא סביר גם עם סכום ותאריך זהים');
  }

  console.log('syncBridge — יצירה, קישור, סביר, סטורנו');
  await reset();
  {
    const sup = await Supplier.create({ name: 'חשמל ישראל', tax_id: TAX_A });
    const onlyIcount = await mirrorRow({ amount_total: 480, doc_date: '2026-09-11', doc_number: 'A-1' });
    const linkedRow = await mirrorRow({ doc_number: '0052 /1', amount_total: 300 });
    const ourLinked = await ours({ doc_number: '52/1', amount_total: 300 });
    const probRow = await mirrorRow({ doc_number: 'P-1', amount_total: 700, doc_date: '2026-09-15' });
    const ourProb = await ours({ doc_number: 'X-9', amount_total: 700, doc_date: '2026-09-17' });
    await mirrorRow({ doc_number: 'S-1', is_storno: true });
    await mirrorRow({ doc_number: 'OLD', doc_date: '2026-08-20' });
    const types = [];
    for (const [t, want] of [['invrec', 'invoice_receipt'], ['receipt', 'receipt'], ['refund', 'credit_note'], ['other', 'other'], ['weird', 'tax_invoice'], ['', 'tax_invoice']]) {
      types.push({ want, row: await mirrorRow({ doctype: t, doc_number: `T-${t || 'empty'}`, amount_total: 1000 + seq, doc_date: '2026-09-25' }) });
    }

    const r = await bridge.syncBridge();
    eq(r.created, 7, 'נוצרו מסמכים למסמכי אייקאונט בלי מקבילה (1 + 6 סוגים)');
    eq(r.linked, 1, 'קישור אחד (אותו ספק + מספר)');
    eq(r.probable, 1, 'שאלת זהות אחת');
    eq(r.voided, 0, 'בלי ביטולים');

    const made = await ExpenseDocument.findOne({ icount_id: onlyIcount.icount_id }).lean();
    ok(!!made, 'מסמך אייקאונט בלבד → ExpenseDocument');
    eq(made && made.source, 'icount', 'source icount');
    eq(made && made.needs_review, false, 'needs_review=false');
    eq(made && String(made.supplier_id), String(sup._id), 'ספק זוהה (matchSupplier)');
    eq(made && made.vendor_name, 'חשמל ישראל בע"מ', 'שם ספק מאייקאונט');
    eq(made && made.doc_type, 'tax_invoice', 'invoice → tax_invoice');
    eq(made && made.amount_total, 480, 'סכום');
    eq(made && made.doc_date, '2026-09-11', 'תאריך');
    eq(made && made.doc_number, 'A-1', 'מספר מסמך');
    eq(made && made.currency, 'ILS', 'ש"ח');
    for (const { want, row } of types) {
      eq((await ExpenseDocument.findOne({ icount_id: row.icount_id }).lean())?.doc_type, want, `סוג ${row.doctype || 'ריק'} → ${want}`);
    }
    const receiptRow = types.find(x => x.want === 'receipt').row;
    const rec = await ExpenseDocument.findOne({ icount_id: receiptRow.icount_id }).lean();
    eq(rec.receipt_disposition, 'is_document', 'קבלה מאייקאונט — "הקבלה היא המסמך"');
    ok(!!rec.receipt_disposition_at, 'receipt_disposition_at');

    const charge = await tx({ amount: -480, date: '2026-09-12', description: 'חשמל ישראל' });
    const q = await pairQueue();
    const p = q.pairs.find(x => id(x.doc) === id(made));
    ok(!!p, 'מסמך אייקאונט מופיע ב-pairQueue');
    eq(p && id(p.tx), id(charge), 'עם החיוב המתאים');
    const inQueue = [...q.pairs.map(x => x.doc), ...q.unmatchedDocs].find(d => id(d) === id(rec));
    ok(!!inQueue, 'קבלה מאייקאונט נכנסת ל-pairQueue');
    const lanes = await require('../src/services/expenseCore.service').documentsWithState();
    eq(lanes.find(d => id(d) === id(rec))?.lane, 'open', 'ולא לנתיב הקבלות');

    eq((await ExpenseDocument.findById(ourLinked._id).lean()).icount_id, linkedRow.icount_id, 'המסמך שלנו קיבל icount_id');
    eq(await ExpenseDocument.countDocuments({ doc_number: { $in: ['0052 /1', '52/1'] } }), 1, 'לא נוצר כפול');
    const lr = await IcountExpense.findById(linkedRow._id).lean();
    eq(lr.match_kind, 'same_document', 'המראה זוכר same_document');
    eq(String(lr.matched_expense_id), id(ourLinked), 'matched_expense_id');

    eq(await ExpenseDocument.countDocuments({ icount_id: probRow.icount_id }), 0, 'סביר — לא נוצר ולא מוזג');
    eq((await ExpenseDocument.findById(ourProb._id).lean()).icount_id, null, 'סביר — המסמך שלנו לא קושר');
    const qs = await bridge.pendingIdentityQuestions();
    eq(qs.length, 1, 'שאלה אחת ממתינה');
    eq(qs[0] && id(qs[0].document), id(ourProb), 'השאלה — המסמך שלנו');
    eq(qs[0] && id(qs[0].icount_expense), id(probRow), 'השאלה — שורת אייקאונט');
    eq(qs[0] && qs[0].icount_document_id, null, 'עוד אין תאום אייקאונט');

    eq(await ExpenseDocument.countDocuments({ doc_number: 'S-1' }), 0, 'סטורנו — לא נוצר מסמך');
    eq(await ExpenseDocument.countDocuments({ doc_number: 'OLD' }), 0, 'לפני תאריך ההתחלה — לא נוצר');

    const again = await bridge.syncBridge();
    eq(again.created + again.linked, 0, 'הרצה חוזרת — כלום חדש');
    eq(again.probable, 1, 'השאלה עדיין ממתינה');

    console.log('decideIdentity — "לא אותו מסמך"');
    await refuses(() => bridge.decideIdentity('zz', id(probRow), false), 400, 'מזהה לא תקין');
    await refuses(() => bridge.decideIdentity(id(ourProb), id(new mongoose.Types.ObjectId()), false), 404, 'שורה לא קיימת');
    const far = await ours({ supplier_tax_id: TAX_B, vendor_name: 'חברה אחרת', doc_number: 'P-1', amount_total: 700, doc_date: '2026-09-15' });
    await refuses(() => bridge.decideIdentity(id(far), id(probRow), true), 400, '"אותו" על זוג שההשוואה אומרת "שונה"');
    eq(await ExpenseIdentityDecision.countDocuments(), 0, 'לא נשמרה החלטה');
    await ExpenseDocument.updateOne({ _id: far._id }, { status: 'void' });
    const by = new mongoose.Types.ObjectId();
    const d = await bridge.decideIdentity(id(ourProb), id(probRow), false, by);
    eq(d.verdict, 'different', 'נשמר "שונה"');
    const dec = await ExpenseIdentityDecision.findOne({ expense_id: ourProb._id }).lean();
    eq(dec && String(dec.decided_by), String(by), 'decided_by');
    eq((await bridge.pendingIdentityQuestions()).length, 0, 'אין שאלות');
    const after = await bridge.syncBridge();
    eq(after.created, 1, 'אחרי "שונה" — נוצר מסמך אייקאונט נפרד');
    eq((await ExpenseDocument.findById(ourProb._id).lean()).icount_id, null, 'המסמך שלנו נשאר בלי קישור');
    const again2 = await bridge.decideIdentity(id(ourProb), id(probRow), false, by);
    eq(again2.verdict, 'different', 'החלטה חוזרת — upsert');
    eq(await ExpenseIdentityDecision.countDocuments(), 1, 'שורת החלטה אחת');
  }

  console.log('decideIdentity — "אותו מסמך": קישור, תאום מבוטל, תשלומים עוברים');
  await reset();
  {
    const row = await mirrorRow({ doc_number: 'Q-1', amount_total: 900 });
    await bridge.syncBridge();
    const twin = await ExpenseDocument.findOne({ icount_id: row.icount_id }).lean();
    eq(twin && twin.source, 'icount', 'נוצר תאום אייקאונט');
    const t1 = await tx({ amount: -600 });
    const t2 = await tx({ amount: -400 });
    await ExpensePayment.create({ document_id: twin._id, transaction_id: t1._id, amount: 600 });
    await ExpensePayment.create({ document_id: twin._id, transaction_id: t2._id, amount: 300 });
    // the mail copy arrives later with a differently printed number → only probable
    const mine = await ours({ doc_number: 'Q-1-COPY', amount_total: 900, doc_date: '2026-09-11' });
    await ExpensePayment.create({ document_id: mine._id, transaction_id: t2._id, amount: 100 });

    const qs = await bridge.pendingIdentityQuestions();
    eq(qs.length, 1, 'שאלה גם כשכבר יש תאום אייקאונט');
    eq(qs[0] && String(qs[0].icount_document_id), id(twin), 'השאלה מצביעה על התאום');

    await refuses(() => bridge.decideIdentity(id(twin), id(row), true), 400, 'מסמך אייקאונט עצמו אינו "המסמך שלנו"');
    const r = await bridge.decideIdentity(id(mine), id(row), true);
    eq(r.verdict, 'same', 'נשמר "אותו"');
    eq(r.moved, 1, 'תשלום אחד הועבר');
    eq(r.combined, 1, 'חיוב שכבר משלם גם את המסמך שלנו — אוחד');
    const m = await ExpenseDocument.findById(mine._id).lean();
    eq(m.icount_id, row.icount_id, 'המסמך שלנו קושר');
    const tw = await ExpenseDocument.findById(twin._id).lean();
    eq(tw.status, 'void', 'התאום בוטל');
    eq(tw.icount_id, null, 'התאום שחרר את icount_id');
    eq(await ExpensePayment.countDocuments({ document_id: twin._id }), 0, 'לתאום לא נשארו תשלומים');
    eq(await ExpensePayment.countDocuments({ document_id: mine._id }), 2, 'למסמך שלנו שני תשלומים');
    eq(await ExpensePayment.countDocuments({ document_id: mine._id, transaction_id: t2._id }), 1, 'חיוב t2 פעם אחת בלבד');
    eq((await ExpensePayment.findOne({ document_id: mine._id, transaction_id: t2._id }).lean()).amount, 400, 'הסכום אוחד: 300 + 100 = 400 (הכיסוי לא אבד)');
    eq((await ExpensePayment.findOne({ document_id: mine._id, transaction_id: t1._id }).lean()).amount, 600, 't1 עבר בסכומו');
    eq((await IcountExpense.findById(row._id).lean()).match_kind, 'same_document', 'המראה מעודכן');
    eq((await bridge.pendingIdentityQuestions()).length, 0, 'השאלה נסגרה');
    const s = await bridge.syncBridge();
    eq(s.created + s.linked, 0, 'סנכרון אחרי ההחלטה — בלי שינוי');
    eq(await ExpenseDocument.countDocuments({ status: 'active' }), 1, 'מסמך פעיל אחד');

    const other = await ours({ doc_number: 'Z', amount_total: 900 });
    await refuses(() => bridge.decideIdentity(id(other), id(row), true), 409, 'השורה כבר מקושרת למסמך אחר שלנו');
    await ExpenseDocument.updateOne({ _id: other._id }, { status: 'void' });
    await refuses(() => bridge.decideIdentity(id(other), id(row), false), 409, 'מסמך מבוטל');

    console.log('decideIdentity — "אותו" לפני שנוצר תאום');
    const row2 = await mirrorRow({ doc_number: 'R-1', amount_total: 55, doc_date: '2026-09-20' });
    const mine2 = await ours({ doc_number: 'R-other', amount_total: 55, doc_date: '2026-09-21' });
    eq((await bridge.syncBridge()).created, 0, 'סביר — לא נוצר');
    const r2 = await bridge.decideIdentity(id(mine2), id(row2), true);
    eq(r2.moved, 0, 'אין מה להעביר');
    eq((await ExpenseDocument.findById(mine2._id).lean()).icount_id, row2.icount_id, 'קושר מיד');
  }

  console.log('syncBridge — מסמך שלנו זהה בוודאות לתאום אייקאונט קיים → מיזוג');
  await reset();
  {
    const row = await mirrorRow({ doc_number: '0031', amount_total: 250 });
    await bridge.syncBridge();
    await ExpenseDocument.updateOne({ icount_id: row.icount_id }, { $set: { mail_sorter_id: 777, attachment_sha256: 'sha777' } });
    const twin = await ExpenseDocument.findOne({ icount_id: row.icount_id }).lean();
    const t = await tx({ amount: -250 });
    await ExpensePayment.create({ document_id: twin._id, transaction_id: t._id, amount: 250 });
    const typed = await ExpenseDocument.create({ source: 'manual', vendor_name: 'חשמל ישראל', supplier_tax_id: TAX_A,
      doc_number: '31', doc_date: '2026-09-10', amount_total: 250 });
    const r = await bridge.syncBridge();
    eq(r.linked, 1, 'קושר');
    eq(r.created, 0, 'לא נוצר');
    eq((await ExpenseDocument.findById(typed._id).lean()).icount_id, row.icount_id, 'המסמך שלנו קיבל icount_id');
    eq((await ExpenseDocument.findById(twin._id).lean()).status, 'void', 'התאום בוטל');
    eq(await ExpensePayment.countDocuments({ document_id: typed._id }), 1, 'התשלום עבר');
    const typedNow = await ExpenseDocument.findById(typed._id).lean();
    eq(typedNow.mail_sorter_id, 777, 'הקובץ (mail_sorter_id) עבר למסמך שלנו');
    eq(typedNow.attachment_sha256, 'sha777', 'וה-sha');
    eq((await ExpenseDocument.findById(twin._id).lean()).mail_sorter_id, undefined, 'התאום שחרר את mail_sorter_id');

    console.log('syncBridge — תאום סביר שנעלם → השורה מקבלת מסמך, סימון ישן נמחק');
    const pRow = await mirrorRow({ doc_number: 'PP-1', amount_total: 640, doc_date: '2026-09-22' });
    const pDoc = await ours({ doc_number: 'PP-x', amount_total: 640, doc_date: '2026-09-22' });
    eq((await bridge.syncBridge()).created, 0, 'סביר — ממתין');
    eq((await IcountExpense.findById(pRow._id).lean()).match_kind, 'probable', 'השורה מסומנת סבירה');
    await ExpenseDocument.updateOne({ _id: pDoc._id }, { status: 'void' });
    eq((await bridge.syncBridge()).created, 1, 'התאום בוטל — נוצר מסמך אייקאונט');
    const pAfter = await IcountExpense.findById(pRow._id).lean();
    eq(pAfter.match_kind, null, 'match_kind נוקה');
    eq(pAfter.matched_expense_id, null, 'matched_expense_id נוקה');
  }

  console.log('שורות שנעלמו / בוטלו באייקאונט');
  await reset();
  {
    const g1 = await mirrorRow({ doc_number: 'G-1' });
    const g2 = await mirrorRow({ doc_number: 'G-2' });
    const g3 = await mirrorRow({ doc_number: 'G-3' });
    const g4 = await mirrorRow({ doc_number: 'G-4' });
    const g6 = await mirrorRow({ doc_number: 'G-6' });
    const g7 = await mirrorRow({ doc_number: 'G-7' });
    const mineLinked = await ours({ doc_number: 'G-3' });
    await bridge.syncBridge();
    const d1 = await ExpenseDocument.findOne({ icount_id: g1.icount_id });
    const d2 = await ExpenseDocument.findOne({ icount_id: g2.icount_id });
    const d4 = await ExpenseDocument.findOne({ icount_id: g4.icount_id });
    const d6 = await ExpenseDocument.findOne({ icount_id: g6.icount_id });
    const d7 = await ExpenseDocument.findOne({ icount_id: g7.icount_id });
    await ExpenseDocument.updateOne({ _id: d6._id }, { $set: { mail_sorter_id: 606 } }); // the mailed file was attached
    const t = await tx({ amount: -100 });
    await ExpensePayment.create({ document_id: d2._id, transaction_id: t._id, amount: 100 });
    const t7 = await tx({ amount: -100 });
    await ExpensePayment.create({ document_id: d7._id, transaction_id: t7._id, amount: 100 });
    const goneAt = new Date('2026-09-28T10:00:00Z');
    await IcountExpense.updateMany({ _id: { $in: [g1._id, g2._id, g3._id, g6._id, g7._id] } }, { $set: { gone_at: goneAt } });
    await IcountExpense.updateOne({ _id: g4._id }, { $set: { is_storno: true } });

    const r = await bridge.syncBridge();
    eq(r.voided, 2, 'שני מסמכי אייקאונט בלי תשלומים בוטלו (נעלם + סטורנו)');
    eq(r.kept_gone, 4, 'עם תשלומים / עם קובץ / מסמך שלנו — נשארו עם סימון');
    const v6 = await ExpenseDocument.findById(d6._id).lean();
    eq(v6.status, 'active', 'נעלם אבל מחזיק את הקובץ מהמייל → נשאר');
    ok(!!v6.icount_gone_at, 'ומסומן icount_gone_at');
    const v1 = await ExpenseDocument.findById(d1._id).lean();
    eq(v1.status, 'void', 'נעלם בלי תשלומים → void');
    ok(!!v1.icount_gone_at, 'ועם icount_gone_at');
    eq((await ExpenseDocument.findById(d4._id).lean()).status, 'void', 'בוטל באייקאונט (סטורנו) בלי תשלומים → void');
    const v2 = await ExpenseDocument.findById(d2._id).lean();
    eq(v2.status, 'active', 'נעלם עם תשלומים → נשאר');
    eq(v2.icount_gone_at && v2.icount_gone_at.toISOString(), goneAt.toISOString(), 'מסומן icount_gone_at');
    eq(await ExpensePayment.countDocuments({ document_id: d2._id }), 1, 'התשלום נשאר');
    const v3 = await ExpenseDocument.findById(mineLinked._id).lean();
    eq(v3.status, 'active', 'מסמך שלנו שקושר — לא מבוטל');
    ok(!!v3.icount_gone_at, 'אבל מסומן שנעלם מאייקאונט');

    const again = await bridge.syncBridge();
    eq(again.voided, 0, 'הרצה חוזרת — לא מבטל שוב');

    // a person voids a flagged document; then the row comes back (a later complete pull un-gones it)
    await ExpenseDocument.updateOne({ _id: d7._id }, { status: 'void' });
    await IcountExpense.updateMany({ _id: { $in: [g1._id, g2._id, g3._id, g7._id] } }, { $set: { gone_at: null } });
    const back = await bridge.syncBridge();
    eq(back.created, 0, 'חזרה — לא נוצר מסמך חדש');
    eq((await ExpenseDocument.findById(d1._id).lean()).status, 'active', 'מסמך שבוטל בגלל היעלמות חוזר לפעיל');
    eq((await ExpenseDocument.findById(d1._id).lean()).icount_gone_at, null, 'הסימון נוקה');
    eq((await ExpenseDocument.findById(d2._id).lean()).icount_gone_at, null, 'סימון נוקה גם במסמך עם תשלומים');
    eq((await ExpenseDocument.findById(mineLinked._id).lean()).icount_gone_at, null, 'ובמסמך שלנו');
    eq((await ExpenseDocument.findById(d7._id).lean()).status, 'void', 'ביטול של אדם לא מתבטל כשהשורה חוזרת');
    eq(back.restored, 1, 'רק המסמך שהגשר ביטל חזר');

    // a person voided an iCount document: the bridge leaves it alone
    const g5 = await mirrorRow({ doc_number: 'G-5' });
    await bridge.syncBridge();
    await ExpenseDocument.updateOne({ icount_id: g5.icount_id }, { status: 'void' });
    const r5 = await bridge.syncBridge();
    eq(r5.created, 0, 'ביטול ידני — לא נוצר מחדש');
    eq((await ExpenseDocument.findOne({ icount_id: g5.icount_id }).lean()).status, 'void', 'ונשאר מבוטל');
  }

  console.log('מייל שמגיע אחרי מסמך אייקאונט → מצמיד קובץ');
  await reset();
  {
    const fake = (items) => {
      const acks = [];
      return { acks, listDocuments: async (k) => (k === 'invoice' ? items : []), ack: async (x) => { acks.push(x); } };
    };
    const item = (msId, extracted) => ({ id: msId, attachment_sha256: `sha${msId}`, extracted: {
      vendor_name: 'חשמל ישראל', supplier_tax_id: TAX_A, doc_date: '2026-09-10', amount_total: 100, doc_type: 'tax_invoice', currency: 'ILS', ...extracted,
    } });
    const rowSame = await mirrorRow({ doc_number: 'K-1' });
    const rowPunct = await mirrorRow({ doc_number: '0077 /2' });
    const rowHasFile = await mirrorRow({ doc_number: 'K-3' });
    const rowKind = await mirrorRow({ doc_number: 'KR/5' });
    await bridge.syncBridge();
    await ExpenseDocument.updateOne({ icount_id: rowHasFile.icount_id }, { $set: { mail_sorter_id: 500 } });

    const c = fake([item(901, { doc_number: 'K-1' }), item(902, { doc_number: '77/2' }), item(903, { doc_number: 'K-3' }), item(904, { doc_number: 'KR5', doc_type: 'receipt' })]);
    const r = await intake.pullFromMailSorter({ client: c });
    eq(r.created, 1, 'רק הקבלה (סוג שונה) נוצרה כמסמך חדש');
    eq(r.attached, 2, 'שני קבצים הוצמדו');
    eq(r.skipped, 1, 'מסמך אייקאונט שכבר יש לו קובץ — דילוג רגיל');
    eq(c.acks.slice().sort().join(','), '901,902,903,904', 'כל הפריטים אושרו');
    eq((await ExpenseDocument.findOne({ icount_id: rowKind.icount_id }).lean()).mail_sorter_id, undefined, 'קבלה במייל לא הפכה לקובץ של חשבונית אייקאונט');
    const a1 = await ExpenseDocument.findOne({ icount_id: rowSame.icount_id }).lean();
    eq(a1.mail_sorter_id, 901, 'mail_sorter_id הוצמד (אותו מספר)');
    eq(a1.attachment_sha256, 'sha901', 'sha הוצמד');
    eq(a1.source, 'icount', 'נשאר מסמך אייקאונט');
    eq(a1.needs_review, false, 'לא חוזר לבדיקה');
    eq((await ExpenseDocument.findOne({ icount_id: rowPunct.icount_id }).lean()).mail_sorter_id, 902, 'הוצמד גם כשהמספר מודפס אחרת');
    eq((await ExpenseDocument.findOne({ icount_id: rowHasFile.icount_id }).lean()).mail_sorter_id, 500, 'מסמך עם קובץ לא שונה');
    eq(await ExpenseDocument.countDocuments(), 5, 'ארבעה מסמכי אייקאונט + הקבלה');
    const again = await intake.pullFromMailSorter({ client: fake([item(901, { doc_number: 'K-1' })]) });
    eq(again.attached + again.created, 0, 'הרצה חוזרת — הפריט כבר מוכר');
  }

  console.log('הגשר מקשר מסמך שהעלינו ושמירתו נכשלה (icount_pending_id) → מסומן "הועלה"');
  await reset();
  {
    const filer = new mongoose.Types.ObjectId();
    const at = new Date('2026-09-15T10:00:00Z');
    const row = await mirrorRow({ doc_number: 'PD-1' });
    const mine = await ours({ doc_number: 'PD-1', icount_pending_id: row.icount_id, icount_pending_by: filer, icount_pending_at: at });
    const other = await mirrorRow({ doc_number: 'PD-2' });
    const plain = await ours({ doc_number: 'PD-2', icount_pending_id: 'NOT-THIS-ONE' });
    await bridge.syncBridge();
    const m = await ExpenseDocument.findById(mine._id).lean();
    eq(m.icount_id, row.icount_id, 'קושר');
    eq(m.icount_filed_at && m.icount_filed_at.toISOString(), at.toISOString(), 'icount_filed_at = מתי שהעלינו');
    eq(String(m.icount_filed_by), String(filer), 'icount_filed_by = מי שהעלה');
    ok(m.icount_pending_id === null && m.icount_pending_by === null && m.icount_pending_at === null, 'השדות הממתינים נוקו');
    const p = await ExpenseDocument.findById(plain._id).lean();
    ok(p.icount_id === other.icount_id && p.icount_filed_at === null && p.icount_pending_id === 'NOT-THIS-ONE', 'מזהה ממתין אחר — קישור רגיל, בלי "הועלה"');

    // the same through a merge with an iCount-sourced twin
    const row3 = await mirrorRow({ doc_number: 'PD-3' });
    await bridge.syncBridge(); // creates the twin
    const late = await ours({ doc_number: 'PD-3', icount_pending_id: row3.icount_id, icount_pending_by: filer, icount_pending_at: at });
    await bridge.syncBridge(); // merges ours into the twin
    const l = await ExpenseDocument.findById(late._id).lean();
    ok(l.icount_id === row3.icount_id && String(l.icount_filed_by) === String(filer) && l.icount_pending_id === null, 'גם במיזוג עם תאום — מסומן "הועלה", ממתין נוקה');
  }

  console.log('ביטול של אדם במסמך שלנו המקושר → השורה מקבלת מסמך משלה');
  await reset();
  {
    const { voidDocument } = require('../src/services/expenseWrites.service');
    const row = await mirrorRow({ doc_number: 'R-9' });
    const mine = await ours({ doc_number: 'R-9' });
    await bridge.syncBridge();
    eq((await ExpenseDocument.findById(mine._id).lean()).icount_id, row.icount_id, 'קושר');
    await voidDocument(mine._id);
    const res = await bridge.syncBridge();
    eq(res.created, 1, 'הסנכרון הבא יצר מסמך אייקאונט');
    const own = await ExpenseDocument.findOne({ icount_id: row.icount_id }).lean();
    eq(own && own.source, 'icount', 'השורה מוחזקת עכשיו במסמך שמקורו באייקאונט');
    eq(own && own.status, 'active', 'פעיל');
    eq((await ExpenseDocument.findById(mine._id).lean()).status, 'void', 'המסמך שבוטל נשאר מבוטל');
    eq((await bridge.syncBridge()).created, 0, 'הרצה חוזרת — לא נוצר שוב');
  }

  console.log('pullAndSync — משיכה ואז גשר');
  await reset();
  {
    const off = await bridge.pullAndSync({ client: { isConfigured: () => false, post: async () => { throw new Error('no network'); } } });
    eq(off.bridge, null, 'לא מחובר — הגשר לא רץ');
    ok(off.pull.errors.includes('לא מחובר'), 'מדווח "לא מחובר"');
    require('../src/services/icountSuppliers.service').clearSupplierCache();
    const client = { isConfigured: () => true, async post(method, params) {
      if (method === '/supplier/get_list') return { status: true, total_count: 1, results_list: [{ supplier_id: 11, supplier_name: 'חשמל', vat_id: TAX_A }] };
      if (method === '/expense/search' && String(params.supplier_id) === '11') {
        return { status: true, total_count: 1, results_list: [{ expense_id: 'W1', expense_docnum: 'W-1', expense_date: '2026-09-12', nis_sum: 77, expense_doctype: 'invrec' }] };
      }
      throw new Error(`unexpected ${method}`);
    } };
    const res = await bridge.pullAndSync({ client, gapMs: 0 });
    eq(res.pull.upserted, 1, 'שורה אחת נמשכה');
    eq(res.bridge && res.bridge.created, 1, 'ונוצר ממנה מסמך');
    eq((await ExpenseDocument.findOne({ icount_id: 'W1' }).lean())?.doc_type, 'invoice_receipt', 'doctype מהמשיכה נשמר וממופה');
  }

  // ── final review fixes ───────────────────────────────────────────────────
  const { ExpenseDocDecision, ExpenseUnpaidMark, IcountPaidReport } = require('../src/models');
  await Promise.all([ExpenseDocDecision.init(), ExpenseUnpaidMark.init(), IcountPaidReport.init()]);
  const resetAll = () => Promise.all([reset(), ExpenseDocDecision.deleteMany({}), ExpenseUnpaidMark.deleteMany({}), IcountPaidReport.deleteMany({})]);

  console.log('זהות לפי סוג מסמך — חשבונית 45 וזיכוי 45 אינם אותו מסמך');
  await resetAll();
  {
    const refund = await mirrorRow({ doc_number: '45', amount_total: 45, doctype: 'refund' });
    const inv = await ours({ doc_number: '45', amount_total: 45, doc_type: 'tax_invoice' });
    const refund2 = await mirrorRow({ doc_number: 'R-9', amount_total: 77, doctype: 'refund' });
    const inv2 = await ours({ doc_number: 'Q-9', amount_total: 77, doc_type: 'tax_invoice' });
    eq((await bridge.pendingIdentityQuestions()).length, 0, 'אין שאלת "אותו מסמך?" בין חשבונית לזיכוי');
    const r = await bridge.syncBridge();
    eq(r.linked, 0, 'הגשר לא מקשר חשבונית לזיכוי');
    eq(r.created, 2, 'לכל זיכוי נוצר מסמך משלו');
    eq((await ExpenseDocument.findById(inv._id).lean()).icount_id, null, 'החשבונית שלנו לא קיבלה את icount_id של הזיכוי');
    eq((await ExpenseDocument.findById(inv2._id).lean()).icount_id, null, 'גם לא דרך "סביר"');
    eq((await ExpenseDocument.findOne({ icount_id: refund.icount_id }).lean())?.doc_type, 'credit_note', 'מסמך הזיכוי — credit_note');
    eq((await IcountExpense.findById(refund2._id).lean()).match_kind, null, 'הזיכוי לא סומן "סביר"');
    await refuses(() => bridge.decideIdentity(inv._id, refund._id, true), 400, 'אישור ידני "אותו מסמך" בין חשבונית לזיכוי');
  }

  console.log('סוגי מסמכים שאינם הוצאה (הזמנה/תעודת משלוח/תלוש) — לא נוצר מסמך; import → חשבונית');
  await resetAll();
  {
    eq(bridge.docTypeFor('order'), null, 'order → אין מסמך');
    eq(bridge.docTypeFor('import'), 'tax_invoice', 'import → tax_invoice');
    await mirrorRow({ doctype: 'order' });
    await mirrorRow({ doctype: 'delcert' });
    await mirrorRow({ doctype: 'paycheck' });
    const imp = await mirrorRow({ doctype: 'import' });
    const r = await bridge.syncBridge();
    eq(r.created, 1, 'רק שורת היבוא הפכה למסמך');
    eq(r.skipped_doctype, 3, 'שלוש שורות נספרו skipped_doctype');
    eq((await ExpenseDocument.findOne({ icount_id: imp.icount_id }).lean())?.doc_type, 'tax_invoice', 'יבוא — חשבונית מס');
    eq(await ExpenseDocument.countDocuments({}), 1, 'אין מסמכים נוספים');
  }

  console.log('לא יוצרים מסמך לשורה שמסמך פעיל אחר כבר מחזיק (מספר אייקאונט אחר)');
  await resetAll();
  {
    const filedMine = await ours({ doc_number: 'F-1', icount_id: 'A-OLD' });
    const row = await mirrorRow({ doc_number: 'F-1' });
    const r = await bridge.syncBridge();
    eq(r.created, 0, 'לא נוצר מסמך כפול');
    eq(r.held, 1, 'השורה נעצרה (held)');
    const held = await IcountExpense.findById(row._id).lean();
    eq(held.match_kind, 'held', 'מסומנת held');
    eq(String(held.matched_expense_id), id(filedMine), 'מצביעה על המסמך שמחזיק את המסמך');
    ok(!(await ExpenseDocument.exists({ icount_id: row.icount_id })), 'אף מסמך לא קיבל את מספר השורה');

    console.log('אורלי הקלידה את אותו מסמך פעמיים באייקאונט');
    const t1 = await mirrorRow({ doc_number: 'T-2' });
    const t2 = await mirrorRow({ doc_number: 'T-2' });
    const r2 = await bridge.syncBridge();
    eq(r2.created, 1, 'נוצר מסמך אחד בלבד');
    eq(await ExpenseDocument.countDocuments({ icount_id: { $in: [t1.icount_id, t2.icount_id] } }), 1, 'מסמך אחד לשתי השורות');
    eq((await IcountExpense.findById(t2._id).lean()).match_kind, 'held', 'השורה השנייה held');
    const r3 = await bridge.syncBridge();
    eq(r3.created, 0, 'הרצה חוזרת — עדיין לא נוצר');
    eq(r3.held, 2, 'שתי השורות עדיין held');
    // the holder is voided by a person → the held row may get its own document now
    await ExpenseDocument.updateOne({ _id: filedMine._id }, { status: 'void' });
    const r4 = await bridge.syncBridge();
    eq(r4.created, 1, 'המחזיק בוטל — השורה מקבלת מסמך');
    eq((await IcountExpense.findById(row._id).lean()).match_kind, null, 'סימון held נוקה');
  }

  console.log('מיזוג לתאום — החלטה, "עוד לא שולמה" ודיווח ששולם עוברים למסמך שלנו');
  await resetAll();
  {
    const row = await mirrorRow({ doc_number: 'MV-1', amount_total: 300 });
    await bridge.syncBridge();
    const twin = await ExpenseDocument.findOne({ icount_id: row.icount_id }).lean();
    await ExpenseDocDecision.create({ document_id: twin._id, kind: 'paid_outside_bank', note: 'מזומן' });
    await ExpenseUnpaidMark.create({ document_id: twin._id });
    await IcountPaidReport.create({ document_id: twin._id, icount_id: row.icount_id, paid_date: '2026-09-12' });
    const typed = await ExpenseDocument.create({ source: 'manual', vendor_name: 'חשמל ישראל', supplier_tax_id: TAX_A,
      doc_number: 'MV-1', doc_date: '2026-09-10', amount_total: 300 });

    // a failure mid-move rolls the moves back
    const realUpdate = IcountPaidReport.updateOne;
    IcountPaidReport.updateOne = function () { IcountPaidReport.updateOne = realUpdate; throw new Error('boom'); };
    const failed = await bridge.syncBridge().then(() => null, e => e);
    IcountPaidReport.updateOne = realUpdate;
    ok(!!failed && /boom/.test(failed.message), 'כשל באמצע המיזוג');
    eq(String((await ExpenseDocDecision.findOne({}).lean()).document_id), id(twin), 'כשל — ההחלטה חזרה לתאום');
    eq(String((await ExpenseUnpaidMark.findOne({}).lean()).document_id), id(twin), 'כשל — הסימון חזר לתאום');
    eq((await ExpenseDocument.findById(typed._id).lean()).icount_id, null, 'כשל — המסמך שלנו לא קושר');

    const r = await bridge.syncBridge();
    eq(r.linked, 1, 'מוזג');
    eq(String((await ExpenseDocDecision.findOne({}).lean()).document_id), id(typed), 'ההחלטה עברה למסמך שלנו');
    eq(String((await ExpenseUnpaidMark.findOne({}).lean()).document_id), id(typed), '"עוד לא שולמה" עבר');
    eq(String((await IcountPaidReport.findOne({}).lean()).document_id), id(typed), 'הדיווח ששולם עבר');

    // ours already has its own decision → the twin's stays with the void twin
    const row2 = await mirrorRow({ doc_number: 'MV-2', amount_total: 310 });
    await bridge.syncBridge();
    const twin2 = await ExpenseDocument.findOne({ icount_id: row2.icount_id }).lean();
    await ExpenseDocDecision.create({ document_id: twin2._id, kind: 'closed_anyway' });
    const typed2 = await ExpenseDocument.create({ source: 'manual', vendor_name: 'חשמל ישראל', supplier_tax_id: TAX_A,
      doc_number: 'MV-2', doc_date: '2026-09-10', amount_total: 310 });
    await ExpenseDocDecision.create({ document_id: typed2._id, kind: 'paid_outside_bank' });
    eq((await bridge.syncBridge()).linked, 1, 'מוזג גם כשלמסמך שלנו יש החלטה');
    eq((await ExpenseDocDecision.findOne({ document_id: typed2._id }).lean()).kind, 'paid_outside_bank', 'ההחלטה שלנו נשארה');
    ok(!!(await ExpenseDocDecision.exists({ document_id: twin2._id })), 'של התאום נשארה עם התאום');
  }

  console.log('ביטול בגלל היעלמות — מסומן icount_voided_by_bridge באותה כתיבה');
  await resetAll();
  {
    const g = await mirrorRow({ doc_number: 'VB-1' });
    await bridge.syncBridge();
    await IcountExpense.updateOne({ _id: g._id }, { $set: { gone_at: new Date() } });
    eq((await bridge.syncBridge()).voided, 1, 'בוטל');
    const v = await ExpenseDocument.findOne({ icount_id: g.icount_id }).lean();
    eq(v.status, 'void', 'void'); eq(v.icount_voided_by_bridge, true, 'icount_voided_by_bridge'); ok(!!v.icount_gone_at, 'icount_gone_at');
  }

  await mongoose.disconnect(); await mongod.stop();
  console.log(failures ? `\n❌ ${failures} כשלונות` : '\n✅ הכל עבר');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
