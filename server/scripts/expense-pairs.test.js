#!/usr/bin/env node
/**
 * Expenses pair engine — scorePair, compareFields, pairQueue and the
 * alternatives lists (port notes §1, §2).
 *
 *   node scripts/expense-pairs.test.js
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
    BankAccount, BankTransaction, ExpenseDocument, ExpensePayment, ExpensePairRejection, Supplier,
  } = require('../src/models');
  const rules = require('../src/services/noInvoiceRules.service');
  const pairs = require('../src/services/expensePairs.service');
  const { scorePair, compareFields, pairQueue, alternativesForDoc, alternativesForTx } = pairs;

  console.log('\n🔗 מנוע הזוגות\n');

  // Pure objects for the scoring tests.
  const D = (o) => ({ vendor_name: 'חשמל ישראל', doc_number: '', doc_date: '2026-09-10', remaining: 1000, ...o });
  const T = (o) => ({ amount: -1000, date: '2026-09-10', description: 'הוראת קבע', ...o });

  console.log('scorePair');
  {
    const s = scorePair(D(), T());
    ok(s.score >= 55, `סכום זהה באותו יום — ${s.score} ≥ 55`);
    eq(s.score, 80, 'סכום זהה + אותו יום = 80');
    eq(s.reasons.join('|'), 'סכום זהה|אותו יום', 'הסיבות');
    eq(scorePair(D(), T({ amount: -1000.9 })).score, 80, 'הפרש של עד 1 ₪ — זהה');
    eq(scorePair(D(), T({ date: '2026-09-06' })).score, 0, 'חיוב 4 ימים לפני המסמך — 0');
    eq(scorePair(D(), T({ date: '2026-09-07' })).score, 80, 'חיוב 3 ימים לפני — עדיין "אותו יום"');
    eq(scorePair(D(), T({ date: '2026-12-10' })).score, 0, '91 ימים אחרי — 0');
    eq(scorePair(D(), T({ date: '2026-12-09' })).score, 63, '90 ימים אחרי — 55+8');
    eq(scorePair(D(), T({ date: '2026-10-25' })).score, 75, '45 ימים אחרי — 55+20');
    const approx = scorePair(D(), T({ amount: -1040 }));
    eq(approx.score, 55, 'הפרש 4% באותו יום — 55, עובר');
    eq(approx.reasons[0], 'הפרש 40 ₪', 'סיבת ההפרש');
    eq(scorePair(D(), T({ amount: -960 })).score, 55, '4% פחות — סימטרי (ניכוי במקור כבוי)');
    const late = scorePair(D(), T({ amount: -1040, date: '2026-09-30' }));
    ok(late.score < 55, `4% אחרי 20 יום בלי שם — ${late.score} < 55`);
    eq(late.score, 50, '30+20 = 50');
    eq(scorePair(D(), T({ amount: -1060 })).score, 0, 'הפרש 6% — 0');
    eq(scorePair(D({ remaining: 0 }), T()).score, 0, 'אין יתרה — 0');
    const named = scorePair(D(), T({ amount: -1040, date: '2026-09-30', description: 'חשמל ישראל בעמ' }));
    eq(named.score, 70, 'שם הספק בתנועה מוסיף 20');
    ok(named.reasons.includes('שם הספק מופיע בתנועה'), 'עם הסיבה');
    eq(scorePair(D(), T({ description: 'חברת חשמל' })).score, 88, 'חצי מהשם — "שם דומה" +8');
    eq(scorePair(D(), T({ description: 'x', counterparty: 'חשמל ישראל' })).score, 100, 'השם מהמוטב (counterparty) נספר; תקרה 100');
    eq(scorePair(D({ vendor_name: 'בע"מ' }), T({ description: 'בעמ' })).score, 80, 'שם שכולו סיומת — בלי ניקוד שם');
  }

  console.log('\ncompareFields');
  {
    const f = compareFields(D(), T({ transfer_note: 'חש 00123456', description: 'חשמל ישראל' }));
    eq(f.amount, 'ok', 'סכום זהה — ok');
    eq(f.date, 'ok', 'אותו יום — ok');
    eq(f.name, 'ok', 'שם — ok');
    eq(f.ref, 'none', 'אין מספר חשבונית — none');
    const g = compareFields(D({ doc_number: '123456' }), T({ amount: -800, date: '2026-09-30', transfer_note: 'חש 00123456' }));
    eq(g.amount, 'near', '20% פחות — near (טווח 35% במסך)');
    eq(g.date, 'near', '20 יום — near');
    eq(g.name, 'none', 'בלי שם — none');
    eq(g.ref, 'ok', 'מספר החשבונית בהעברה (אפסים מובילים) — ok');
    const h = compareFields(D(), T({ amount: -1200, date: '2026-09-07' }));
    eq(h.amount, 'bad', '20% יותר — bad');
    eq(h.date, 'bad', '3 ימים לפני — bad במסך');
    eq(compareFields(D(), T({ description: 'חברת חשמל' })).name, 'near', 'חצי שם — near');
  }

  // ---------------------------------------------------------------- DB part
  await rules.seed();
  let seq = 0;
  const bank = await BankAccount.create({ external_id: 'b:1', institution: 'beinleumi', label: 'בינלאומי ••••0463', type: 'bank' });
  const tx = (o) => BankTransaction.create({
    account_id: bank._id, date: '2026-09-10', amount: -100, description: 'תנועה', hash: `h${++seq}`, ...o,
  });
  const doc = (o) => ExpenseDocument.create({
    source: 'manual', vendor_name: 'ספק', doc_type: 'tax_invoice', doc_number: `N${++seq}`,
    doc_date: '2026-09-10', amount_total: 100, ...o,
  });
  const id = (x) => String(x._id);
  const pairOf = (q, d) => q.pairs.find(p => id(p.doc) === id(d));
  const reset = () => Promise.all([BankTransaction.deleteMany({}), ExpenseDocument.deleteMany({}),
    ExpensePayment.deleteMany({}), ExpensePairRejection.deleteMany({}), Supplier.deleteMany({})]);

  console.log('\npairQueue');
  {
    const charge = await tx({ amount: -500, date: '2026-09-12', description: 'אלקטרה' });
    const strong = await doc({ vendor_name: 'אלקטרה', amount_total: 500, doc_date: '2026-09-11' });
    const weak = await doc({ vendor_name: 'מישהו אחר', amount_total: 500, doc_date: '2026-09-01' });
    const q = await pairQueue();
    eq(q.pairs.length, 1, 'שני מסמכים על חיוב אחד — הצעה אחת');
    const p = pairOf(q, strong);
    ok(!!p, 'הציון הגבוה זוכה');
    eq(p && id(p.tx), id(charge), 'עם החיוב');
    eq(p && p.score, 100, 'ציון 55+25+20');
    eq(p && p.fields.amount, 'ok', 'עם שדות');
    const lost = q.unmatchedDocs.find(d => id(d) === id(weak));
    ok(!!lost, 'השני ב-unmatchedDocs');
    eq(lost && lost.why, 'לא נמצאה תנועה מתאימה', 'עם הסיבה');
    eq(q.unmatchedCharges.length, 0, 'אין חיובים פנויים');
    await reset();
  }
  {
    const c1 = await tx({ amount: -300, date: '2026-09-10' });
    const c2 = await tx({ amount: -300, date: '2026-09-20' });
    const d1 = await doc({ amount_total: 300, doc_date: '2026-09-10' });
    const d2 = await doc({ amount_total: 300, doc_date: '2026-09-19' });
    const q = await pairQueue();
    eq(q.pairs.length, 2, 'שני זוגות זהים בסכום — שתי הצעות');
    eq(id(pairOf(q, d1).tx), id(c1), 'כל מסמך עם החיוב הקרוב בתאריך (1)');
    eq(id(pairOf(q, d2).tx), id(c2), 'כל מסמך עם החיוב הקרוב בתאריך (2)');
    await reset();
  }
  {
    const charge = await tx({ amount: -250 });
    const d = await doc({ amount_total: 250 });
    await ExpensePairRejection.create({ document_id: d._id, transaction_id: charge._id });
    const q = await pairQueue();
    eq(q.pairs.length, 0, 'זוג שנדחה לא מוצע');
    ok(q.unmatchedDocs.some(x => id(x) === id(d)), 'המסמך בלי הצעה');
    ok(q.unmatchedCharges.some(x => id(x) === id(charge)), 'החיוב בלי מסמך');
    const alts = await alternativesForDoc(id(d));
    ok(!alts.some(a => id(a.tx) === id(charge)), 'וגם לא בחלופות');
    await reset();
  }
  {
    const charge = await tx({ amount: -420 });
    const d = await doc({ amount_total: 420, needs_review: true, source: 'mail_sorter', mail_sorter_id: 7 });
    const q = await pairQueue();
    const p = pairOf(q, d);
    ok(!!p, 'מסמך שממתין לאישור (needs_review) עדיין מוצע — לא נעלם');
    eq(p && id(p.tx), id(charge), 'עם החיוב שלו');
    await reset();
  }
  {
    // review docs that would not be pairable without the review flag stay out
    const t = await tx({ amount: -100 });
    const settled = await doc({ amount_total: 100, needs_review: true });
    await ExpensePayment.create({ document_id: settled._id, transaction_id: t._id, amount: 100 });
    const rcpt = await doc({ doc_type: 'receipt', amount_total: 70, needs_review: true });
    await tx({ amount: -70 });
    const q = await pairQueue();
    ok(![...q.pairs.map(p => p.doc), ...q.unmatchedDocs].some(d => id(d) === id(settled)), 'מסמך לאישור ששולם — לא בתור');
    ok(![...q.pairs.map(p => p.doc), ...q.unmatchedDocs].some(d => id(d) === id(rcpt)), 'קבלה לאישור — לא בתור (קבלות לא מזווגות)');
    await reset();
  }
  {
    const internal = await tx({ amount: -600, is_internal_transfer: true, description: 'העברה לחיסכון' });
    const d = await doc({ amount_total: 600 });
    const salary = await tx({ amount: -9000, description: 'העברת משכורות 09/26' });
    await doc({ amount_total: 9000 });
    const q = await pairQueue();
    const all = [...q.pairs.map(p => p.tx), ...q.unmatchedCharges, ...q.exemptCharges.map(e => e.tx)];
    ok(!all.some(t => id(t) === id(internal)), 'העברה פנימית לא מופיעה בשום מקום');
    ok(q.unmatchedDocs.some(x => id(x) === id(d)), 'והמסמך נשאר בלי הצעה');
    const ex = q.exemptCharges.find(e => id(e.tx) === id(salary));
    ok(!!ex, 'חיוב בחוק "לא צריך חשבונית" — בקבוצה נפרדת');
    eq(ex && ex.rule.label, 'משכורות', 'עם החוק');
    ok(!q.pairs.some(p => id(p.tx) === id(salary)), 'ולא מוצע לאף מסמך');
    const altsTx = await alternativesForTx(id(internal));
    eq(altsTx, null, 'חלופות לחיוב שלא בתור — null');
    await reset();
  }
  {
    // doc-number bonus lifts an approx + 20-days pair over the bar
    const charge = await tx({ amount: -1040, date: '2026-09-30', transfer_note: 'חש72971 03.09.26' });
    const d = await doc({ amount_total: 1000, doc_date: '2026-09-10', doc_number: '72971' });
    const q = await pairQueue();
    const p = pairOf(q, d);
    eq(p && p.score, 75, 'מספר החשבונית בהעברה: 50+25 = 75');
    ok(p && p.reasons.includes('מספר החשבונית כתוב בהעברה'), 'עם הסיבה');
    eq(p && id(p.tx), id(charge), 'עם החיוב');
    await reset();
  }
  {
    // partial: a doc partly paid is scored on what is still owed; a charge partly used on what is left of it
    const used = await tx({ amount: -1000 });
    const other = await doc({ amount_total: 600 });
    await ExpensePayment.create({ document_id: other._id, transaction_id: used._id, amount: 600 });
    const d = await doc({ amount_total: 400 });
    const q = await pairQueue();
    const p = pairOf(q, d);
    eq(p && id(p.tx), id(used), 'שארית של חיוב (400) מוצעת למסמך של 400');
    eq(p && p.score, 80, 'כסכום זהה');
    await reset();
  }
  {
    const nearly = await doc({ amount_total: 500 });
    const t = await tx({ amount: -497 });
    await ExpensePayment.create({ document_id: nearly._id, transaction_id: t._id, amount: 497 });
    // remaining 3 > 2 tolerance: still open and scorable, but no charge is left for it
    const fx = await doc({ currency: 'USD', amount_total: 100, needs_review: true });
    const q = await pairQueue();
    const f = q.unmatchedDocs.find(x => id(x) === id(fx));
    eq(f && f.why, 'מטבע חוץ — חסר הסכום בשקלים שהבנק חייב', 'מטבע חוץ לאישור — עם הסיבה');
    ok(q.unmatchedDocs.some(x => id(x) === id(nearly)), 'מסמך עם 3 ₪ פתוחים — בלי הצעה');
    await reset();
  }

  console.log('\nחלופות');
  {
    const d = await doc({ vendor_name: 'אלקטרה', amount_total: 1000, doc_date: '2026-09-10' });
    const charges = [];
    for (const [amount, date] of [[-1000, '2026-09-10'], [-1000, '2026-09-30'], [-1030, '2026-09-10'],
      [-990, '2026-10-20'], [-1040, '2026-11-20'], [-1500, '2026-09-11'], [-1200, '2026-09-12'], [-50, '2026-09-10']]) {
      charges.push(await tx({ amount, date }));
    }
    const alts = await alternativesForDoc(id(d));
    ok(alts.length <= 5, `לכל היותר 5 — ${alts.length}`);
    eq(alts.length, 5, 'בדיוק 5');
    const scores = alts.map(a => a.score);
    ok(scores.every((s, i) => i === 0 || scores[i - 1] >= s), `ממוינות לפי ציון — ${scores.join(',')}`);
    eq(scores.join(','), '80,75,55,50,38', 'כל ציון > 0 נכנס, גם מתחת ל-55');
    ok(alts.every(a => a.fields && a.reasons.length), 'עם שדות וסיבות');

    const fewer = await alternativesForDoc(id(d), 7);
    eq(fewer.length, 7, 'מילוי בסכום קרוב עד המגבלה');
    eq(fewer[5].score, 0, 'המילוי בציון 0');
    eq(fewer[5].reasons[0], 'סכום קרוב', 'עם "סכום קרוב"');
    eq(Math.abs(fewer[5].tx.amount), 1200, 'הקרוב ביותר בסכום קודם');
    eq(await alternativesForDoc(String(new mongoose.Types.ObjectId())), null, 'מסמך לא קיים — null');
    eq(await alternativesForDoc('zzz'), null, 'מזהה לא חוקי — null');

    const forTx = await alternativesForTx(id(charges[0]));
    eq(forTx.length, 1, 'חלופות לחיוב — המסמך היחיד');
    eq(forTx[0].score, 80, 'עם הציון');
    eq(id(forTx[0].doc), id(d), 'והמסמך');
    await reset();
  }
  {
    const fx = await doc({ vendor_name: 'Google Cloud', currency: 'USD', amount_total: 30, doc_date: '2026-09-10' });
    await tx({ amount: -111, date: '2026-09-15', description: 'GOOGLE CLOUD' });
    await tx({ amount: -95, date: '2026-09-10', description: 'סופר' });
    await tx({ amount: -95, date: '2026-11-10', description: 'GOOGLE CLOUD' });
    const alts = await alternativesForDoc(id(fx));
    eq(alts.length, 2, 'מטבע חוץ — רק חיובים בטווח -3..45 ימים');
    eq(alts[0].tx.description, 'GOOGLE CLOUD', 'השם הדומה קודם');
    eq(alts[0].score, 0, 'בציון 0');
    eq(alts[0].reasons.join('|'), 'מטבע חוץ — הסכום בשקלים יילקח מהחיוב|5 ימים אחרי|שם דומה', 'עם הסיבות');
    eq(alts[0].fields.amount, 'near', 'סכום near');
    eq(alts[0].fields.date, 'near', '5 ימים — near');
    eq(alts[1].reasons[1], 'אותו יום', 'אותו יום');
    eq((await alternativesForTx(id((await BankTransaction.findOne({ date: '2026-09-15' }))))).length, 0,
      'חלופות לחיוב לא כוללות מסמך במטבע חוץ');
    await reset();
  }

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכול עבר\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
