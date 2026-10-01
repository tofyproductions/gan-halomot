#!/usr/bin/env node
/**
 * Kaplan income writes + cross-check report (spec §1).
 *
 *   node scripts/income-kaplan-writes.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c || !d ? '' : `  (${d})`}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const rejects = async (fn, status, l) => {
  try { await fn(); ok(false, l, 'לא נזרקה שגיאה'); } catch (e) {
    ok(e.status === status && /[א-ת]/.test(e.message), l, `status ${e.status} / ${e.message}`);
  }
};

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error('not loopback');
  await mongoose.connect(uri);
  const {
    BankAccount, BankTransaction, Branch, Registration, Child, Collection,
    IncomeAllocation, IncomeRejection, IncomePayerAlias,
  } = require('../src/models');
  const rules = require('../src/services/incomeRules.service');
  const K = require('../src/services/incomeKaplan.service');
  const W = require('../src/services/incomeKaplanWrites.service');

  console.log('\n✍️  כתיבות הכנסות קפלן + דוח הצלבה\n');

  await rules.seed();
  const kaplan = await Branch.create({ name: 'גן החלומות קפלן' });
  const bank = await BankAccount.create({ external_id: 'b:1', institution: 'beinleumi', label: 'בינלאומי', type: 'bank' });
  let seq = 0;
  const reg = (o) => Registration.create({
    unique_id: `U${++seq}`, child_name: `ילד ${seq}`, parent_name: 'הורה', monthly_fee: 3000,
    start_date: new Date(2025, 8, 1), end_date: new Date(2026, 7, 31), academic_year: '2025-2026',
    status: 'completed', branch_id: kaplan._id, ...o,
  });
  const tx = (o) => BankTransaction.create({
    account_id: bank._id, date: '2025-09-05', amount: 3000, description: 'העברה', hash: `h${++seq}`, ...o,
  });
  const levi = await reg({ child_name: 'נועה לוי', parent_name: 'דנה לוי', parent_id_number: '000000018' });
  const cohenA = await reg({ child_name: 'עומר כהן', parent_name: 'רותם כהן', parent_id_number: '000000026', monthly_fee: 3000 });
  const cohenB = await reg({ child_name: 'יעל כהן', parent_name: 'רותם כהן', parent_id_number: '000000026', monthly_fee: 2800 });
  await Child.create({ registration_id: levi._id, child_name: 'נועה לוי', academic_year: '2025-2026' });

  const hh = async () => K.kaplanHouseholds('2025-2026');
  const find = async (name) => (await hh()).find(h => h.parents.includes(name));
  const lv = await find('דנה לוי');
  const co = await find('רותם כהן');
  ok(lv && co, 'שתי משפחות נטענו');

  const snapshot = async () => JSON.stringify(await Collection.find({}).sort({ _id: 1 }).lean());
  await Collection.create({ registration_id: cohenA._id, academic_year: '2025-2026', months: [{ month_number: 9, receipt_number: '555' }] });
  const before = await snapshot();
  const regBefore = JSON.stringify(await Registration.find({}).sort({ _id: 1 }).lean());

  console.log('acceptIncome — ברירת מחדל');
  const t1 = await tx({ amount: 3000, description: 'העברה מדנה לוי' });
  {
    const r = await W.acceptIncome({ transaction_id: t1._id, household_key: lv.household_key, by: null });
    eq(r.allocations.length, 1, 'הקצאה אחת');
    const a = await IncomeAllocation.find({ transaction_id: t1._id }).lean();
    eq(a.length, 1, 'נשמרה');
    eq(a[0].month_number, 9, 'החודש הפתוח הראשון — ספטמבר');
    eq(a[0].amount, 3000, 'סכום מלא');
    eq(a[0].academic_year, '2025-2026', 'שנת לימודים');
    eq(a[0].household_key, lv.household_key, 'מפתח משפחה');
    eq(String(a[0].registration_id), String(levi._id), 'לרישום הנכון');
    const al = await IncomePayerAlias.findOne({}).lean();
    ok(al && al.household_key === lv.household_key, 'נשמר כינוי משלם');
    eq(al.payer_key, K.payerKey(t1), 'מפתח המשלם מנורמל');
  }

  console.log('acceptIncome — ולידציה');
  {
    await rejects(() => W.acceptIncome({ transaction_id: t1._id, household_key: lv.household_key }), 409, 'העברה שכבר הוקצתה במלואה — 409');
    await rejects(() => W.acceptIncome({ transaction_id: 'xx', household_key: lv.household_key }), 400, 'מזהה לא תקין — 400');
    await rejects(() => W.acceptIncome({ transaction_id: new mongoose.Types.ObjectId(), household_key: lv.household_key }), 404, 'העברה לא קיימת — 404');
    const t = await tx({ amount: 3000, description: 'אחר' });
    await rejects(() => W.acceptIncome({ transaction_id: t._id, household_key: 'nope' }), 404, 'משפחה לא קיימת — 404');
    await rejects(() => W.acceptIncome({ transaction_id: t._id, household_key: co.household_key,
      split: [{ registration_id: levi._id, month_number: 10, amount: 3000 }] }), 400, 'פיצול לילד של משפחה אחרת — 400');
    await rejects(() => W.acceptIncome({ transaction_id: t._id, household_key: co.household_key,
      split: [{ registration_id: cohenA._id, month_number: 10, amount: 3010 }] }), 400, 'סכום מעל ההעברה + 2 — 400');
    await rejects(() => W.acceptIncome({ transaction_id: t._id, household_key: co.household_key,
      split: [{ registration_id: cohenA._id, month_number: 99, amount: 100 }] }), 400, 'חודש לא קיים — 400');
    await rejects(() => W.acceptIncome({ transaction_id: t._id, household_key: co.household_key,
      split: [{ registration_id: cohenA._id, month_number: 10, amount: -5 }] }), 400, 'סכום שלילי — 400');
    eq(await IncomeAllocation.countDocuments({ transaction_id: t._id }), 0, 'כישלון לא השאיר הקצאות');
    const neg = await tx({ amount: -3000 });
    await rejects(() => W.acceptIncome({ transaction_id: neg._id, household_key: lv.household_key }), 400, 'תנועת הוצאה — 400');
    // within tolerance: 3001.5 of a 3000 transfer is fine
    const r = await W.acceptIncome({ transaction_id: t._id, household_key: co.household_key,
      split: [{ registration_id: cohenA._id, month_number: 10, amount: 3001.5 }] });
    eq(r.allocations.length, 1, 'סטייה של 1.5 ₪ מותרת');
  }

  console.log('acceptIncome — פיצול בין ילדים וחודשים');
  {
    const t = await tx({ amount: 5800, description: 'העברה', date: '2025-10-03' });
    const r = await W.acceptIncome({ transaction_id: t._id, household_key: co.household_key });
    const a = await IncomeAllocation.find({ transaction_id: t._id }).lean();
    eq(Math.round(a.reduce((s, x) => s + x.amount, 0)), 5800, 'סך ההקצאות = סכום ההעברה');
    ok(a.length >= 2, 'חולק בין כמה תאים');
    ok(r.allocations.length === a.length, 'התשובה מחזירה את ההקצאות');
    // a second accept on the same tx does not double-allocate
    await rejects(() => W.acceptIncome({ transaction_id: t._id, household_key: co.household_key }), 409, 'קבלה כפולה — 409');
  }

  console.log('צבירה — הקצאה חלקית ואז השלמה');
  {
    const t = await tx({ amount: 3000, description: 'חלקי', date: '2025-11-03' });
    await W.acceptIncome({ transaction_id: t._id, household_key: lv.household_key,
      split: [{ registration_id: levi._id, month_number: 10, amount: 1000 }] });
    await rejects(() => W.acceptIncome({ transaction_id: t._id, household_key: lv.household_key,
      split: [{ registration_id: levi._id, month_number: 11, amount: 2100 }] }), 400, 'הקצאה שנייה חורגת מהיתרה — 400');
    await W.acceptIncome({ transaction_id: t._id, household_key: lv.household_key,
      split: [{ registration_id: levi._id, month_number: 11, amount: 2000 }] });
    eq(await IncomeAllocation.countDocuments({ transaction_id: t._id }), 2, 'שתי הקצאות לאותה העברה');
  }

  console.log('מנעול לפי העברה — שתי קבלות במקביל');
  {
    const t = await tx({ amount: 3000, description: 'מרוץ', date: '2025-12-03' });
    const res = await Promise.allSettled([
      W.acceptIncome({ transaction_id: t._id, household_key: lv.household_key, split: [{ registration_id: levi._id, month_number: 12, amount: 3000 }] }),
      W.acceptIncome({ transaction_id: t._id, household_key: co.household_key, split: [{ registration_id: cohenA._id, month_number: 12, amount: 3000 }] }),
    ]);
    eq(res.filter(r => r.status === 'fulfilled').length, 1, 'רק אחת הצליחה');
    eq(await IncomeAllocation.countDocuments({ transaction_id: t._id }), 1, 'הקצאה אחת בלבד');
  }

  console.log('rejectIncome');
  {
    const t = await tx({ amount: 777, description: 'דחייה' });
    await W.rejectIncome({ transaction_id: t._id, household_key: lv.household_key });
    await W.rejectIncome({ transaction_id: t._id, household_key: lv.household_key });
    eq(await IncomeRejection.countDocuments({ transaction_id: t._id }), 1, 'נשמרה פעם אחת (אידמפוטנטי)');
    const alts = await K.alternativesForTx(t._id);
    ok(alts.every(a => a.household.household_key !== lv.household_key), 'המשפחה שנדחתה לא מוצעת שוב');
    await rejects(() => W.rejectIncome({ transaction_id: t._id, household_key: '' }), 400, 'בלי משפחה — 400');
    await rejects(() => W.rejectIncome({ transaction_id: new mongoose.Types.ObjectId(), household_key: lv.household_key }), 404, 'העברה לא קיימת — 404');
  }

  console.log('unallocate');
  {
    const t = await tx({ amount: 3000, description: 'לביטול', date: '2026-01-04' });
    await W.acceptIncome({ transaction_id: t._id, household_key: lv.household_key });
    const r = await W.unallocate(t._id);
    ok(r.removed >= 1, 'הוסרו הקצאות');
    eq(await IncomeAllocation.countDocuments({ transaction_id: t._id }), 0, 'אין הקצאות');
    const pool = await K.incomePool();
    ok(pool.open.some(x => String(x._id) === String(t._id)), 'חזרה למאגר הפתוח');
    eq((await W.unallocate(t._id)).removed, 0, 'פעם שנייה — 0 (אידמפוטנטי)');
    await rejects(() => W.unallocate('zz'), 400, 'מזהה לא תקין — 400');
  }

  console.log('כינוי משלם — ההעברה הבאה מקבלת 100');
  {
    const t = await tx({ amount: 1234, description: 'העברה מדנה לוי', date: '2026-02-03' });
    const hs = await hh();
    const h = hs.find(x => x.household_key === lv.household_key);
    const sc = K.scoreIncome({ ...t.toObject(), remaining: 1234 }, h, new Map((await IncomePayerAlias.find({}).lean()).map(a => [a.payer_key, a.household_key])));
    eq(sc.score, 100, 'ניקוד 100 ממשלם מוכר');
  }

  console.log('כינוי משלם — בטיחות');
  {
    const gen = async (desc, counterparty) => {
      const t = await tx({ amount: 3000, description: desc, counterparty, date: '2026-03-03' });
      const r = await W.acceptIncome({ transaction_id: t._id, household_key: co.household_key,
        split: [{ registration_id: cohenA._id, month_number: 3, amount: 100 }] });
      return { t, r };
    };
    const n0 = await IncomePayerAlias.countDocuments({});
    eq((await gen('העברה')).r.alias, 'skipped', 'טקסט גנרי "העברה" — בלי כינוי');
    eq((await gen('העברה בנקאית')).r.alias, 'skipped', 'ביטוי גנרי — בלי כינוי');
    eq((await gen('ביט', 'PayBox')).r.alias, 'skipped', 'ביט/paybox — בלי כינוי');
    eq((await gen('אבי')).r.alias, 'skipped', 'קצר מ-4 תווים — בלי כינוי');
    eq((await gen('')).r.alias, 'skipped', 'ריק — בלי כינוי');
    eq(await IncomePayerAlias.countDocuments({}), n0, 'לא נוצרו כינויים');

    const t1 = await tx({ amount: 3000, description: 'משלם מיוחד אחד', date: '2026-04-03' });
    const r1 = await W.acceptIncome({ transaction_id: t1._id, household_key: co.household_key,
      split: [{ registration_id: cohenA._id, month_number: 4, amount: 100 }] });
    eq(r1.alias, 'created', 'כינוי חדש נוצר');
    const a1 = await IncomePayerAlias.findOne({ payer_key: K.payerKey(t1) }).lean();
    eq(String(a1.source_transaction_id), String(t1._id), 'נשמר source_transaction_id');
    const t2 = await tx({ amount: 3000, description: 'משלם מיוחד אחד', date: '2026-04-05' });
    const r2 = await W.acceptIncome({ transaction_id: t2._id, household_key: lv.household_key,
      split: [{ registration_id: levi._id, month_number: 4, amount: 100 }] });
    eq(r2.alias, 'conflict', 'ממופה ל-B, אישור ל-A — קונפליקט');
    eq((await IncomePayerAlias.findOne({ payer_key: K.payerKey(t1) }).lean()).household_key, co.household_key, 'המיפוי הישן נשמר');
    const t3 = await tx({ amount: 3000, description: 'משלם מיוחד אחד', date: '2026-04-07' });
    eq((await W.acceptIncome({ transaction_id: t3._id, household_key: co.household_key,
      split: [{ registration_id: cohenA._id, month_number: 5, amount: 100 }] })).alias, 'same', 'אותה משפחה — same');
    await W.unallocate(t2._id);
    ok(await IncomePayerAlias.findOne({ payer_key: K.payerKey(t1) }), 'ביטול של עסקה שלא יצרה את הכינוי — הכינוי נשאר');
    await W.unallocate(t1._id);
    eq(await IncomePayerAlias.countDocuments({ payer_key: K.payerKey(t1) }), 0, 'ביטול העסקה שיצרה — הכינוי נמחק');

    // rollback leaves no alias: force a failure after the alias step
    const t4 = await tx({ amount: 3000, description: 'משלם לגלגול', date: '2026-05-03' });
    const orig = IncomeRejection.find;
    IncomeRejection.find = () => { throw new Error('boom'); };
    try { await W.acceptIncome({ transaction_id: t4._id, household_key: co.household_key,
      split: [{ registration_id: cohenA._id, month_number: 5, amount: 100 }] }); ok(false, 'אמור להיכשל'); } catch (e) { ok(e.message === 'boom', 'כשל אחרי כינוי'); }
    IncomeRejection.find = orig;
    eq(await IncomePayerAlias.countDocuments({ payer_key: K.payerKey(t4) }), 0, 'גלגול לאחור — אין כינוי');
    eq(await IncomeAllocation.countDocuments({ transaction_id: t4._id }), 0, 'גלגול לאחור — אין הקצאות');
  }

  console.log('קבלה מנקה דחייה; פיצול כפול; תקרת תא; שנה מפורשת');
  {
    const t = await tx({ amount: 3000, description: 'דחוי ואז אושר', date: '2026-05-10' });
    await W.rejectIncome({ transaction_id: t._id, household_key: lv.household_key });
    await W.acceptIncome({ transaction_id: t._id, household_key: lv.household_key,
      split: [{ registration_id: levi._id, month_number: 5, amount: 100 }] });
    eq(await IncomeRejection.countDocuments({ transaction_id: t._id }), 0, 'הדחייה נמחקה בקבלה');
    const cell6 = (await find('רותם כהן')).children.find(c => String(c.registration_id) === String(cohenA._id)).months.find(m => m.month_number === 6);
    const u = await tx({ amount: cell6.expected + 10, description: 'כפילות', date: '2026-05-11' });
    await rejects(() => W.acceptIncome({ transaction_id: u._id, household_key: co.household_key, split: [
      { registration_id: cohenA._id, month_number: 6, amount: 100 }, { registration_id: cohenA._id, month_number: 6, amount: 100 }] }), 400, 'אותו (ילד, חודש) פעמיים — 400');
    await rejects(() => W.acceptIncome({ transaction_id: u._id, household_key: co.household_key, split: [
      { registration_id: cohenA._id, month_number: 6, amount: cell6.expected + 3 }] }), 400, 'מעל הפתוח בתא + 2 — 400');
    await rejects(() => W.acceptIncome({ transaction_id: u._id, household_key: co.household_key, academic_year: '2026', split: [
      { registration_id: cohenA._id, month_number: 6, amount: 100 }] }), 400, 'שנה לא תקינה — 400');
    await rejects(() => W.acceptIncome({ transaction_id: u._id, household_key: co.household_key, academic_year: '2031-2032' }), 404, 'שנה בלי משפחה — 404');
    const r = await W.acceptIncome({ transaction_id: u._id, household_key: co.household_key, academic_year: '2025-2026',
      split: [{ registration_id: cohenA._id, month_number: 6, amount: 100 }] });
    eq(r.allocations[0].academic_year, '2025-2026', 'שנה מפורשת נשמרת');
  }

  console.log('loadTransaction — רק מה שבבריכה הפתוחה');
  {
    const emuna = await tx({ amount: 3000, description: 'העברה מאמונה' });
    await rejects(() => W.acceptIncome({ transaction_id: emuna._id, household_key: lv.household_key }), 409, 'העברה שכלל הכנסה תופס — 409');
    await rejects(() => W.rejectIncome({ transaction_id: emuna._id, household_key: lv.household_key }), 409, 'דחייה של העברה מכלל הכנסה — 409');
    const early = await tx({ amount: 3000, date: '1999-01-01', description: 'ישנה' });
    await rejects(() => W.acceptIncome({ transaction_id: early._id, household_key: lv.household_key }), 409, 'לפני תאריך ההתחלה — 409');
    const pending = await tx({ amount: 3000, status: 'pending', description: 'ממתינה' });
    await rejects(() => W.acceptIncome({ transaction_id: pending._id, household_key: lv.household_key }), 409, 'לא הושלמה — 409');
    const internal = await tx({ amount: 3000, is_internal_transfer: true });
    await rejects(() => W.acceptIncome({ transaction_id: internal._id, household_key: lv.household_key }), 400, 'העברה פנימית — 400');
    const card = await BankAccount.create({ external_id: 'c:1', institution: 'max', label: 'כרטיס', type: 'card' });
    const cardTx = await BankTransaction.create({ account_id: card._id, date: '2025-09-05', amount: 100, description: 'זיכוי', hash: `h${++seq}` });
    await rejects(() => W.acceptIncome({ transaction_id: cardTx._id, household_key: lv.household_key }), 400, 'לא חשבון בנק — 400');
    eq(await IncomeAllocation.countDocuments({ transaction_id: { $in: [emuna._id, early._id, pending._id] } }), 0, 'כישלון לא הקצה דבר');
  }

  console.log('matchedTransfers — כל הפרוסות');
  {
    await IncomeAllocation.deleteMany({});
    const t = await tx({ amount: 6000, date: '2025-09-06', description: 'שתי שנים' });
    await W.acceptIncome({ transaction_id: t._id, household_key: lv.household_key,
      split: [{ registration_id: levi._id, month_number: 9, amount: 3000 }] });
    await IncomeAllocation.create({ transaction_id: t._id, registration_id: cohenA._id, household_key: co.household_key,
      academic_year: '2026-2027', month_number: 9, amount: 3000 });
    const inCurrent = await W.matchedTransfers('2025-2026');
    eq(inCurrent.length, 1, 'ההעברה מופיעה בשנה המבוקשת');
    eq(inCurrent[0].allocations.length, 2, 'שתי הפרוסות, גם של שנה אחרת');
    eq(inCurrent[0].total, 6000, 'הסכום כולל את כל הפרוסות');
    const years = inCurrent[0].allocations.map(a => a.academic_year).sort().join(',');
    eq(years, '2025-2026,2026-2027', 'כל פרוסה נושאת שנה');
    ok(inCurrent[0].allocations.some(a => a.parents.includes('דנה לוי')), 'משפחה לפרוסה הראשונה');
    eq((await W.matchedTransfers('2026-2027')).length, 1, 'מופיעה גם בשנה האחרת');
    eq((await W.matchedTransfers('2024-2025')).length, 0, 'שנה בלי פרוסות — ריק');
    eq((await W.unallocate(t._id)).removed, 2, 'ביטול מסיר את כל הפרוסות שהוצגו');
  }

  console.log('\nkaplanMonthReport');
  {
    await IncomeAllocation.deleteMany({});
    await IncomePayerAlias.deleteMany({});
    await BankTransaction.deleteMany({});
    await Collection.deleteMany({});
    // receipts: levi month 9 (receipt), cohenA month 9 (paid, no receipt number)
    await Collection.create({ registration_id: levi._id, academic_year: '2025-2026', months: [{ month_number: 9, receipt_number: '700' }] });
    await Collection.create({ registration_id: cohenA._id, academic_year: '2025-2026', months: [{ month_number: 9, payment_status: 'paid' }] });
    // bank: levi month 9 (match), cohenB month 10 (bank, no receipt)
    const a = await tx({ amount: 3000, date: '2025-09-04' });
    await W.acceptIncome({ transaction_id: a._id, household_key: lv.household_key,
      split: [{ registration_id: levi._id, month_number: 9, amount: 3000 }] });
    const b = await tx({ amount: 2800, date: '2025-10-04' });
    await W.acceptIncome({ transaction_id: b._id, household_key: co.household_key,
      split: [{ registration_id: cohenB._id, month_number: 10, amount: 2800 }] });

    const rep = await W.kaplanMonthReport('2025-2026');
    const m9 = rep.months.find(m => m.month_number === 9);
    const m10 = rep.months.find(m => m.month_number === 10);
    eq(rep.academic_year, '2025-2026', 'שנת לימודים בדוח');
    eq(rep.months.length >= 12, true, 'כל חודשי השנה');
    // sep expected: levi 3000 + cohenA 3000 + cohenB 2800 (discounts may apply to siblings — compare to engine)
    const eng = (await hh());
    const exp9 = eng.reduce((s, h) => s + h.children.reduce((t, c) => t + (c.months.find(x => x.month_number === 9)?.expected || 0), 0), 0);
    eq(m9.expected, exp9, 'צפוי ספטמבר = סכום המנוע');
    eq(m9.in_bank, 3000, 'נמצא בבנק ספטמבר');
    const cA9 = eng.flatMap(h => h.children).find(c => String(c.registration_id) === String(cohenA._id)).months.find(x => x.month_number === 9).expected;
    eq(m9.by_receipt, 3000 + cA9, 'לפי קבלה ספטמבר — קבלה + סטטוס שולם');
    eq(m10.in_bank, 2800, 'נמצא בבנק אוקטובר');
    eq(m10.by_receipt, 0, 'אין קבלות באוקטובר');
    ok(rep.receipt_no_bank.some(x => String(x.registration_id) === String(cohenA._id) && x.month_number === 9), 'קבלה (שולם) בלי בנק — כהן עומר ספטמבר');
    ok(!rep.receipt_no_bank.some(x => String(x.registration_id) === String(levi._id)), 'לוי — קבלה ובנק, לא ברשימה');
    ok(rep.bank_no_receipt.some(x => String(x.registration_id) === String(cohenB._id) && x.month_number === 10), 'כסף בבנק בלי קבלה — כהן יעל אוקטובר');
    const row = rep.bank_no_receipt.find(x => String(x.registration_id) === String(cohenB._id));
    ok(row && row.child_name === 'יעל כהן' && row.allocated === 2800 && row.household_key, 'שורת רשימה כוללת שם, סכום ומפתח');
    eq((await W.kaplanMonthReport('2031-2032')).months.every(m => m.expected === 0 && m.in_bank === 0), true, 'שנה בלי משפחות — אפסים');
  }

  console.log('\nהגבייה לא נכתבת');
  {
    // Re-seed the exact pre-write state for a byte comparison across a fresh round of writes.
    await IncomeAllocation.deleteMany({});
    await Collection.deleteMany({});
    await Collection.create({ registration_id: cohenA._id, academic_year: '2025-2026', months: [{ month_number: 9, receipt_number: '555' }] });
    const snap1 = await snapshot();
    const t = await tx({ amount: 3000, date: '2025-09-09', description: 'בדיקה' });
    await W.rejectIncome({ transaction_id: t._id, household_key: lv.household_key });
    await W.acceptIncome({ transaction_id: t._id, household_key: co.household_key });
    await W.unallocate(t._id);
    await W.kaplanMonthReport('2025-2026');
    eq(await snapshot(), snap1, 'מסמכי Collection זהים בתים-לבית אחרי קבלה, דחייה, ביטול ודוח');
    eq(JSON.stringify(await Registration.find({}).sort({ _id: 1 }).lean()), regBefore, 'Registration לא השתנה');
    ok(before.length > 0, 'סנאפשוט התחלתי נלקח');
  }

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n❌ ${failures} נכשלו\n` : '\n✅ הכול עבר\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
