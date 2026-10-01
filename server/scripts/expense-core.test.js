#!/usr/bin/env node
/**
 * Expenses core — the charge pool, a document's state and lane, duplicates,
 * supplier match and the "no invoice needed" rules (port notes §4, §6, §9).
 *
 *   node scripts/expense-core.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c || !d ? '' : `  (${d})`}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error('not loopback');
  await mongoose.connect(uri);
  const {
    BankAccount, BankTransaction, ExpenseDocument, ExpensePayment, ExpenseDocDecision,
    ExpenseUnpaidMark, NoInvoiceRule, Supplier,
  } = require('../src/models');
  const rules = require('../src/services/noInvoiceRules.service');
  const core = require('../src/services/expenseCore.service');

  let seq = 0;
  const bank = await BankAccount.create({ external_id: 'b:1', institution: 'beinleumi', label: 'בינלאומי ••••0463', type: 'bank' });
  const tx = (o) => BankTransaction.create({
    account_id: bank._id, date: '2026-09-10', amount: -100, description: 'ספק', hash: `h${++seq}`, ...o,
  });
  const doc = (o) => ExpenseDocument.create({
    source: 'manual', vendor_name: 'ספק', doc_type: 'tax_invoice', doc_number: `N${++seq}`,
    doc_date: '2026-09-01', amount_total: 1000, ...o,
  });
  const stateOf = async (id) => (await core.documentsWithState()).find(d => String(d._id) === String(id));

  console.log('\n🧾 ליבת ההוצאות\n');

  console.log('חוקי "לא צריך חשבונית"');
  {
    await rules.seed();
    const n1 = await NoInvoiceRule.countDocuments();
    await rules.seed();
    eq(await NoInvoiceRule.countDocuments(), n1, 'זריעה פעמיים — אותו מספר חוקים');
    eq(n1, 10, 'עשרה חוקים מובנים');
    eq(await NoInvoiceRule.countDocuments({ built_in: true }), 10, 'כולם מסומנים מובנים');
    const sal = await NoInvoiceRule.findOne({ pattern: 'משכורת', built_in: true }).lean();
    eq(sal && sal.note, 'התלוש הוא המסמך, לא חשבונית ספק', 'לחוק המשכורות נשמרה ההערה');
    await NoInvoiceRule.syncIndexes();
    await Promise.all([rules.seed(), rules.seed(), rules.seed()]);
    eq(await NoInvoiceRule.countDocuments({ built_in: true }), 10, 'שלוש זריעות במקביל — עדיין עשרה, בלי כפולים');
    const all = await NoInvoiceRule.find().lean();
    const m = rules.matchRule('העברה - משכורת ספטמבר', all);
    eq(m && m.label, 'משכורות', '"משכורת" נתפס בחוק המשכורות');
    eq(rules.matchRule('רמי לוי', all), null, 'ספק רגיל — אין חוק');
    eq(rules.matchRule('', all), null, 'תיאור ריק — אין חוק');
    const latin = rules.matchRule('BANK FEE', [{ label: 'עמלות', pattern: 'bank fee' }]);
    eq(latin && latin.label, 'עמלות', 'התאמה בלי תלות באותיות גדולות/קטנות');
    eq(rules.matchRule('משכורת', [{ label: 'כבוי', pattern: 'משכורת', is_active: false }]), null, 'חוק כבוי לא תופס');
  }

  console.log('\nמאגר החיובים');
  {
    const internal = await tx({ description: 'העברה לחיסכון', is_internal_transfer: true });
    const income = await tx({ amount: 500, description: 'הכנסה' });
    const full = await tx({ amount: -300, description: 'ספק מלא' });
    const part = await tx({ amount: -300, description: 'ספק חלקי' });
    const plain = await tx({ amount: -80, description: 'ספק פנוי' });
    const salary = await tx({ amount: -9000, description: 'העברת משכורות 09/26' });
    const settlement = await tx({ amount: -2000, description: 'מקס חיוב חודשי', matched_card_account_id: bank._id });
    const d = await doc({ amount_total: 600 });
    await ExpensePayment.create({ document_id: d._id, transaction_id: full._id, amount: 300 });
    await ExpensePayment.create({ document_id: d._id, transaction_id: part._id, amount: 120 });

    const { open, exempt } = await core.chargePool();
    const ids = open.map(t => String(t._id));
    ok(!ids.includes(String(internal._id)), 'העברה פנימית בחוץ');
    ok(!ids.includes(String(income._id)), 'הכנסה בחוץ');
    ok(!ids.includes(String(full._id)), 'חיוב שכוסה במלואו בחוץ');
    ok(!ids.includes(String(settlement._id)), 'חיוב כרטיס בבנק שקושר לכרטיס בחוץ');
    const p = open.find(t => String(t._id) === String(part._id));
    ok(!!p, 'חיוב שכוסה חלקית נשאר');
    eq(p && p.remaining, 180, 'ונשאר ממנו 180');
    eq(p && p.account_label, 'בינלאומי ••••0463', 'עם שם החשבון');
    eq(open.find(t => String(t._id) === String(plain._id))?.remaining, 80, 'חיוב פנוי — כל הסכום, חיובי');
    ok(!ids.includes(String(salary._id)), 'משכורות לא בתור');
    const ex = exempt.find(e => String(e.tx._id) === String(salary._id));
    ok(!!ex, 'אבל מוחזרות בנפרד — לא נעלמות');
    eq(ex && ex.rule.label, 'משכורות', 'עם החוק שתפס אותן');
    eq(ex && ex.rule.note, 'התלוש הוא המסמך, לא חשבונית ספק', 'ועם ההערה שלו');
    await BankTransaction.deleteMany({});
    await ExpensePayment.deleteMany({});
    await ExpenseDocument.deleteMany({});
  }

  console.log('\nמצב ומסלול של מסמך');
  {
    const t = await tx({ amount: -1000 });
    const almost = await doc({});
    await ExpensePayment.create({ document_id: almost._id, transaction_id: t._id, amount: 998 });
    const s1 = await stateOf(almost._id);
    eq(s1.paid, 998, 'שולם 998');
    eq(s1.remaining, 2, 'נשארו 2');
    eq(s1.lane, 'closed', '998 מתוך 1000 — סגור (סבילות 2 ₪)');
    eq(await core.isClosed(almost), true, 'isClosed מסכים');

    const short = await doc({});
    await ExpensePayment.create({ document_id: short._id, transaction_id: t._id, amount: 990 });
    const s2 = await stateOf(short._id);
    eq(s2.state, 'partial', '990 — חלקי');
    eq(s2.lane, 'open', '990 מתוך 1000 — פתוח');
    eq(await core.isClosed(short._id), false, 'isClosed לפי מזהה — לא סגור');

    const none = await doc({});
    eq((await stateOf(none._id)).lane, 'open', 'בלי תשלומים — פתוח');
    eq((await stateOf(none._id)).state, 'needs_match', 'ומצבו ממתין לשיוך');

    const anyway = await doc({});
    await ExpenseDocDecision.create({ document_id: anyway._id, kind: 'closed_anyway', note: 'ניכוי במקור' });
    eq((await stateOf(anyway._id)).lane, 'closed', '"סגור בכל זאת" — סגור');
    const outside = await doc({});
    await ExpenseDocDecision.create({ document_id: outside._id, kind: 'paid_outside_bank' });
    eq((await stateOf(outside._id)).lane, 'closed', '"שולם מחוץ לבנק" — סגור');

    const marked = await doc({});
    await ExpenseUnpaidMark.create({ document_id: marked._id });
    eq((await stateOf(marked._id)).lane, 'unpaid_marked', 'סומן "עוד לא שולם" — בלשונית הסגורים, מסומן');
    eq(await core.isClosed(marked), true, 'ו-isClosed מאפשר להעלות בכל זאת');

    const paidMarked = await doc({});
    await ExpensePayment.create({ document_id: paidMarked._id, transaction_id: t._id, amount: 1000 });
    await ExpenseUnpaidMark.create({ document_id: paidMarked._id });
    eq((await stateOf(paidMarked._id)).lane, 'closed', 'שולם במלואו וגם סומן "עוד לא שולם" — נשאר סגור');
    eq(await core.isClosed('not-an-id'), false, 'isClosed עם מזהה פגום — false, בלי שגיאה');

    const review = await doc({ needs_review: true });
    eq((await stateOf(review._id)).lane, 'review', 'מסמך שלא אושר — לבדיקה');

    const fx = await doc({ currency: 'USD', amount_original: 200, amount_total: 200 });
    const sfx = await stateOf(fx._id);
    eq(sfx.lane, 'awaiting_fx', 'מט״ח בלי אישור — ממתין לשקלים');
    eq(sfx.amount_ils, null, 'אין סכום בשקלים');

    const normal = await Supplier.create({ name: 'ספק רגיל' });
    const exemptSup = await Supplier.create({ name: 'עמותה', receipt_is_document: true });
    const r1 = await doc({ doc_type: 'receipt', supplier_id: normal._id });
    eq((await stateOf(r1._id)).lane, 'receipt', 'קבלה של ספק רגיל — לקבלות');
    const r2 = await doc({ doc_type: 'receipt', supplier_id: exemptSup._id });
    eq((await stateOf(r2._id)).lane, 'open', 'קבלה של עוסק פטור — מתנהגת כחשבונית');
    const r3 = await doc({ doc_type: 'receipt', supplier_id: normal._id, receipt_disposition: 'is_document' });
    eq((await stateOf(r3._id)).lane, 'open', 'קבלה שסומנה "היא המסמך" — כחשבונית');
    const ir = await doc({ doc_type: 'invoice_receipt' });
    eq((await stateOf(ir._id)).lane, 'open', 'חשבונית מס/קבלה היא חשבונית');

    const voided = await doc({ status: 'void' });
    eq(await stateOf(voided._id), undefined, 'מסמך מבוטל לא ברשימה');
    await ExpenseDocument.deleteMany({});
  }

  console.log('\nמפתח ספק');
  {
    eq(core.vendorKey('אבי ספקים בע"מ'), 'אבי ספקים', 'בע"מ יורד');
    eq(core.vendorKey('Acme-Foods Ltd'), 'acme foods', 'Ltd ומקפים');
    eq(core.vendorKey('  שופרסל  דיל '), 'שופרסל דיל', 'רווחים');
  }

  console.log('\nכפילויות');
  {
    const a = await doc({ vendor_name: 'אבי ספקים בע"מ', doc_number: '777', attachment_sha256: 'a'.repeat(64), mail_sorter_id: 41 });
    const hit = await core.findDuplicate({ vendor_name: 'אבי ספקים', doc_number: '777' });
    eq(hit && String(hit._id), String(a._id), 'אותו ספק (מנורמל) + אותו מספר — כפילות');
    eq(await core.findDuplicate({ vendor_name: 'ספק אחר', doc_number: '777' }), null, 'ספק אחר — לא כפילות');
    eq(await core.findDuplicate({ vendor_name: 'אבי ספקים', doc_number: '' }), null, 'בלי מספר מסמך — לא נבדק לפי ספק');
    const bySha = await core.findDuplicate({ attachment_sha256: 'a'.repeat(64) });
    eq(bySha && String(bySha._id), String(a._id), 'אותו קובץ (sha256) — כפילות');
    const byMail = await core.findDuplicate({ mail_sorter_id: 41 });
    eq(byMail && String(byMail._id), String(a._id), 'אותו מזהה במערכת המיון — כפילות');
    eq(await core.findDuplicate({ vendor_name: 'אבי ספקים', doc_number: '777' }, a._id), null, 'המסמך עצמו לא נחשב כפילות');
    const sup = await Supplier.create({ name: 'חברת חשמל' });
    const b = await doc({ supplier_id: sup._id, vendor_name: 'חח"י', doc_number: '55' });
    const bySup = await core.findDuplicate({ supplier_id: sup._id, vendor_name: 'חברת החשמל לישראל', doc_number: '55' });
    eq(bySup && String(bySup._id), String(b._id), 'אותו ספק במערכת + אותו מספר — כפילות גם כשהשם נקרא אחרת');
    const sup2 = await Supplier.create({ name: 'חברת חשמל' });
    eq(await core.findDuplicate({ supplier_id: sup2._id, vendor_name: 'חח"י', doc_number: '55' }), null,
      'שני ספקים שונים במערכת עם אותו שם — לא כפילות (המזהה מכריע כשיש לשניהם)');
    await ExpenseDocument.updateOne({ _id: a._id }, { status: 'void' });
    eq(await core.findDuplicate({ vendor_name: 'אבי ספקים', doc_number: '777' }), null, 'מסמך מבוטל משחרר את המספר');
    await ExpenseDocument.deleteMany({});
  }

  console.log('\nזיהוי ספק');
  {
    const before = await Supplier.countDocuments();
    const byName = await Supplier.create({ name: 'מאפיית הכפר בע"מ' });
    const byTax = await Supplier.create({ name: 'שם אחר לגמרי', tax_id: '51-234567-8' });
    const m1 = await core.matchSupplier({ supplier_tax_id: '512345678', vendor_name: 'מאפיית הכפר' });
    eq(m1 && String(m1._id), String(byTax._id), 'מספר עוסק קודם לשם');
    const m2 = await core.matchSupplier({ supplier_tax_id: '', vendor_name: 'מאפיית הכפר' });
    eq(m2 && String(m2._id), String(byName._id), 'בלי מספר — לפי שם מנורמל');
    eq(await core.matchSupplier({ supplier_tax_id: '999', vendor_name: 'לא קיים' }), null, 'לא נמצא — null, לא נוצר ספק');
    eq(await Supplier.countDocuments(), before + 2, 'ולא נוצר ספק');
  }

  console.log('\nתאריך התחלה');
  {
    const { Setting } = require('../src/models');
    await BankTransaction.deleteMany({}); await ExpenseDocument.deleteMany({}); await ExpensePayment.deleteMany({});
    eq(await core.getStartDate(), '2024-10-01', 'בלי הגדרה — ברירת מחדל 2024-10-01');
    await core.setStartDate('2026-09-01');
    const oldTx = await tx({ date: '2026-08-31', description: 'ספק ישן' });
    const newTx = await tx({ date: '2026-09-01', description: 'ספק חדש' });
    const oldDoc = await doc({ doc_date: '2026-08-31' });
    const newDoc = await doc({ doc_date: '2026-09-01' });
    const undated = await doc({ doc_date: '' });
    let pool = await core.chargePool();
    ok(!pool.open.some(t => String(t._id) === String(oldTx._id)), 'חיוב לפני תאריך ההתחלה — לא במאגר');
    ok(pool.open.some(t => String(t._id) === String(newTx._id)), 'חיוב ביום ההתחלה — במאגר');
    let ids = (await core.documentsWithState()).map(d => String(d._id));
    ok(!ids.includes(String(oldDoc._id)), 'מסמך לפני תאריך ההתחלה — לא מוצג');
    ok(ids.includes(String(newDoc._id)), 'מסמך ביום ההתחלה — מוצג');
    ok(ids.includes(String(undated._id)), 'מסמך בלי תאריך — תמיד מוצג (לא נעלם)');
    eq(await core.setStartDate('2026-08-01'), '2026-08-01', 'שינוי תאריך ההתחלה');
    eq((await Setting.findOne({ key: 'expenses_start_date' }).lean()).value, '2026-08-01', 'נשמר במפתח expenses_start_date');
    pool = await core.chargePool();
    ok(pool.open.some(t => String(t._id) === String(oldTx._id)), 'אחרי הקדמת התאריך — החיוב הישן חוזר');
    ids = (await core.documentsWithState()).map(d => String(d._id));
    ok(ids.includes(String(oldDoc._id)), 'אחרי הקדמת התאריך — המסמך הישן חוזר');
    let bad = null;
    try { await core.setStartDate('1.9.2026'); } catch (e) { bad = e; }
    eq(bad && bad.status, 400, 'תאריך לא תקין — 400');
    await Setting.updateOne({ key: 'expenses_start_date' }, { $set: { value: 'junk' } });
    eq(await core.getStartDate(), '2024-10-01', 'ערך שמור פגום — ברירת המחדל');
    await Setting.deleteMany({ key: 'expenses_start_date' });
    await BankTransaction.deleteMany({}); await ExpenseDocument.deleteMany({});
  }

  console.log('\nזיכוי — מסלול ניטרלי');
  {
    const cr = await doc({ doc_type: 'credit_note', amount_total: 300, doc_date: '2026-09-05' });
    const s = await stateOf(cr._id);
    eq(s.lane, 'credit', 'חשבונית זיכוי — מסלול credit');
    eq(s.remaining, 0, 'זיכוי לא נספר כחוב');
    const crReview = await doc({ doc_type: 'credit_note', amount_total: 300, doc_date: '2026-09-05', needs_review: true, source: 'mail_sorter' });
    eq((await stateOf(crReview._id)).lane, 'credit', 'גם זיכוי שלא נבדק — credit, לא review');
    await ExpenseDocument.deleteMany({});
  }

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n❌ ${failures} נכשלו\n` : '\n✅ הכל עבר\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
