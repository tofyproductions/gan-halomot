#!/usr/bin/env node
/**
 * ClickTac monthly collection report (debt_contract_export) — income spec §2.
 *
 *   node scripts/clicktac-debt.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

const XLSX = require('xlsx');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const CT = require('../src/services/clicktac.service');

let failures = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${l}${c || !d ? '' : `  (${d})`}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, l, `קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)}`);
const rejects = async (fn, status, l) => {
  try { await fn(); ok(false, l, 'לא נזרקה שגיאה'); } catch (e) {
    ok(e.status === status && /[א-ת]/.test(e.message), l, `status ${e.status} / ${e.message}`);
  }
};

// The real header row, in the vendor's order.
const HEADER = ['מוסד', 'חודש', 'שם פרטי', 'שם משפחה', 'ת.ז. או דרכון', 'סטטוס', 'כל חיובי החודש', 'מגבלה חודשית',
  'יעד החודש לאחר מגבלה', 'יעד מצטבר עד החודש (לאחר מגבלה)', 'סומן לגבייה החודש (ללא נכשל)', 'תשלומי החודש',
  'סומן כטופל', 'התאמות עד החודש', 'סטטוס הכנת גביה', 'סטטוס גביה', 'יש משלם שני', 'אמצעי תשלום'];
// Excel serial 46296 = 01/10/2026; the real file stores it as a number with a date format.
const serial = (y, m) => Math.round(Date.UTC(y, m - 1, 1) / 86400000) + 25569;
const row = (o = {}) => [o.inst ?? 'כפר סבא', o.month ?? serial(2026, 10), o.first ?? 'דנה', o.last ?? 'בדיקה',
  o.id ?? '000000018', o.status ?? 'התקבל', o.charges ?? 3000, o.limit ?? null, o.target ?? 3000, o.cum ?? 3000, 0,
  o.paid ?? 0, false, o.adj ?? 0, 'לחיוב', o.cstatus ?? 'לא שולם', false, o.method ?? 'ויזה - 1111'];
const book = (rows, header = HEADER) => {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Worksheet 1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

(async () => {
  console.log('\n🧾 ייצוא גבייה חודשי של קליקטאק\n');

  // ---- header detection, no mongo needed
  const hdrObj = Object.fromEntries(HEADER.map(h => [h, '']));
  eq(CT.detectExportType(hdrObj), 'debt', 'כותרת הגבייה מזוהה כ-debt');
  eq(CT.identifyHeader(hdrObj).type, 'debt', 'identifyHeader מקבל');
  const { 'ת.ז. או דרכון': _x, ...noId } = hdrObj;
  const bad = CT.identifyHeader(noId);
  eq(bad.code, 'MISSING_COLUMNS', 'חסרה עמודת זהות — MISSING_COLUMNS');
  ok(/ת\.ז/.test(bad.error || ''), 'ההודעה נוקבת בעמודה');
  eq(CT.detectExportType({ 'שם פרטי של הנרשם': '', 'שם פרטי': '' }), 'registrations', 'ייצוא נרשמים לא השתנה');
  eq(CT.detectExportType({ 'ת.ז. או דרכון': '', 'מעון': '', 'דרגה': '', 'שם פרטי': '' }), 'contracts', 'ייצוא חוזים לא השתנה');

  const D = require('../src/services/clicktacDebt.service');

  // ---- parsing
  const parsed = D.parseDebtExport(book([
    row({ id: '18', first: 'א', last: 'ב', target: 1634, paid: 0 }),
    row({ id: 'ab123456', first: 'ג', last: 'ד', target: 2000.5, paid: 2000.5, cstatus: 'שולם', method: '' }),
    row({ id: '000000026', first: 'ה', last: 'ו', status: 'ביטל רישום', target: 0, charges: 0, adj: -5 }),
  ]));
  eq(parsed.month, '2026-10', 'חודש נקרא ממספר סידורי של אקסל');
  eq(parsed.rows.length, 3, 'שלוש שורות');
  eq(parsed.rows[0].child_id_number, '000000018', 'ת״ז מרופדת ל-9 ספרות');
  eq(parsed.rows[1].child_id_number, 'AB123456', 'דרכון באותיות גדולות, כמו שהוא');
  eq(parsed.rows[0].target, 1634, 'יעד');
  eq(parsed.rows[1].paid, 2000.5, 'סכום עשרוני נשמר');
  eq(parsed.rows[2].adjustments, -5, 'התאמה שלילית');
  eq(parsed.rows[2].status, 'ביטל רישום', 'סטטוס');
  eq(parsed.rows[1].payment_method, '', 'אמצעי תשלום ריק');
  eq(parsed.institutions[0], 'כפר סבא', 'המוסד נאסף לבדיקת הסניף');

  // month given as text dd/mm/yyyy
  const asText = D.parseDebtExport(book([row({ month: '01/09/2026' })]));
  eq(asText.month, '2026-09', 'חודש כטקסט dd/mm/yyyy');
  // a file that is not a debt report
  try { D.parseDebtExport(book([['x']], ['a'])); ok(false, 'קובץ זר נדחה'); } catch (e) { ok(e.status === 400 && /[א-ת]/.test(e.message), 'קובץ זר נדחה'); }
  // two months in one file
  try { D.parseDebtExport(book([row(), row({ id: '000000026', month: serial(2026, 9) })])); ok(false, 'שני חודשים נדחים'); }
  catch (e) { ok(e.status === 400 && /חודש/.test(e.message), 'שני חודשים בקובץ נדחים'); }

  // ---- import + summary
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error('not loopback');
  await mongoose.connect(uri);
  const { Branch, Registration, Child, ClickTacImport, ClickTacMonthRow, User } = require('../src/models');

  const dayan = await Branch.create({ name: 'כפר סבא - משה דיין' });
  const herz = await Branch.create({ name: 'הרצליה הרצוג' });
  const by = new mongoose.Types.ObjectId();
  const reg = await Registration.create({
    unique_id: 'U1', child_name: 'ילד', parent_name: 'הורה', monthly_fee: 3000, start_date: new Date(2025, 8, 1),
    end_date: new Date(2026, 7, 31), academic_year: '2026-2027', status: 'completed', branch_id: dayan._id,
  });
  // stored without the leading zeros — the join must still find it
  await Child.create({ registration_id: reg._id, child_name: 'ילד', academic_year: '2026-2027', child_id_number: '18' });

  const file1 = book([
    row({ id: '18', target: 1634, paid: 0 }),
    row({ id: '000000026', first: 'ה', last: 'ו', target: 3000, paid: 1000, method: '' }),
    row({ id: 'ab123456', first: 'ג', last: 'ד', target: 2000, paid: 2000, cstatus: 'שולם' }),
  ]);
  const r1 = await D.importDebt({ buffer: file1, branch_id: dayan._id, by, file_name: 'a.xlsx' });
  eq(r1.month, '2026-10', 'importDebt מחזיר חודש');
  eq(r1.rows, 3, 'importDebt מחזיר מספר שורות');
  eq(r1.replaced, 0, 'ייבוא ראשון — לא הוחלף דבר');
  eq(await ClickTacMonthRow.countDocuments({ branch_id: dayan._id, month: '2026-10' }), 3, 'שלוש שורות נשמרו');
  eq(await ClickTacImport.countDocuments({ branch_id: dayan._id }), 1, 'רשומת ייבוא אחת');

  const s1 = await D.debtSummary({ branch_id: dayan._id, month: '2026-10' });
  eq(s1.length, 1, 'קבוצה אחת: סניף+חודש');
  const g = s1[0];
  eq(g.target, 6634, 'יעד כולל');
  eq(g.paid, 3000, 'שולם כולל');
  eq(g.gap, 3634, 'פער');
  eq(g.unpaid_count, 2, 'שני ילדים לא סגרו');
  eq(g.no_method_count, 1, 'אחד בלי אמצעי תשלום (מבין אלה שלא סגרו)');
  eq(g.unpaid.length, 2, 'רשימת חייבים');
  const l18 = g.unpaid.find(u => u.child_id_number === '000000018');
  eq(String(l18.child_link), String(reg._id), 'child_link = מזהה הרישום (ת״ז בלי אפסים מקדימים ב-Child)');
  eq(l18.gap, 1634, 'פער לילד');
  eq(g.unpaid.find(u => u.child_id_number === '000000026').child_link, null, 'ילד בלי רישום — child_link null');

  // re-upload replaces that branch+month only
  await D.importDebt({ buffer: book([row({ inst: 'הרצליה', id: '18', target: 1634, paid: 1634, cstatus: 'שולם' })]), branch_id: herz._id, by });
  const r2 = await D.importDebt({ buffer: book([row({ id: '18', target: 1634, paid: 1634, cstatus: 'שולם' })]), branch_id: dayan._id, by });
  eq(r2.replaced, 3, 'העלאה חוזרת מחליפה את שלוש השורות הקודמות');
  eq(await ClickTacMonthRow.countDocuments({ branch_id: dayan._id, month: '2026-10' }), 1, 'נשארה שורה אחת בסניף');
  eq(await ClickTacMonthRow.countDocuments({ branch_id: herz._id, month: '2026-10' }), 1, 'סניף אחר לא נגע');
  // a different month is kept
  await D.importDebt({ buffer: book([row({ id: '18', month: serial(2026, 9), target: 100, paid: 0 })]), branch_id: dayan._id, by });
  eq(await ClickTacMonthRow.countDocuments({ branch_id: dayan._id }), 2, 'חודש אחר נשמר');
  const all = await D.debtSummary({});
  eq(all.length, 3, 'בלי סינון — כל קבוצות סניף+חודש');

  // guards
  await rejects(() => D.importDebt({ buffer: book([row({ inst: 'תל אביב יפו - אייזיק חריף' })]), branch_id: dayan._id, by }), 400, 'קובץ בלי אף שורה של הסניף נדחה');
  const mixed = await D.importDebt({ buffer: book([row({ id: '18' }), row({ id: '000000026', inst: 'תל אביב יפו - אייזיק חריף' })]), branch_id: dayan._id, by });
  eq(mixed.rows, 1, 'קובץ ארגוני: רק שורות הסניף נקלטות');
  eq(mixed.skipped, 1, 'שורה של עיר אחרת דולגה ונספרה');
  eq(await ClickTacMonthRow.countDocuments({ child_id_number: '000000026', branch_id: dayan._id, month: '2026-10' }), 0, 'שורת העיר האחרת לא נכתבה');
  await rejects(() => D.importDebt({ buffer: book([row()]), branch_id: new mongoose.Types.ObjectId(), by }), 404, 'סניף לא קיים');
  eq(await ClickTacMonthRow.countDocuments({ branch_id: dayan._id, month: '2026-10' }), 1, 'הדחייה והקליטה החלקית השאירו שורה אחת');
  // duplicates of one child inside a file are summed, not a unique-index crash
  const dup = await D.importDebt({ buffer: book([row({ inst: 'הרצליה', id: '000000026', target: 100, paid: 10 }), row({ inst: 'הרצליה', id: '26', target: 50, paid: 5 })]), branch_id: herz._id, by });
  eq(dup.rows, 1, 'אותו ילד פעמיים בקובץ — שורה אחת');
  const dg = (await D.debtSummary({ branch_id: herz._id, month: '2026-10' }))[0];
  eq(dg.target, 150, 'כפילות סוכמה');

  // קפלן refused; Kaplan-institution rows never land in משה דיין
  const kaplanBranch = await Branch.create({ name: 'כפר סבא - קפלן' });
  const before = await ClickTacMonthRow.countDocuments({});
  await rejects(() => D.importDebt({ buffer: book([row({ id: '18' })]), branch_id: kaplanBranch._id, by }), 400, 'סניף קפלן נדחה');
  eq(await ClickTacMonthRow.countDocuments({}), before, 'קפלן: אפס שורות נכתבו');
  const kmix = await D.importDebt({ buffer: book([row({ id: '18' }), row({ id: '000000042', inst: 'כפר סבא - קפלן' })]), branch_id: dayan._id, by });
  eq(kmix.rows, 1, 'שורת מוסד קפלן לא נקלטת במשה דיין');
  eq(await ClickTacMonthRow.countDocuments({ child_id_number: '000000042' }), 0, 'שורת קפלן לא נשמרה');

  // atomic replace: a failing insert leaves the old rows alone
  const oldRows = await ClickTacMonthRow.countDocuments({ branch_id: dayan._id, month: '2026-10' });
  const realInsert = ClickTacMonthRow.insertMany;
  ClickTacMonthRow.insertMany = async () => { throw new Error('boom'); };
  try { await D.importDebt({ buffer: book([row({ id: '000000077' }), row({ id: '000000078' })]), branch_id: dayan._id, by }); ok(false, 'כשל הכנסה נזרק'); }
  catch (e) { eq(e.message, 'boom', 'כשל הכנסה מוחזר'); }
  ClickTacMonthRow.insertMany = realInsert;
  eq(await ClickTacMonthRow.countDocuments({ branch_id: dayan._id, month: '2026-10' }), oldRows, 'כשל הכנסה — השורות הישנות שלמות');
  eq(await ClickTacMonthRow.countDocuments({ child_id_number: '000000077' }), 0, 'כשל הכנסה — אין שורות חדשות');
  eq(await ClickTacMonthRow.countDocuments({ month: /~/ }), 0, 'אין שורות ביניים');

  // number parsing
  eq(D.parseDebtExport(book([row({ target: '(1,234)', paid: '-' })])).rows[0].target, -1234, '"(1,234)" שלילי');
  eq(D.parseDebtExport(book([row({ target: '(1,234)', paid: '-' })])).rows[0].paid, 0, '"-" בודד אינו מספר');

  // never writes the collections side
  const { Collection, ExternalEnrollment } = require('../src/models');
  eq((await Collection.countDocuments({})) + (await Registration.countDocuments({})) - 1 + (await ExternalEnrollment.countDocuments({})), 0, 'אין כתיבה לגבייה/רישומים/ExternalEnrollment');

  await mongoose.disconnect(); await mongod.stop();
  console.log(failures ? `\n❌ ${failures} נכשלו\n` : '\n✅ הכול עבר\n');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
