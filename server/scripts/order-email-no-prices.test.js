#!/usr/bin/env node
/**
 * The supplier is never told what we expect to pay.
 *
 * Those prices are what the gan paid last time, and sometimes the supplier
 * would have quoted less — so stating them in his copy ends the negotiation
 * before it opens. The two documents were always right about this
 * (buildSupplierHTML has never carried a price) and the ENVELOPE was wrong:
 * both files went in one message addressed to him, under a body that listed
 * every unit price and the total underneath.
 *
 * That is the kind of mistake that comes back. The documents look correct in
 * review, the routing is somewhere else entirely, and nothing fails — the
 * order arrives, the supplier is happy, and the only symptom is a price that
 * never goes down. So this checks the messages that are actually dispatched,
 * not the documents they carry.
 *
 * No database and no network: dispatchEmail is replaced and the letters are
 * read out of the calls.
 *
 *   node scripts/order-email-no-prices.test.js
 */
const path = require('path');

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

// A provider must look configured or the senders skip without sending.
process.env.SMTP_USER = 'test@example.test';

let failures = 0;
let checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
};
const head = (t) => console.log(`\n${t}`);

const email = require(path.join(__dirname, '../src/services/email.service'));

const sent = [];
email.dispatchEmail = async (msg) => {
  sent.push(msg);
  return { messageId: `m${sent.length}`, provider: 'test' };
};

const SUPPLIER = { name: 'ספק הבדיקה', contact_email: 'supplier@example.test', vat_rate: 1.18 };
const BRANCH = { name: 'כפר סבא - משה דיין', address: 'משה דיין 9' };
const ORDER = {
  order_number: 'ORD-100002',
  total_amount: 3352,
  notes: '',
  items: [
    { sku: '30780', name: 'טבליות פיניש למדיח', qty: 2, unit_price: 93, total: 186 },
    { sku: '50403', name: 'אשפתון כתום בגליל', qty: 2, unit_price: 283, total: 566 },
  ],
};

/** Every number that must not reach the supplier, as it would be written. */
const MONEY = ['93', '283', '186', '566', '3,352', '3352'];

/**
 * What a human actually READS in the letter and its attachments.
 *
 * The raw HTML is useless for this: a stylesheet full of `#1e293b` and
 * `#cbd5e1` contains "93", "283" and "566" as substrings, so searching the
 * source reports a leak on every document ever written. Styles and tags come
 * out first, and what is left is the page.
 */
const bodyAndFiles = (msg) => [msg.html || '', ...(msg.attachments || []).map(a => a.html || '')]
  .join('\n')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ');

async function main() {
  console.log('=== הזמנה לספק — בלי מחירים ===');

  /* ---------------------------------------------------------------- */
  head('1. הזמנה רגילה');
  sent.length = 0;
  await email.sendOrderEmail({
    order: ORDER, supplier: SUPPLIER, branch: BRANCH,
    creatorEmail: 'office@gan.test', creatorName: 'עמית',
  });

  const toSupplier = sent.filter(m => m.to === SUPPLIER.contact_email);
  const toUs = sent.filter(m => m.to !== SUPPLIER.contact_email);
  ok(toSupplier.length === 1, 'נשלח מייל אחד לספק', `נשלחו ${toSupplier.length}`);
  ok(toUs.length === 1, 'ומייל נפרד אלינו', `נשלחו ${toUs.length}`);

  const supplierText = bodyAndFiles(toSupplier[0] || {});
  const leaked = MONEY.filter(n => supplierText.includes(n));
  ok(leaked.length === 0, 'המייל לספק — אפס מחירים, גם בגוף וגם בקובץ',
    leaked.length ? `דלף: ${leaked.join(', ')}` : '');
  ok(!/מחיר|סה"כ לתשלום/.test(supplierText), 'ואין בו כותרת מחיר');
  ok((toSupplier[0].attachments || []).length === 1, 'ומצורף לו קובץ אחד בלבד — שלו',
    `מצורפים ${(toSupplier[0].attachments || []).length}`);
  ok(!(toSupplier[0].attachments || []).some(a => /פנימית/.test(a.name || '')),
    'המסמך הפנימי אינו נשלח לספק');

  const ourText = bodyAndFiles(toUs[0] || {});
  ok(ourText.includes('93') && ourText.includes('3,352'),
    'העותק שלנו — כן עם המחירים ועם הסכום, להשוואה מול החשבונית');
  ok((toUs[0].attachments || []).some(a => /פנימית/.test(a.name || '')),
    'וכולל את המסמך הפנימי');

  /* ---------------------------------------------------------------- */
  head('2. הזמנה משותפת לכמה סניפים');
  sent.length = 0;
  const TLV = { name: 'תל אביב', address: 'יפו 1' };
  const ORDER2 = { ...ORDER, order_number: 'ORD-100003', total_amount: 1200,
    items: [{ sku: '2112', name: 'מגב פלסטיק', qty: 4, unit_price: 7, total: 28 }] };
  await email.sendGroupOrderEmail({
    orders: [
      { order: ORDER, branch: BRANCH },
      { order: ORDER2, branch: TLV },
    ],
    supplier: SUPPLIER, creatorEmail: 'office@gan.test', creatorName: 'עמית',
  });

  const gSupplier = sent.filter(m => m.to === SUPPLIER.contact_email);
  ok(gSupplier.length === 1, 'מייל אחד לספק');
  const gText = bodyAndFiles(gSupplier[0] || {});
  const gLeaked = [...MONEY, '1,200', '4,552'].filter(n => gText.includes(n));
  ok(gLeaked.length === 0, 'בלי מחירים ובלי הסכום המשותף',
    gLeaked.length ? `דלף: ${gLeaked.join(', ')}` : '');
  // The joint total is the sharpest leak of the lot — it states the whole
  // network's spend with this supplier in one line.
  ok(!/סה"כ משותף/.test(gText), 'ובלי השורה "סה״כ משותף"');
  ok(gText.includes('משה דיין 9') && gText.includes('יפו 1'),
    'אבל כן עם כתובות המשלוח — זה מה שהנהג צריך');
  ok(!(gSupplier[0].attachments || []).some(a => /פנימית/.test(a.name || '')),
    'ובלי אף מסמך פנימי');

  /* ---------------------------------------------------------------- */
  head('3. ספק בלי כתובת מייל');
  sent.length = 0;
  await email.sendOrderEmail({
    order: ORDER, supplier: { ...SUPPLIER, contact_email: '' }, branch: BRANCH,
    creatorEmail: 'office@gan.test', creatorName: 'עמית',
  });
  ok(sent.length === 1, 'נשלח עותק אחד — אלינו');
  ok(sent[0].to !== SUPPLIER.contact_email, 'ולא לספק');
  ok(bodyAndFiles(sent[0]).includes('3,352'), 'והוא כולל את המחירים — זה העותק היחיד שיש');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('\n❌ נפילה:', err); process.exit(1); });
