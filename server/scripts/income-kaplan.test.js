#!/usr/bin/env node
/**
 * Kaplan income engine — pool, households, scoring, queue, alternatives
 * (spec §1 of docs/superpowers/specs/2026-10-01-income-design.md).
 *
 *   node scripts/income-kaplan.test.js
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
    BankAccount, BankTransaction, Branch, Registration, Child, Collection,
    IncomeAllocation, IncomeRejection, IncomePayerAlias,
  } = require('../src/models');
  const rules = require('../src/services/incomeRules.service');
  const K = require('../src/services/incomeKaplan.service');
  const { scoreIncome, academicYearOfDate, payerKey } = K;

  console.log('\n🏦 מנוע הכנסות קפלן\n');

  console.log('academicYearOfDate');
  {
    eq(academicYearOfDate('2025-09-01'), '2025-2026', 'ספטמבר — השנה שמתחילה');
    eq(academicYearOfDate('2025-12-31'), '2025-2026', 'דצמבר — השנה שמתחילה');
    eq(academicYearOfDate('2026-01-05'), '2025-2026', 'ינואר — השנה שהתחילה בשנה הקודמת');
    eq(academicYearOfDate('2026-08-20'), '2025-2026', 'אוגוסט — סוף אותה שנה (בלי חיתוך 10 באוגוסט)');
    eq(academicYearOfDate(''), null, 'בלי תאריך — null');
  }

  // Pure household for the scoring tests: 3,000 a month, two parents.
  const H = (o) => ({
    household_key: 'h1',
    parents: ['דנה לוי', 'אבי לוי'],
    monthly_expected: 3000,
    month_totals: [3000],
    children: [{ registration_id: 'r1', child_name: 'נועה לוי', months: [
      { month_number: 9, expected: 3000, allocated: 0, receipt: null },
      { month_number: 10, expected: 3000, allocated: 0, receipt: null },
    ] }],
    ...o,
  });
  const T = (o) => ({ _id: 't1', amount: 3000, remaining: 3000, date: '2025-09-05', description: 'העברה', counterparty: null, ...o });

  console.log('\nscoreIncome');
  {
    const s = scoreIncome(T({ description: 'העברה מדנה לוי' }), H(), new Map());
    eq(s.score, 100, 'שם מלא (40) + סכום (45) + תאריך (15) = 100');
    ok(s.reasons.length === 3, 'שלוש סיבות');
    eq(scoreIncome(T(), H(), new Map()).score, 60, 'סכום + תאריך בלי שם = 60');
    eq(scoreIncome(T({ date: '2025-11-20' }), H(), new Map()).score, 45, 'סכום בלבד (נובמבר — לא חודש פתוח ולא לפניו) = 45');
    eq(scoreIncome(T({ date: '2025-09-28' }), H({ children: [{ registration_id: 'r1', child_name: 'נועה לוי', months: [
      { month_number: 9, expected: 3000, allocated: 3000, receipt: null },
      { month_number: 10, expected: 3000, allocated: 0, receipt: null },
    ] }] }), new Map()).score, 60, 'ספטמבר שולם, אוקטובר פתוח — העברה בחודש שלפני +15');
    eq(scoreIncome(T({ date: '2026-08-25' }), H({ children: [{ registration_id: 'r1', child_name: 'נועה לוי', months: [
      { month_number: 9, expected: 3000, allocated: 0, receipt: null },
    ] }] }), new Map()).score, 45, 'אוגוסט לא "לפני" ספטמבר של אותה שנת לימודים');
    eq(scoreIncome(T({ amount: 3001.5, remaining: 3001.5 }), H(), new Map()).score, 60, 'הפרש 1.5 ₪ — עדיין סכום זהה');
    eq(scoreIncome(T({ amount: 3003, remaining: 3003 }), H(), new Map()).score, 15, 'הפרש 3 ₪ — אין ניקוד סכום');
    eq(scoreIncome(T({ amount: 6000, remaining: 6000 }), H(), new Map()).score, 45, 'פעמיים הסכום = 30 + 15');
    eq(scoreIncome(T({ amount: 9000, remaining: 9000 }), H(), new Map()).score, 45, 'שלוש פעמים = 30 + 15');
    eq(scoreIncome(T({ amount: 12000, remaining: 12000 }), H(), new Map()).score, 15, 'ארבע פעמים — אין ניקוד סכום');
    eq(scoreIncome(T({ amount: 500, remaining: 500, counterparty: 'לוי אבי' }), H(), new Map()).score, 55,
      'שם ההורה השני מהמוטב (40) + תאריך = 55');
    eq(scoreIncome(T({ amount: 500, remaining: 500, description: 'לוי משה' }), H(), new Map()).score, 30,
      'חצי שם — +15');
    const alias = new Map([[payerKey(T({ description: 'BIT 123' })), 'h1']]);
    const a = scoreIncome(T({ amount: 77, remaining: 77, description: 'BIT 123' }), H(), alias);
    eq(a.score, 100, 'משלם מוכר — 100 גם בלי סכום');
    ok(a.reasons.includes('משלם מוכר'), 'עם הסיבה');
    eq(scoreIncome(T({ amount: 77, remaining: 77, description: 'BIT 123' }), H({ household_key: 'h2' }), alias).score, 15,
      'כינוי של משפחה אחרת — לא נספר (רק תאריך)');
    const campOnly = H({ children: [{ registration_id: 'r1', child_name: 'נועה לוי', months: [
      { month_number: 9, expected: 3000, allocated: 3000, receipt: null },
      { month_number: 13, expected: 900, allocated: 0, receipt: null },
    ] }] });
    eq(scoreIncome(T({ amount: 77, remaining: 77, date: '2026-07-10' }), campOnly, new Map()).score, 15, 'קייטנה פתוחה — העברה ביולי מקבלת ניקוד תאריך');
    eq(scoreIncome(T({ amount: 77, remaining: 77, date: '2026-05-10' }), campOnly, new Map()).score, 0, 'קייטנה — במאי לא');
    const flipped = new Map([[payerKey(T({ description: 'BIT 123' })), 'mom-key']]);
    eq(scoreIncome(T({ amount: 77, remaining: 77, description: 'BIT 123' }), H({ member_keys: ['h1', 'mom-key'] }), flipped).score, 100,
      'כינוי שנשמר תחת מפתח של חבר אחר במשפחה — עדיין 100');
    ok(K.householdMatchesKey(H({ member_keys: ['h1', 'mom-key'] }), 'mom-key'), 'householdMatchesKey — מפתח חבר');
    ok(K.householdMatchesKey(H(), 'h1'), 'householdMatchesKey — המפתח הראשי');
    ok(!K.householdMatchesKey(H({ member_keys: ['h1'] }), 'zzz'), 'householdMatchesKey — זר');
    eq(scoreIncome(T({ amount: 2950, remaining: 2950 }), H({ month_totals: [3000, 2950] }), new Map()).score, 60,
      'סכום של חודש אחר של המשפחה (חודש חלקי) — סכום זהה');
  }

  // ---------------------------------------------------------------- DB part
  await rules.seed();
  const kaplan = await Branch.create({ name: 'גן החלומות קפלן' });
  const other = await Branch.create({ name: 'משה דיין' });
  const bank = await BankAccount.create({ external_id: 'b:1', institution: 'beinleumi', label: 'בינלאומי', type: 'bank' });
  const card = await BankAccount.create({ external_id: 'c:1', institution: 'max', label: 'מקס', type: 'card' });
  let seq = 0;
  const reg = (o) => Registration.create({
    unique_id: `U${++seq}`, child_name: `ילד ${seq}`, parent_name: 'הורה', monthly_fee: 3000,
    start_date: new Date(2025, 8, 1), end_date: new Date(2026, 7, 31), academic_year: '2025-2026',
    status: 'completed', branch_id: kaplan._id, ...o,
  });
  const tx = (o) => BankTransaction.create({
    account_id: bank._id, date: '2025-09-05', amount: 3000, description: 'העברה', hash: `h${++seq}`, ...o,
  });
  const id = (x) => String(x._id);

  // Families (synthetic names).
  const levi = await reg({ child_name: 'נועה לוי', parent_name: 'דנה לוי', parent_id_number: '000000018' });
  await Child.create({ registration_id: levi._id, child_name: 'נועה לוי', academic_year: '2025-2026', parent2_name: 'אבי לוי' });
  const cohenA = await reg({ child_name: 'עומר כהן', parent_name: 'רותם כהן', parent_id_number: '000000026', monthly_fee: 3000 });
  const cohenB = await reg({ child_name: 'יעל כהן', parent_name: 'רותם כהן', parent_id_number: '000000026', monthly_fee: 2800 });
  const mizrahi = await reg({ child_name: 'איתי מזרחי', parent_name: 'שירן מזרחי', parent_id_number: '000000034', monthly_fee: 2500 });
  await reg({ child_name: 'זר', parent_name: 'דנה לוי', parent_id_number: '000000042', branch_id: other._id });

  console.log('\nincomePool');
  {
    const t1 = await tx({ amount: 3000 });
    const out = await tx({ amount: -3000 });
    const internal = await tx({ amount: 3000, is_internal_transfer: true });
    const old = await tx({ amount: 3000, date: '2024-01-01' });
    const onCard = await tx({ amount: 3000, account_id: card._id });
    const emuna = await tx({ amount: 40000, description: 'העברה', counterparty: 'עמותת אמונה' });
    const part = await tx({ amount: 3000 });
    await IncomeAllocation.create({ transaction_id: part._id, registration_id: levi._id, academic_year: '2025-2026', month_number: 9, amount: 1000 });
    const full = await tx({ amount: 3000 });
    await IncomeAllocation.create({ transaction_id: full._id, registration_id: levi._id, academic_year: '2025-2026', month_number: 10, amount: 2999 });
    const pool = await K.incomePool();
    const openIds = pool.open.map(id);
    ok(openIds.includes(id(t1)), 'תנועה נכנסת בחשבון בנק — במאגר');
    ok(!openIds.includes(id(out)), 'תנועה יוצאת — לא');
    ok(!openIds.includes(id(internal)), 'העברה פנימית — לא');
    ok(!openIds.includes(id(old)), 'לפני תאריך ההתחלה — לא');
    ok(!openIds.includes(id(onCard)), 'חשבון כרטיס — לא');
    ok(!openIds.includes(id(emuna)), 'העברה מאמונה — לא במאגר הפתוח');
    const ex = pool.exempt.find(e => id(e.tx) === id(emuna));
    ok(!!ex, 'אלא בפטורים');
    eq(ex && ex.rule.label, 'העברה מאמונה — בלשונית אמונה', 'עם החוק שתפס (מהמוטב)');
    const p = pool.open.find(t => id(t) === id(part));
    eq(p && p.remaining, 2000, 'יתרה = סכום פחות הקצאות');
    ok(!openIds.includes(id(full)), 'הוקצה כמעט כולו (2 ₪ סבילות) — לא במאגר');
    await BankTransaction.deleteMany({});
    await IncomeAllocation.deleteMany({});
  }

  console.log('\nkaplanHouseholds');
  {
    await Collection.create({ registration_id: cohenA._id, academic_year: '2025-2026', months: [{ month_number: 9, receipt_number: '555' }] });
    await IncomeAllocation.create({ transaction_id: new mongoose.Types.ObjectId(), registration_id: levi._id, academic_year: '2025-2026', month_number: 9, amount: 1200 });
    const hs = await K.kaplanHouseholds('2025-2026');
    eq(hs.length, 3, 'שלוש משפחות קפלן (הסניף האחר לא נספר)');
    const hl = hs.find(h => h.children.some(c => id({ _id: c.registration_id }) === id(levi)));
    ok(hl && hl.parents.includes('דנה לוי') && hl.parents.includes('אבי לוי'), 'שני ההורים — מהרישום ומ-parent2 של הילד');
    eq(hl && hl.monthly_expected, 3000, 'צפוי חודשי של משפחה');
    const sep = hl && hl.children[0].months.find(m => m.month_number === 9);
    eq(sep && sep.allocated, 1200, 'הוקצה לחודש — מהקצאות');
    eq(sep && sep.expected, 3000, 'צפוי לחודש');
    const hc = hs.find(h => h.children.length === 2);
    ok(!!hc, 'אחים — משפחה אחת עם שני ילדים');
    eq(hc && hc.monthly_expected, 5800, 'צפוי חודשי = סכום הילדים');
    const recA = hc && hc.children.find(c => id({ _id: c.registration_id }) === id(cohenA)).months.find(m => m.month_number === 9);
    eq(recA && recA.receipt, '555', 'קבלה של הילד');
    ok(hc && hc.children.some(c => String(c.registration_id) === id(cohenB)), 'הילד השני במשפחה');
    eq((await K.kaplanHouseholds('2024-2025')).length, 0, 'שנה אחרת — אין משפחות');
    await Collection.deleteMany({});
    await IncomeAllocation.deleteMany({});
  }

  console.log('\nincomeQueue');
  {
    const byName = await tx({ amount: 3000, date: '2025-09-04', description: 'העברה דנה לוי' });
    const two = await tx({ amount: 11600, date: '2025-09-03', counterparty: 'רותם כהן' });
    const q = await K.incomeQueue();
    const pl = q.pairs.find(p => id(p.tx) === id(byName));
    ok(!!pl, 'שם + סכום — מוצע');
    eq(pl && pl.score, 100, 'ציון 100');
    eq(pl && pl.split.length, 1, 'חלוקה לחודש אחד');
    eq(pl && pl.split[0].month_number, 9, 'החודש הפתוח הראשון — ספטמבר');
    eq(pl && pl.split[0].amount, 3000, 'כל הסכום');
    eq(pl && String(pl.split[0].registration_id), id(levi), 'לילד הנכון');
    const pc = q.pairs.find(p => id(p.tx) === id(two));
    ok(!!pc, 'סכום של חודשיים לשני אחים — מוצע');
    eq(pc && pc.split.length, 4, 'מתחלק על שני ילדים × שני חודשים');
    eq(pc && pc.split.map(s => s.month_number).join(','), '9,9,10,10', 'ספטמבר ואז אוקטובר');
    eq(pc && pc.split.reduce((a, s) => a + s.amount, 0), 11600, 'סך החלוקה = סכום ההעברה');
    await BankTransaction.deleteMany({});
  }
  {
    // Two transfers to the same family: the later one takes the next open month.
    const first = await tx({ amount: 3000, date: '2025-09-02', description: 'דנה לוי' });
    const second = await tx({ amount: 3000, date: '2025-10-02', description: 'דנה לוי' });
    const q = await K.incomeQueue();
    const a = q.pairs.find(p => id(p.tx) === id(first));
    const b = q.pairs.find(p => id(p.tx) === id(second));
    eq(a && a.split[0].month_number, 9, 'הראשונה — ספטמבר');
    eq(b && b.split[0].month_number, 10, 'השנייה — אוקטובר (לא שוב ספטמבר)');
    await BankTransaction.deleteMany({});
  }
  {
    // Existing allocation counts: September already partly paid.
    await IncomeAllocation.create({ transaction_id: new mongoose.Types.ObjectId(), registration_id: levi._id, academic_year: '2025-2026', month_number: 9, amount: 1000 });
    const t = await tx({ amount: 3000, date: '2025-09-20', description: 'דנה לוי' });
    const q = await K.incomeQueue();
    const p = q.pairs.find(x => id(x.tx) === id(t));
    eq(p && p.split.map(s => `${s.month_number}:${s.amount}`).join(','), '9:2000,10:1000', 'ממלאת את יתרת ספטמבר ואז אוקטובר');
    await BankTransaction.deleteMany({});
    await IncomeAllocation.deleteMany({});
  }
  {
    const aliasTx = await tx({ amount: 123, date: '2025-12-01', description: 'PAYBOX 998877' });
    await IncomePayerAlias.create({ payer_key: payerKey(aliasTx), household_key: '000000034' });
    const q = await K.incomeQueue();
    const p = q.pairs.find(x => id(x.tx) === id(aliasTx));
    eq(p && p.score, 100, 'משלם מוכר — 100');
    ok(p && p.household.children.some(c => String(c.registration_id) === id(mizrahi)), 'למשפחה של הכינוי');
    await BankTransaction.deleteMany({});
    await IncomePayerAlias.deleteMany({});
  }
  {
    const emuna = await tx({ amount: 3000, date: '2025-09-04', description: 'העברה מאמונה דנה לוי' });
    const q = await K.incomeQueue();
    ok(!q.pairs.some(p => id(p.tx) === id(emuna)), 'העברת אמונה — לא מוצעת גם עם שם וסכום');
    ok(q.exempt.some(e => id(e.tx) === id(emuna)), 'ומופיעה בפטורים');
    await BankTransaction.deleteMany({});
  }
  {
    const t = await tx({ amount: 3000, date: '2025-09-04', description: 'דנה לוי' });
    await IncomeRejection.create({ transaction_id: t._id, household_key: '000000018' });
    const q = await K.incomeQueue();
    ok(!q.pairs.some(p => id(p.tx) === id(t)), 'משפחה שנדחתה — לא מוצעת');
    ok(q.unmatched_tx.some(x => id(x) === id(t)), 'התנועה בלי הצעה');
    const alts = await K.alternativesForTx(id(t));
    ok(!alts.some(a => a.household.household_key === '000000018'), 'וגם לא בחלופות');
    await BankTransaction.deleteMany({});
    await IncomeRejection.deleteMany({});
  }
  {
    // Same amount as two families, no name — a tie is not a proposal.
    await reg({ child_name: 'גיל אדם', parent_name: 'מורן אדם', parent_id_number: '000000059', monthly_fee: 2500 });
    const t = await tx({ amount: 2500, date: '2025-09-04', description: 'העברה' });
    const q = await K.incomeQueue();
    ok(!q.pairs.some(p => id(p.tx) === id(t)), 'שתי משפחות באותו ציון — לא מוצע');
    const u = q.unmatched_tx.find(x => id(x) === id(t));
    ok(!!u && !!u.why, 'עם סיבה');
    await BankTransaction.deleteMany({});
  }
  {
    // Academic year comes from the transfer date: a January 2027 transfer
    // looks at 2026-2027 families only.
    const next = await reg({ child_name: 'תמר לוי', parent_name: 'דנה לוי', parent_id_number: '000000018',
      academic_year: '2026-2027', start_date: new Date(2026, 8, 1), end_date: new Date(2027, 7, 31), monthly_fee: 3300 });
    const t = await tx({ amount: 3300, date: '2027-01-03', description: 'דנה לוי' });
    const old = await tx({ amount: 3000, date: '2025-11-03', description: 'דנה לוי' });
    const q = await K.incomeQueue();
    const p = q.pairs.find(x => id(x.tx) === id(t));
    ok(!!p, 'ינואר 2027 — מוצע');
    eq(p && String(p.split[0].registration_id), id(next), 'לרישום של 2026-2027');
    const o = q.pairs.find(x => id(x.tx) === id(old));
    eq(o && String(o.split[0].registration_id), id(levi), 'נובמבר 2025 — לרישום של 2025-2026');
    await BankTransaction.deleteMany({});
  }

  console.log('\nalternativesForTx');
  {
    const t = await tx({ amount: 2800, date: '2025-09-04', description: 'העברה' });
    const alts = await K.alternativesForTx(id(t));
    ok(Array.isArray(alts) && alts.length > 0 && alts.length <= 5, `עד 5 משפחות (${alts && alts.length})`);
    ok(alts.every(a => a.household && Array.isArray(a.split)), 'כל חלופה עם משפחה וחלוקה');
    for (let i = 1; i < alts.length; i += 1) {
      if (alts[i].score > alts[i - 1].score) { ok(false, 'ממוין לפי ציון'); break; }
    }
    eq(await K.alternativesForTx(String(new mongoose.Types.ObjectId())), null, 'תנועה שלא במאגר — null');
    eq(await K.alternativesForTx('zzz'), null, 'מזהה לא תקין — null');
  }

  console.log('\nמפתח משפחה שמתחלף');
  {
    // Mother registers this year; the alias and a rejection are stored under her key.
    const mom = await reg({ child_name: 'רון שמש', parent_name: 'ליאת שמש', parent_id_number: '000000067',
      child_birth_date: new Date(2023, 0, 1), monthly_fee: 4100 });
    let hs = await K.kaplanHouseholds('2025-2026');
    const before = hs.find(h => h.children.some(c => String(c.registration_id) === id(mom)));
    eq(before && before.household_key, '000000067', 'לפני — המפתח של האם');
    const aliasTx = await tx({ amount: 55, date: '2025-12-01', description: 'PAYBOX 4455' });
    await IncomePayerAlias.create({ payer_key: payerKey(aliasTx), household_key: '000000067' });
    const rejTx = await tx({ amount: 4100, date: '2025-09-04', description: 'ליאת שמש' });
    await IncomeRejection.create({ transaction_id: rejTx._id, household_key: '000000067' });
    // Father's registration of the same child (last year) joins the household.
    await reg({ child_name: 'רון שמש', parent_name: 'גיא שמש', parent_id_number: '000000075',
      child_birth_date: new Date(2023, 0, 1), monthly_fee: 4000, academic_year: '2024-2025',
      start_date: new Date(2024, 8, 1), end_date: new Date(2025, 7, 31) });
    hs = await K.kaplanHouseholds('2025-2026');
    const after = hs.find(h => h.children.some(c => String(c.registration_id) === id(mom)));
    ok(after && after.household_key !== '000000067', `אחרי — המפתח הראשי התחלף (${after && after.household_key})`);
    ok(after && after.member_keys.includes('000000067') && after.member_keys.includes('000000075'), 'member_keys כולל את שני ההורים');
    ok(after && after.member_keys.includes(after.household_key), 'וגם את המפתח הראשי');
    ok(after && after.parents.includes('גיא שמש'), 'האב בין ההורים');
    const q = await K.incomeQueue();
    const p = q.pairs.find(x => id(x.tx) === id(aliasTx));
    eq(p && p.score, 100, 'כינוי שנשמר תחת המפתח הישן — עדיין 100');
    ok(!q.pairs.some(x => id(x.tx) === id(rejTx)), 'דחייה שנשמרה תחת המפתח הישן — עדיין לא מוצע');
    const alts = await K.alternativesForTx(id(rejTx));
    ok(!alts.some(a => a.household.children.some(c => String(c.registration_id) === id(mom))), 'וגם לא בחלופות');
    await BankTransaction.deleteMany({});
    await IncomePayerAlias.deleteMany({});
    await IncomeRejection.deleteMany({});
  }

  console.log('\nמשפחה ששילמה הכול');
  {
    const paidUp = await reg({ child_name: 'שקד ברק', parent_name: 'הדס ברק', parent_id_number: '000000083', monthly_fee: 1700 });
    await reg({ child_name: 'אור ים', parent_name: 'נגה ים', parent_id_number: '000000091', monthly_fee: 1700 });
    await IncomeAllocation.insertMany([9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8].map(m => ({
      transaction_id: new mongoose.Types.ObjectId(), registration_id: paidUp._id, academic_year: '2025-2026', month_number: m, amount: 1700,
    })));
    const t = await tx({ amount: 1700, date: '2025-10-04', description: 'הדס ברק' });
    const q = await K.incomeQueue();
    ok(!q.pairs.some(x => id(x.tx) === id(t)), 'המשפחה המתאימה שילמה הכול — לא מציעים משפחה חלשה יותר');
    const u = q.unmatched_tx.find(x => id(x) === id(t));
    eq(u && u.why, 'המשפחה המתאימה ביותר כבר שילמה את כל החודשים', 'עם הסיבה');
    await BankTransaction.deleteMany({});
    await IncomeAllocation.deleteMany({});
  }

  console.log('\nקריאה בלבד');
  {
    eq(await Collection.countDocuments({}), 0, 'המנוע לא כתב לטבלת הגבייה');
    eq(await IncomeAllocation.countDocuments({}), 0, 'ולא כתב הקצאות');
  }

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n❌ ${failures} נכשלו\n` : '\n✅ הכול עבר\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
