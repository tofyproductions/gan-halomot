#!/usr/bin/env node
/**
 * Max xlsx → the gan's two cards. One Max login covers three cards across two
 * companies; only 7996 (בן) and 8093 (אלעד) are the gan's.
 *
 *   node scripts/max-import.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };
const XLSX = require('xlsx');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const ok = (c, l) => { console.log(`  ${c ? '✅' : '❌'} ${l}`); if (!c) failures++; };
const eq = (a, b, l) => ok(a === b, `${l}${a === b ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);

// Max puts a title block above the header — the parser must find the header by name.
function makeXlsx(rows, { extraColumnFirst = false } = {}) {
  const header = ['תאריך עסקה', 'שם בית העסק', 'קטגוריה', '4 ספרות אחרונות של כרטיס האשראי', 'סוג עסקה', 'סכום חיוב', 'מטבע חיוב', 'תאריך חיוב', 'הערות'];
  const h = extraColumnFirst ? ['עמודה חדשה', ...header] : header;
  const body = rows.map(r => {
    const line = [r.date, r.merchant, 'מזון', r.card, 'רגילה', r.amount, '₪', r.charge || '02-10-2026', r.note || ''];
    return extraColumnFirst ? ['x', ...line] : line;
  });
  const ws = XLSX.utils.aoa_to_sheet([['פירוט עסקאות'], [], h, ...body]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'עסקאות');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const { BankTransaction, BankAccount, Setting } = require('../src/models');
  const { parseMaxExport, importMaxExport, allowedCards, DEFAULT_CARDS } = require('../src/services/maxImport.service');

  console.log('\n💳 ייבוא פירוט חיובים מ-Max\n');

  const file = makeXlsx([
    { date: '05-09-2026', merchant: 'שופרסל', card: '7996', amount: 300 },
    { date: '06-09-2026', merchant: 'פז', card: '8093', amount: 200 },
    { date: '07-09-2026', merchant: 'Anthropic', card: '2319', amount: 90 },
    { date: '08-09-2026', merchant: 'זיכוי', card: '7996', amount: -50, note: 'ביטול עסקה' },
  ]);

  console.log('קריאה');
  {
    const p = parseMaxExport(file);
    eq(p.rows.length, 4, 'ארבע שורות נקראו');
    eq(p.rows[0].date, '2026-09-05', 'תאריך הפוך לפורמט אחיד');
    eq(p.rows[0].chargeDate, '2026-10-02', 'תאריך חיוב נקרא');
    eq(p.cardsSeen['2319'], 1, 'כרטיס של טופי נראה ונספר');
    const shifted = parseMaxExport(makeXlsx([{ date: '05-09-2026', merchant: 'א', card: '7996', amount: 10 }], { extraColumnFirst: true }));
    eq(shifted.rows[0].amount, 10, 'עמודה חדשה בהתחלה — עדיין נקרא לפי שם הכותרת');
  }

  console.log('\nקבצים שגויים');
  {
    let e = null; try { parseMaxExport(Buffer.from('%PDF-1.4 hello')); } catch (x) { e = x; }
    ok(e && /PDF/.test(e.message), 'PDF נדחה עם הסבר');
    e = null; try { parseMaxExport(Buffer.from('not a file')); } catch (x) { e = x; }
    ok(!!e, 'קובץ שאינו אקסל נדחה');
  }

  console.log('\nכרטיסים');
  {
    eq(JSON.stringify(await allowedCards()), JSON.stringify(DEFAULT_CARDS), 'ברירת מחדל: 7996 ו-8093');
    const r = await importMaxExport(file);
    eq(JSON.stringify(r.cards_imported.sort()), JSON.stringify(['7996', '8093']), 'נכנסו רק כרטיסי הגן');
    eq(JSON.stringify(r.cards_skipped), JSON.stringify(['2319']), 'כרטיס של טופי דולג');
    eq(await BankTransaction.countDocuments(), 3, 'שלוש תנועות במסד');
    ok(await BankAccount.findOne({ external_id: 'max:••••7996', type: 'card' }), 'חשבון max:••••7996 נוצר כסוג כרטיס');
  }

  console.log('\nסימן');
  {
    const buy = await BankTransaction.findOne({ description: 'שופרסל' }).lean();
    eq(buy.amount, -300, 'רכישה נשמרת כשלילית — יוצא');
    const refund = await BankTransaction.findOne({ description: 'זיכוי' }).lean();
    eq(refund.amount, 50, 'זיכוי נשמר כחיובי — נכנס');
    eq(buy.processed_date, '2026-10-02', 'תאריך החיוב נשמר כ-processed_date');
  }

  console.log('\nייבוא חוזר');
  {
    const r = await importMaxExport(file);
    eq(r.inserted, 0, 'אותו קובץ שוב — אין חדשות');
    eq(await BankTransaction.countDocuments(), 3, 'ואין כפילויות');
  }

  console.log('\nתשלומים');
  {
    const before = await BankTransaction.countDocuments();
    const mk = (note, charge) => makeXlsx([{ date: '01-08-2026', merchant: 'מקס מציאות', card: '7996', amount: 100, note, charge }]);
    const fa = mk('תשלום 1 מתוך 3', '02-09-2026');
    const fb = mk('תשלום 2 מתוך 3', '02-10-2026');
    await importMaxExport(fa);
    await importMaxExport(fb);
    eq(await BankTransaction.countDocuments(), before + 2, 'שני תשלומים של אותה רכישה — שתי שורות, שניהם נשמרו');
    await importMaxExport(fa);
    eq(await BankTransaction.countDocuments(), before + 2, 'העלאה חוזרת של קובץ התשלום הראשון — עדיין אידמפוטנטי');
  }

  console.log('\nהגדרה');
  {
    await Setting.create({ key: 'max_import_cards', value: '7996' });
    eq(JSON.stringify(await allowedCards()), JSON.stringify(['7996']), 'רשימת כרטיסים נקראת מההגדרות');
  }

  await mongoose.disconnect(); await mongod.stop();
  console.log(failures ? `\n❌ ${failures} נכשלו` : '\n✅ הכל עבר');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
