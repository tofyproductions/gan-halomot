#!/usr/bin/env node
/**
 * Income — models, built-in rules, tabs.
 *
 *   node scripts/income-models.test.js
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
  const { IncomeRule, IncomeAllocation, IncomeRejection, IncomePayerAlias,
    ClickTacImport, ClickTacMonthRow, EmunahStatement } = M;
  for (const m of [IncomeRule, IncomeAllocation, IncomeRejection, IncomePayerAlias,
    ClickTacImport, ClickTacMonthRow, EmunahStatement]) await m.init();
  const svc = require('../src/services/incomeRules.service');

  console.log('\n💰 מודלי הכנסות\n');

  console.log('IncomeRule');
  {
    const r = await IncomeRule.create({ label: 'x', pattern: 'p1' });
    eq(r.built_in, false, 'לא מובנה כברירת מחדל');
    eq(r.is_active, true, 'פעיל כברירת מחדל');
    ok(r.created_at instanceof Date, 'חותמות זמן');
    await IncomeRule.create({ label: 'x', pattern: 'p1' });
    ok(true, 'חוק משתמש כפול מותר');
    await IncomeRule.create({ label: 'b', pattern: 'bi', built_in: true });
    ok(await dupKey(() => IncomeRule.create({ label: 'b', pattern: 'bi', built_in: true })), 'תבנית מובנית כפולה נדחית (E11000)');
    await IncomeRule.deleteMany({});
  }

  console.log('seed + match');
  {
    await svc.seed();
    const rows = await IncomeRule.find({ built_in: true }).lean();
    eq(rows.length, 4, 'ארבעה חוקים מובנים');
    ok(['אמונה', 'ריבית', 'החזר', 'זיכוי'].every(p => rows.some(r => r.pattern === p)), 'התבניות הנכונות');
    eq(rows.find(r => r.pattern === 'אמונה').label, 'העברה מאמונה — בלשונית אמונה', 'תווית אמונה');
    await svc.seed();
    eq(await IncomeRule.countDocuments({ built_in: true }), 4, 'זריעה חוזרת לא מכפילה');
    await IncomeRule.updateOne({ pattern: 'ריבית' }, { is_active: false });
    await svc.seed();
    eq((await IncomeRule.findOne({ pattern: 'ריבית' })).is_active, false, 'חוק שכובה נשאר כבוי');
    await Promise.all([svc.seed(), svc.seed()]);
    eq(await IncomeRule.countDocuments({ built_in: true }), 4, 'שתי זריעות במקביל — עדיין ארבעה');

    const rules = await svc.activeRules();
    eq(rules.length, 3, 'activeRules בלי הכבוי');
    eq(svc.match('העברה מ-אמונה', rules)?.pattern, 'אמונה', 'הכלה גם עם מקף');
    eq(svc.match('זיכוי מבנק', rules)?.pattern, 'זיכוי', 'התאמה לפי הכלה');
    eq(svc.match('ריבית זכות', rules), null, 'חוק כבוי לא תופס');
    eq(svc.match('AMUNA', [{ pattern: 'amuna' }])?.pattern, 'amuna', 'לא רגיש לאותיות');
    eq(svc.match('', rules), null, 'תיאור ריק — כלום');
    eq(svc.match('העברה מאמונה בע"מ', rules)?.label, 'העברה מאמונה — בלשונית אמונה', 'אמונה נתפסת');
  }

  console.log('IncomeAllocation');
  {
    const a = await IncomeAllocation.create({ transaction_id: oid(), registration_id: oid(), household_key: 'h1', academic_year: '2026-2027', month_number: 9, amount: 1500 });
    eq(a.amount, 1500, 'הקצאה נשמרה');
    eq(a.created_by, null, 'created_by ריק כברירת מחדל');
    let bad = false;
    try { await IncomeAllocation.create({ registration_id: oid(), amount: 1 }); } catch { bad = true; }
    ok(bad, 'בלי transaction_id נדחה');
    const idx = IncomeAllocation.schema.indexes().map(([k]) => JSON.stringify(k));
    ok(idx.includes('{"transaction_id":1}'), 'אינדקס לפי תנועה');
    ok(idx.includes('{"registration_id":1,"academic_year":1,"month_number":1}'), 'אינדקס רישום+שנה+חודש');
  }

  console.log('IncomeRejection');
  {
    const t = oid();
    await IncomeRejection.create({ transaction_id: t, household_key: 'h1' });
    ok(await dupKey(() => IncomeRejection.create({ transaction_id: t, household_key: 'h1' })), 'דחייה כפולה נדחית');
    await IncomeRejection.create({ transaction_id: t, household_key: 'h2' });
    ok(true, 'אותה תנועה, משפחה אחרת — מותר');
  }

  console.log('IncomePayerAlias');
  {
    await IncomePayerAlias.create({ payer_key: 'כהן דני', household_key: 'h1' });
    ok(await dupKey(() => IncomePayerAlias.create({ payer_key: 'כהן דני', household_key: 'h2' })), 'payer_key ייחודי');
  }

  console.log('ClickTac');
  {
    const b = oid();
    const imp = await ClickTacImport.create({ branch_id: b, month: '2026-09', file_name: 'a.xlsx', rows: 2 });
    ok(imp.created_at instanceof Date, 'ייבוא נרשם עם זמן');
    const row = await ClickTacMonthRow.create({ branch_id: b, month: '2026-09', child_id_number: '000000123', import_id: imp._id });
    eq(row.paid, 0, 'שולם 0 כברירת מחדל');
    eq(row.child_name, '', 'שם ריק כברירת מחדל');
    ok(await dupKey(() => ClickTacMonthRow.create({ branch_id: b, month: '2026-09', child_id_number: '000000123' })), 'סניף+חודש+ת.ז. ייחודי');
    await ClickTacMonthRow.create({ branch_id: b, month: '2026-10', child_id_number: '000000123' });
    ok(true, 'חודש אחר — מותר');
  }

  console.log('EmunahStatement');
  {
    const s = await EmunahStatement.create({
      academic_year_label: 'תשפ"ז', file_name: 'e.xlsx',
      branches: [{ name: 'הרצליה', months: [{ month_label: 'ספטמבר', month_index: 9, system: 100, government: null }] }],
      expenses: [{ label: 'שכר דירה', rent: 5000 }],
      payments: [{ date: '2026-09-15', amount: 3000, for_month: 'ספטמבר' }],
      summary: { income: 100, expenses: 5000, paid: 3000, balance: -1900 },
    });
    eq(s.branches[0].branch_id, null, 'branch_id ריק');
    eq(s.branches[0].months[0].government, null, 'X = null נשמר');
    eq(s.branches[0].months[0].parents, null, 'שדה חסר = null');
    eq(s.expenses[0].month_label, null, 'הוצאה בלי חודש');
    eq(s.summary.balance, -1900, 'סיכום');
    ok(s.created_at instanceof Date, 'חותמות זמן');
  }

  console.log('tabs');
  {
    const server = require('../src/constants/tabs');
    const pick = (k) => server.TAB_DEFAULT_ROLES[k];
    eq(JSON.stringify(pick('income')), JSON.stringify(['system_admin', 'admin_viewer', 'accountant']), 'income — תפקידי ברירת מחדל');
    eq(JSON.stringify(pick('income_write')), JSON.stringify(['system_admin', 'accountant']), 'income_write — תפקידי ברירת מחדל');
  }

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n❌ ${failures} נכשלו\n` : '\n✅ הכול עבר\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
