#!/usr/bin/env node
/**
 * Emunah monthly settlement workbook — income spec §3.
 * Synthetic workbook reproducing the layout of "תחשיב תשפ״ו גן החלומות" (no real numbers).
 *
 *   node scripts/emunah-statement.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

const XLSX = require('xlsx');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c || !d ? '' : `  (${d})`}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);

const MONTHS = ['אוגוסט ', 'ספטמבר ', 'אוקטובר', 'נובמבר', 'דצמבר', 'ינואר ', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני ', 'יולי ', 'אוגוסט'];
const LABELS = ['חודשים ', 'גבייה מהמערכת', 'העברת הורים ', 'החזרים להורים', 'תשלומי ממשלה', 'תשלומי רווחה '];
// Per block: system collection for month index i = base + i (August of the start year is X).
const BLOCKS = [
  { name: 'הרצליה ', year: 'שנה שלישית', base: 1000 },
  { name: 'כפר סבא ', year: 'שנה רביעית', base: 2000 },
  { name: 'אייזיק חריף', year: 'שנה שנייה', base: 3000 },
];

/** The workbook as an array of rows; `rowOff`/`colOff` shift everything to prove nothing is hard-coded. */
function sheetRows({ rowOff = 0, colOff = 0, payments = null, yearLabel = 'תשפ"ו ' } = {}) {
  const grid = [];
  const put = (r, c, v) => {
    r += rowOff; c += colOff;
    while (grid.length <= r) grid.push([]);
    grid[r][c] = v;
  };
  put(1, 1, 'נתונים חדשים'); put(1, 8, 'דו"ח הוצאות והכנסות החל מ-9/25'); put(1, 15, yearLabel);
  BLOCKS.forEach((b, k) => {
    const c0 = 1 + k * 7;
    put(2, c0 + 4, '40-60'); put(2, c0 + 5, '60-82');
    put(3, c0 + 1, b.year); put(3, c0 + 2, b.name); put(3, c0 + 4, 1500); put(3, c0 + 5, 1800);
    put(4, c0, 'הכנסות ');
    LABELS.forEach((l, j) => put(5, c0 + j, l));
    MONTHS.forEach((m, i) => {
      const r = 6 + i;
      put(r, c0, m);
      if (i === 12) return; // August of the ending year: label only
      if (i === 0) { put(r, c0 + 1, 'X'); put(r, c0 + 2, 'X'); put(r, c0 + 4, 10); put(r, c0 + 5, 20); return; }
      put(r, c0 + 1, b.base + i);
      put(r, c0 + 2, 100.5);
      put(r, c0 + 3, i === 1 ? -50 : 'X');
      put(r, c0 + 4, i === 1 ? 'X' : 300);
      put(r, c0 + 5, 40);
    });
    put(19, c0, 'סה"כ'); put(19, c0 + 1, 99999); // the file's own total (stored, not trusted)
    put(20, c0 + 1, 123456); // block total under the total row
  });
  put(22, 13, 'סיכום ');
  put(23, 1, 'הוצאות '); put(23, 6, 'תשלומים ששולמו '); put(23, 13, 'הכנסות '); put(23, 14, 500000);
  put(24, 1, 'חודשים '); put(24, 2, 'שכר דירה '); put(24, 3, 'שונות ');
  put(24, 6, 'תאריך העברה '); put(24, 7, 'סכום '); put(24, 8, 'עבור חודש ');
  put(24, 13, 'הוצאות '); put(24, 14, 40000);
  const expenses = [
    ['ספטמבר', 5000, 250.25], ['אוקטובר ', 5000, 'X'], ['הוצאות תשפ"ה', 7000, null],
    ['נובמבר ', 5000, 100], ['הוצאות מים תשפ"ה (כפ"ס)', 900, null], ['דצמבר ', 5000, 0], ['אוגוסט', null, null],
  ];
  expenses.forEach((e, i) => { put(25 + i, 1, e[0]); if (e[1] != null) put(25 + i, 2, e[1]); if (e[2] != null) put(25 + i, 3, e[2]); });
  put(25 + expenses.length, 2, 99999); // expenses total, no label
  const pays = payments || [['20.9.25', 30000, 9], ['20.10.25', 31000.5, 10], ['20.11.25', 32000, 11], ['5.1.26', 15000, 'דצמבר']];
  pays.forEach((p, i) => { put(25 + i, 6, p[0]); put(25 + i, 7, p[1]); put(25 + i, 8, p[2]); });
  put(25 + pays.length + 2, 6, 'סה"כ'); put(25 + pays.length + 2, 7, 999999);
  put(25, 13, 'תשלומים ששולמו '); put(25, 14, 108000.5);
  put(26, 13, 'יתרה לתשלום'); put(26, 14, 351999.5);
  return grid;
}
const book = (opts) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetRows(opts)), 'תשפ"ו ');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

(async () => {
  console.log('\n🏦 תחשיב אמונה\n');
  const E = require('../src/services/emunahStatement.service');

  // ---- parsing
  const p = E.parseEmunah(book());
  eq(p.academic_year_label, 'תשפ"ו', 'שנת הלימודים נקראה');
  eq(p.branches.length, 3, 'שלושה גושי סניפים');
  eq(p.branches.map(b => b.name).join('|'), 'הרצליה|כפר סבא|אייזיק חריף', 'שמות הסניפים מהכותרת');
  const h = p.branches[0];
  eq(h.months.length, 13, 'שלושה-עשר חודשים, אוגוסט עד אוגוסט');
  eq(h.months[0].month_label, 'אוגוסט', 'שם חודש מנוקה');
  eq(h.months[0].month_index, 0, 'מיקום החודש בגוש');
  eq(h.months[0].system, null, '"X" → null');
  eq(h.months[0].government, 10, 'מספר בשורת אוגוסט הראשונה');
  eq(h.months[1].system, 1001, 'גבייה מהמערכת');
  eq(h.months[1].parents, 100.5, 'העברת הורים — שבר נשמר');
  eq(h.months[1].refunds, -50, 'החזרים להורים');
  eq(h.months[1].government, null, 'תשלומי ממשלה X');
  eq(h.months[1].welfare, 40, 'תשלומי רווחה');
  eq(h.months[12].system, null, 'אוגוסט האחרון ריק → null');
  eq(h.months[12].welfare, null, 'תא ריק → null (לא 0)');
  eq(p.branches[2].months[2].system, 3002, 'גוש שלישי, אוקטובר');
  eq(h.totals.system, 99999, 'שורת סה"כ של הקובץ נשמרת');

  eq(p.expenses.length, 7, 'שבע שורות הוצאה');
  eq(p.expenses[0].month_label, 'ספטמבר', 'הוצאה חודשית');
  eq(p.expenses[0].rent, 5000, 'שכר דירה');
  eq(p.expenses[0].misc, 250.25, 'שונות');
  eq(p.expenses[1].misc, null, 'שונות X → null');
  eq(p.expenses[2].label, 'הוצאות תשפ"ה', 'שורה מיוחדת — התווית');
  eq(p.expenses[2].month_label, null, 'שורה מיוחדת — אין חודש');
  eq(p.expenses[2].misc, 7000, 'שורה מיוחדת — הסכום בשונות');
  eq(p.expenses[2].rent, null, 'שורה מיוחדת — לא שכר דירה');
  eq(p.expenses[4].label, 'הוצאות מים תשפ"ה (כפ"ס)', 'שורת מים');
  eq(p.expenses[5].misc, 0, '0 נשאר 0');

  eq(p.payments.length, 4, 'ארבעה תשלומים (בלי שורת סה"כ)');
  eq(p.payments[0].date, '2025-09-20', '"20.9.25" → 2025-09-20');
  eq(p.payments[0].amount, 30000, 'סכום התשלום');
  eq(p.payments[0].for_month, '2025-09', 'עבור חודש 9 → 2025-09');
  eq(p.payments[1].amount, 31000.5, 'סכום עשרוני');
  eq(p.payments[3].date, '2026-01-05', 'תאריך בשנה הבאה');
  eq(p.payments[3].for_month, '2025-12', 'עבור חודש בשם עברי');

  eq(p.summary.income, 500000, 'סיכום — הכנסות');
  eq(p.summary.expenses, 40000, 'סיכום — הוצאות');
  eq(p.summary.paid, 108000.5, 'סיכום — שולם');
  eq(p.summary.balance, 351999.5, 'סיכום — יתרה');

  // a shifted sheet parses the same
  const s = E.parseEmunah(book({ rowOff: 3, colOff: 2 }));
  eq(s.branches.length, 3, 'גיליון מוזז — שלושה גושים');
  eq(s.branches[1].months[1].system, 2001, 'גיליון מוזז — אותם ערכים');
  eq(s.payments[2].date, '2025-11-20', 'גיליון מוזז — תשלומים');
  eq(s.summary.balance, 351999.5, 'גיליון מוזז — סיכום');
  eq(s.expenses.length, 7, 'גיליון מוזז — הוצאות');

  // dates in other shapes
  eq(E.parseDate('20/9/2025'), '2025-09-20', 'תאריך 20/9/2025');
  eq(E.parseDate(45920), '2025-09-20', 'מספר סידורי של אקסל');
  eq(E.parseDate('לא תאריך'), null, 'טקסט שאינו תאריך → null');

  // a workbook that is not the statement
  try {
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b']]), 'x');
    E.parseEmunah(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })); ok(false, 'קובץ זר נדחה');
  } catch (e) { ok(e.status === 400 && /[א-ת]/.test(e.message), 'קובץ זר נדחה (400, עברית)', e.message); }
  try { E.parseEmunah(Buffer.from('not a workbook')); ok(false, 'קובץ פגום נדחה'); }
  catch (e) { ok(e.status === 400, 'קובץ פגום נדחה (400)', e.message); }

  // ---- import + view
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error('not loopback');
  await mongoose.connect(uri);
  const M = require('../src/models');
  const { Branch, BankAccount, BankTransaction, ClickTacMonthRow, EmunahStatement } = M;

  const herz = await Branch.create({ name: 'הרצליה הרצוג' });
  await Branch.create({ name: 'כפר סבא - קפלן' });
  const dayan = await Branch.create({ name: 'כפר סבא - משה דיין' });
  const tlv = await Branch.create({ name: 'תל אביב יפו - אייזיק חריף' });
  const by = new mongoose.Types.ObjectId();

  eq(await E.latestStatement(), null, 'בלי ייבוא — אין תחשיב');
  eq(await E.emunahView(), null, 'בלי ייבוא — תצוגה ריקה');

  const first = await E.importEmunah({ buffer: book({ payments: [['1.9.25', 1, 9]] }), by, file_name: 'old.xlsx' });
  eq(first.file_name, 'old.xlsx', 'ייבוא שומר שם קובץ');
  // a later upload is a new version; the newest wins
  await new Promise(r => setTimeout(r, 5));
  const imp = await E.importEmunah({ buffer: book(), by, file_name: 'new.xlsx' });
  eq(await EmunahStatement.countDocuments({}), 2, 'כל העלאה נשמרת כגרסה');
  eq((await E.latestStatement()).file_name, 'new.xlsx', 'האחרונה מוצגת');
  eq(String(imp.created_by), String(by), 'created_by');
  const bmap = Object.fromEntries(imp.branches.map(b => [b.name, String(b.branch_id)]));
  eq(bmap['הרצליה'], String(herz._id), 'הרצליה → סניף הרצליה');
  eq(bmap['כפר סבא'], String(dayan._id), 'כפר סבא → משה דיין (לא קפלן)');
  eq(bmap['אייזיק חריף'], String(tlv._id), 'אייזיק חריף → תל אביב');

  // bank
  const bank = await BankAccount.create({ external_id: 'b1', institution: 'x', label: 'עו"ש', type: 'bank' });
  const card = await BankAccount.create({ external_id: 'c1', institution: 'x', label: 'כרטיס', type: 'card' });
  const tx = (o) => BankTransaction.create({ account_id: bank._id, hash: `h${Math.random()}`, description: 'העברה', ...o });
  const t1 = await tx({ date: '2025-09-22', amount: 30000.8, description: 'זיכוי מאמונה' }); // ±1, +2 days
  const t1b = await tx({ date: '2025-09-26', amount: 30000, description: 'אמונה' }); // farther: must lose to t1
  await tx({ date: '2025-10-30', amount: 31000.5, counterparty: 'עמותת אמונה' }); // 10 days late → no match
  await tx({ date: '2025-11-19', amount: 32002, description: 'אמונה' }); // 2 ₪ off → no match
  const t3 = await tx({ date: '2025-11-20', amount: 32000, counterparty: 'אמונה תנועת נשים' });
  await tx({ date: '2025-11-20', amount: 32000, description: 'הורה כלשהו' }); // not Emunah
  await tx({ date: '2025-11-20', amount: 32000, description: 'אמונה', is_internal_transfer: true });
  await BankTransaction.create({ account_id: card._id, hash: 'hc', date: '2025-11-21', amount: 32000, description: 'אמונה' });
  await tx({ date: '2025-11-21', amount: -32000, description: 'אמונה' }); // money out
  await tx({ date: '2027-03-01', amount: 5000, description: 'אמונה' }); // outside the statement's range

  // ClickTac: הרצליה September matches, משה דיין September differs, staged rows ignored
  const row = (o) => ClickTacMonthRow.create({ child_id_number: `${Math.random()}`.slice(2, 11), ...o });
  await row({ branch_id: herz._id, month: '2025-09', paid: 600 });
  await row({ branch_id: herz._id, month: '2025-09', paid: 401 });
  await row({ branch_id: dayan._id, month: '2025-09', paid: 1500 });
  await row({ branch_id: dayan._id, month: '2025-09~abc', paid: 9999 });

  const v = await E.emunahView();
  eq(v.statement.file_name, 'new.xlsx', 'התצוגה מציגה את האחרונה');
  eq(v.payments.length, 4, 'ארבעה תשלומים בתצוגה');
  eq(String(v.payments[0].bank && v.payments[0].bank.transaction_id), String(t1._id), 'תשלום ↔ תנועה הקרובה ביותר (±1 ₪, ±7 ימים)');
  eq(v.payments[0].bank.date, '2025-09-22', 'תאריך התנועה');
  eq(v.payments[0].bank.amount, 30000.8, 'סכום התנועה');
  eq(v.payments[1].bank, null, 'תנועה באיחור של 10 ימים — לא נמצא');
  eq(String(v.payments[2].bank && v.payments[2].bank.transaction_id), String(t3._id), 'התאמה לפי המוטב (counterparty)');
  eq(v.payments[3].bank, null, 'תשלום בלי תנועה — null');
  const unexplained = v.unexplained_bank.map(u => String(u.transaction_id)).sort();
  ok(unexplained.includes(String(t1b._id)), 'תנועת אמונה שלא שובצה — "בלי שורה בתחשיב"');
  eq(v.unexplained_bank.length, 3, 'שלוש תנועות אמונה בלי שורה (נכנסת, בנק, לא פנימית, בטווח)');
  ok(!v.unexplained_bank.some(u => u.date === '2027-03-01'), 'תנועה מחוץ לטווח התחשיב לא נספרת');
  ok(v.unexplained_bank.every(u => u.amount > 0), 'רק כסף נכנס');

  const cc = (bid, m) => v.clicktac_check.find(c => String(c.branch_id) === String(bid) && c.month === m);
  const hs = cc(herz._id, '2025-09');
  eq(hs && hs.system, 1001, 'הצלבה — גבייה מהמערכת בתחשיב');
  eq(hs && hs.clicktac_paid, 1001, 'הצלבה — סך "שולם" בקליקטאק');
  eq(hs && hs.diff, 0, 'הצלבה — אין פער');
  const ds = cc(dayan._id, '2025-09');
  eq(ds && ds.clicktac_paid, 1500, 'הצלבה — שורות ביניים (~) לא נספרות');
  eq(ds && ds.diff, -501, 'הצלבה — פער = קליקטאק פחות התחשיב (2001 מול 1500)');
  const ho = cc(herz._id, '2025-10');
  eq(ho && ho.clicktac_paid, null, 'חודש בלי ייבוא קליקטאק — null');
  eq(ho && ho.diff, null, 'חודש בלי ייבוא קליקטאק — אין פער');
  eq(ho && ho.month_label, 'אוקטובר', 'שם החודש בהצלבה');
  ok(cc(herz._id, '2026-01'), 'ינואר ממופה לשנה הבאה (2026-01)');
  ok(!v.clicktac_check.some(c => c.month === '2025-08' && c.system == null && c.clicktac_paid == null), 'חודש ריק לגמרי לא מוצג');

  // the balance, recomputed for checking
  eq(v.recomputed.paid, 108000.5, 'שולם מחושב מחדש');
  eq(v.recomputed.expenses, 28250.25, 'הוצאות מחושבות מחדש');
  ok(typeof v.recomputed.income === 'number' && typeof v.recomputed.balance === 'number', 'הכנסות ויתרה מחושבות');
  eq(Math.round((v.recomputed.income - v.recomputed.expenses - v.recomputed.paid) * 100) / 100, v.recomputed.balance, 'יתרה = הכנסות − הוצאות − שולם');

  // never writes the collections side
  const { Collection, Registration, ExternalEnrollment } = M;
  eq((await Collection.countDocuments({})) + (await Registration.countDocuments({})) + (await ExternalEnrollment.countDocuments({})), 0, 'אין כתיבה לגבייה/רישומים/ExternalEnrollment');

  await mongoose.disconnect(); await mongod.stop();
  console.log(failures ? `\n❌ ${failures} נכשלו\n` : '\n✅ הכול עבר\n');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
