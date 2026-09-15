#!/usr/bin/env node
/**
 * A supplier's catalogue: its pictures, its units, and what happens the second
 * time the same price list arrives.
 *
 * WHAT THIS EXISTS FOR. A price list is a document that gets RE-SENT — that is
 * the normal life of one — and the import this app had made a fresh row every
 * time. A second import of the same list left the order form showing every
 * product twice, at two prices, with nothing to say which was current. Nobody
 * would see that until they were ordering.
 *
 * And the unit. DALAS sells item 50403 at ₪240 per CARTON and item 2101 at
 * ₪3.68 per UNIT; an order line that says "1" and a price cannot tell you which
 * one is about to arrive. The unit has to survive the whole way — from the
 * catalogue, onto the order, onto the document the supplier reads — so it is
 * asserted at each of those three points rather than only where it is stored.
 *
 * The pictures are asserted for what they cost as much as for what they show:
 * forty of them inlined in the product list is 400KB on a screen that draws
 * them at fifty pixels, which is why image_data is select:false and why the
 * list must keep coming back small.
 *
 *   node scripts/supplier-catalogue.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label,
    `קיבלנו ${JSON.stringify(actual)}, ציפינו ${JSON.stringify(expected)}`);
}
function head(t) { console.log(`\n${t}`); }

/** A 1x1 JPEG, so the image path is exercised with real bytes and not a string. */
const PIXEL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL'
  + 'DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

let mongod;

async function main() {
  console.log('=== קטלוג ספק — תמונות, יחידות מידה, וייבוא חוזר ===');

  mongod = await MongoMemoryServer.create({ instance: { dbName: 'catalogue_test' } });
  const uri = mongod.getUri();
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri);
  ok(/127\.0\.0\.1|localhost/.test(uri), 'מסד נתונים מקומי וזמני בלבד', uri);

  const { Supplier, Product } = require('../src/models');
  const productController = require('../src/controllers/product.controller');
  const orderController = require('../src/controllers/order.controller');

  /** Call a controller the way express would, and hand back what it answered. */
  function invoke(fn, { body = {}, params = {}, query = {}, user = { id: 'u1', role: 'system_admin' } } = {}) {
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        headers: {},
        set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(payload) { resolve({ status: this.statusCode, body: payload, headers: this.headers }); },
        send(payload) { resolve({ status: this.statusCode, body: payload, headers: this.headers }); },
      };
      fn({ body, params, query, user }, res, (err) => (err ? reject(err) : resolve({ status: 500, body: null })));
    });
  }

  const supplier = await Supplier.create({ name: 'דאלאס מוצרי נייר', vat_rate: 1.18 });
  const sid = String(supplier._id);

  // The two rows that make the point, plus one with no picture at all.
  const list = (price = 240) => ([
    { sku: '50403', name: 'אשפתון כתום בגליל 78/90', unit: 'קרטון', price_before_vat: price, image_data: PIXEL },
    { sku: '2101', name: 'מגב חלונות 20 ס"מ', unit: 'יחידה', price_before_vat: 3.68, image_data: PIXEL },
    { sku: '20124', name: 'ג\'ל אסלות', unit: 'יחידה', price_before_vat: 11 },
  ]);

  // ---------------------------------------------------------------- 1 ------
  head('1 — ייבוא ראשון');
  {
    const r = await invoke(productController.bulkImport, { body: { supplier_id: sid, products: list() } });
    eq(r.status, 201, '1a הייבוא החזיר 201');
    eq(r.body.count, 3, '1a שלושה מוצרים נוספו');
    eq(await Product.countDocuments({ supplier_id: sid }), 3, '1a ושלושה בדיוק במסד');

    const p = await Product.findOne({ supplier_id: sid, sku: '50403' }).select('+image_data').lean();
    eq(p.unit, 'קרטון', '1b יחידת המידה נשמרה');
    eq(p.price_before_vat, 240, '1b המחיר לפני מע"מ');
    // The VAT is the supplier's own rate, not a constant — this is what makes
    // importing through the controller worth more than inserting rows.
    eq(p.price_with_vat, 283.2, '1b ומע"מ חושב לפי שיעור הספק (18%)');
    ok(!!p.image_data, '1b והתמונה נשמרה');
  }

  // ---------------------------------------------------------------- 2 ------
  head('2 — אותו מחירון נשלח שוב (זה מה שקורה במציאות)');
  {
    // Prices moved, which is why it was re-sent, and this run carries NO
    // pictures — a paste from a spreadsheet would not.
    const second = list(255).map(({ image_data, ...p }) => p);
    const r = await invoke(productController.bulkImport, { body: { supplier_id: sid, products: second } });
    eq(r.body.count, 0, '2a לא נוספו מוצרים חדשים');
    eq(r.body.updated, 3, '2a שלושה עודכנו');
    eq(await Product.countDocuments({ supplier_id: sid }), 3, '2a ועדיין שלושה — לא שישה');

    const p = await Product.findOne({ supplier_id: sid, sku: '50403' }).select('+image_data').lean();
    eq(p.price_before_vat, 255, '2b המחיר החדש נכנס');
    eq(p.price_with_vat, 300.9, '2b והמע"מ חושב מחדש');
    ok(!!p.image_data, '2c ייבוא בלי תמונות לא מחק את התמונה שכבר הייתה',
      'שליחה מחדש של מחירון כטקסט לא אמורה לרוקן את הקטלוג מתמונות');
  }

  // ---------------------------------------------------------------- 3 ------
  head('3 — התמונות לא נוסעות ברשימה');
  {
    const r = await invoke(productController.getAll, { query: { supplier: sid } });
    eq(r.body.products.length, 3, '3a הרשימה מחזירה שלושה');
    const withPic = r.body.products.find(p => p.sku === '50403');
    const without = r.body.products.find(p => p.sku === '20124');
    eq(withPic.has_image, true, '3a מי שיש לו תמונה מסומן');
    eq(without.has_image, false, '3a ומי שאין לו — לא');
    ok(!('image_data' in withPic), '3b ואף אחד מהם לא נושא את הבייטים עצמם',
      'image_data ברשימה = 400KB לכל פתיחת מסך הזמנה');
    ok(!JSON.stringify(r.body).includes('/9j/4AAQ'), '3b גם לא במקום אחר בתשובה');
    eq(withPic.unit, 'קרטון', '3c יחידת המידה כן חוזרת — המסך צריך אותה');
  }

  // ---------------------------------------------------------------- 4 ------
  head('4 — התמונה עצמה, אחת ביחידה');
  {
    const p = await Product.findOne({ supplier_id: sid, sku: '50403' }).lean();
    const r = await invoke(productController.image, { params: { id: String(p._id) } });
    eq(r.status, 200, '4a הבקשה לתמונה החזירה 200');
    eq(r.headers['content-type'], 'image/jpeg', '4a עם סוג התוכן הנכון');
    ok(Buffer.isBuffer(r.body) && r.body.length > 0, '4a והגיעו בייטים אמיתיים');
    ok(/max-age=\d{4,}/.test(r.headers['cache-control'] || ''),
      '4b עם מטמון ארוך — מסך עם ארבעים מוצרים שואל פעם אחת');

    const none = await Product.findOne({ supplier_id: sid, sku: '20124' }).lean();
    const r2 = await invoke(productController.image, { params: { id: String(none._id) } });
    eq(r2.status, 404, '4c מוצר בלי תמונה מחזיר 404 ולא תמונה ריקה');
  }

  // ---------------------------------------------------------------- 5 ------
  head('5 — היחידה מגיעה עד ההזמנה, ועד הספק');
  {
    const { Branch } = require('../src/models');
    const branch = await Branch.create({ name: 'תל אביב' });
    const carton = await Product.findOne({ supplier_id: sid, sku: '50403' }).lean();

    const r = await invoke(orderController.create, {
      body: {
        branch_id: String(branch._id), supplier_id: sid, created_by: 'בדיקה',
        // The browser sends a WRONG unit on purpose: the order must record what
        // the catalogue says this item is sold by, not what a stale screen said.
        items: [{ product_id: String(carton._id), sku: '50403', name: carton.name, qty: 2, unit: 'יחידה', unit_price: 300.9 }],
      },
    });
    ok(r.status === 201 || r.status === 200, '5a ההזמנה נוצרה', `status=${r.status}`);
    const line = (r.body.order?.items || [])[0];
    eq(line.unit, 'קרטון', '5a והשורה רשומה בקרטון — מהקטלוג, לא מהדפדפן');
    eq(line.qty, 2, '5a כמות 2');

    const { buildSupplierHTML } = require('../src/services/order-pdf.service');
    const html = buildSupplierHTML({
      order: { order_number: 'ORD-1', created_at: new Date(), items: r.body.order.items },
      supplier: { name: 'דאלאס' }, branch: { name: 'תל אביב' },
    });
    ok(/<b>2<\/b>\s*<span class="unit">קרטון<\/span>/.test(html),
      '5b והמסמך שהספק מקבל אומר "2 קרטון" ולא "2"');

    // A product from before any of this existed has no unit, and must print
    // exactly as it always did.
    const old = buildSupplierHTML({
      order: { order_number: 'ORD-2', created_at: new Date(), items: [{ sku: 'X', name: 'מוצר ישן', qty: 1, unit: '' }] },
      supplier: { name: 'דאלאס' }, branch: { name: 'תל אביב' },
    });
    ok(/<b>1<\/b><\/td>/.test(old) && !/class="unit"/.test(old),
      '5c ומוצר ותיק בלי יחידה מודפס כמו קודם, בלי שארית');
  }
}

async function teardown() {
  try { await mongoose.disconnect(); } catch { /* already down */ }
  try { if (mongod) await mongod.stop(); } catch { /* already down */ }
}

main()
  .then(async () => {
    await teardown();
    console.log(`\n${failures === 0 ? '✅ הכל עבר' : `❌ ${failures} מתוך ${checks} בדיקות נכשלו`}\n`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error('\n❌ הבדיקה קרסה:', err.message);
    console.error(err.stack);
    await teardown();
    process.exit(1);
  });
