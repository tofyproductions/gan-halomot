#!/usr/bin/env node
/**
 * The same product at the other supplier, and what it costs there.
 *
 * Two suppliers sell some of the same things under different brands and pack
 * sizes. The person ordering sees one catalogue at a time. Claude proposes
 * pairs, an admin confirms them, the order form shows the other price per
 * real unit. Every pair ever proposed is remembered, a rejected one forever.
 *
 *   node scripts/product-match.test.js
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

/**
 * A stand-in for the Anthropic client. `script` is a queue of responses; each
 * call shifts one. `calls` records what the model was asked, so a test can
 * assert which products were sent.
 */
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(req);
        const next = script.shift();
        if (next instanceof Error) throw next;
        return {
          stop_reason: 'end_turn',
          usage: { input_tokens: 1000, output_tokens: 100 },
          content: [{ type: 'text', text: JSON.stringify(next || { matches: [] }) }],
        };
      },
    },
  };
}

let mongod;

async function main() {
  console.log('=== השוואת מחירים בין ספקים ===');
  mongod = await MongoMemoryServer.create({ instance: { dbName: 'product_match_test' } });
  const uri = mongod.getUri();
  process.env.MONGODB_URI = uri;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  await mongoose.connect(uri);

  const { Supplier, Product, ProductMatch, ProductScanMark, Setting } = require('../src/models');
  const svc = require('../src/services/productMatch.service');

  const shabi = await Supplier.create({ name: 'שאבי', vat_rate: 1.18 });
  const dalas = await Supplier.create({ name: 'דאלאס', vat_rate: 1.18 });
  const mk = (supplier_id, sku, name, unit, price) => Product.create({
    supplier_id, sku, name, unit, price_before_vat: price, price_with_vat: Number((price * 1.18).toFixed(2)), is_active: true,
  });
  // The two that ARE the same thing, in different packs.
  const wipesShabi = await mk(shabi._id, 'S1', 'מגבונים לחים 80 יח׳ חבילה', 'חבילה', 8);
  const wipesDalas = await mk(dalas._id, '2995', 'מגבונים לחים בדלי 400 יחידות', 'קרטון', 82.02);
  // Two that are not.
  const dates = await mk(shabi._id, 'S2', 'ממרח תמרים 450 גרם', 'יחידה', 3.5);
  const towels = await mk(dalas._id, '1402', 'מגבת נייר צץ-רץ', 'קרטון', 45);

  // ---------------------------------------------------------------- 1 ------
  head('1 — טביעת אצבע: שם ויחידה משנים, מחיר לא');
  {
    const f1 = svc.fingerprintOf(wipesShabi);
    ok(/^[0-9a-f]{64}$/.test(f1), '1a sha256 בהקסה');
    const samePriceChanged = svc.fingerprintOf({ ...wipesShabi.toObject(), price_before_vat: 9, price_with_vat: 10.62 });
    eq(samePriceChanged, f1, '1b שינוי מחיר לא משנה');
    const nameChanged = svc.fingerprintOf({ ...wipesShabi.toObject(), name: 'מגבונים לחים 100 יח׳' });
    ok(nameChanged !== f1, '1c שינוי שם משנה');
    const unitChanged = svc.fingerprintOf({ ...wipesShabi.toObject(), unit: 'קרטון' });
    ok(unitChanged !== f1, '1d שינוי יחידה משנה');
    const m = new ProductMatch({ products: [{ product_id: wipesShabi._id, supplier_id: shabi._id, pack_qty: 80 }], base_unit: 'מגבון', status: 'proposed', pair_key: 'x:y' });
    eq(m.validateSync(), undefined, '1e המודל תקין');
    const mark = new ProductScanMark({ fingerprint: f1, product_id: wipesShabi._id });
    eq(mark.validateSync(), undefined, '1f סימן הסריקה תקין');
  }

  // ---------------------------------------------------------------- 2 ------
  head('2 — הסריקה מציעה זוגות; מתחת ל-0.6 לא נשמר');
  {
    const client = fakeClient([
      { matches: [
        { a_id: String(wipesShabi._id), b_id: String(wipesDalas._id), confidence: 0.92, base_unit: 'מגבון', a_pack_qty: 80, b_pack_qty: 400, label: 'מגבונים לחים', reason: 'אותו מוצר, אריזה שונה' },
        { a_id: String(dates._id), b_id: String(towels._id), confidence: 0.2, base_unit: 'יחידה', a_pack_qty: 1, b_pack_qty: 1, label: '', reason: 'לא דומה' },
      ] },
      { matches: [] },
    ]);
    const r = await svc.runScan({ trigger: 'test', client });
    eq(r.scanned, 4, '2a ארבעה מוצרים נסרקו');
    eq(r.proposed, 1, '2b הצעה אחת נשמרה');
    const all = await ProductMatch.find().lean();
    eq(all.length, 1, '2c ורק אחת במסד — ההצעה החלשה לא נשמרה');
    eq(all[0].status, 'proposed', '2d במצב proposed');
    eq(all[0].pair_key, ProductMatch.pairKey(wipesShabi._id, wipesDalas._id), '2e עם pair_key ממוין');
    eq(all[0].products.map(p => p.pack_qty).sort((a, b) => a - b), [80, 400], '2f כמויות האריזה נשמרו');
    ok(client.calls.length >= 1, '2g המודל נקרא');
    const askedText = JSON.stringify(client.calls[0].messages);
    ok(askedText.includes('S1') && askedText.includes('2995'), '2h המוצרים נשלחו למודל');
    const marks = await ProductScanMark.countDocuments();
    eq(marks, 4, '2i כל הארבעה סומנו כנסרקו');
    const last = await Setting.findOne({ key: svc.LAST_SCAN_KEY }).lean();
    eq(last?.value?.proposed, 1, '2j מועד הסריקה האחרונה נרשם');
    ok(r.cost_usd > 0, '2k העלות חושבה');
  }

  // ---------------------------------------------------------------- 3 ------
  head('3 — אותו זוג שוב: לא כפול; זוג שנדחה לא חוזר');
  {
    const first = await ProductMatch.findOne({ status: 'proposed' });
    await ProductMatch.updateOne({ _id: first._id }, { $set: { status: 'rejected', decided_by: 'בדיקה', decided_at: new Date() } });
    // Force a rescan of everything by wiping the marks — the memory of the PAIR must hold on its own.
    await ProductScanMark.deleteMany({});
    const client = fakeClient([
      { matches: [{ a_id: String(wipesShabi._id), b_id: String(wipesDalas._id), confidence: 0.95, base_unit: 'מגבון', a_pack_qty: 80, b_pack_qty: 400, label: 'מגבונים', reason: 'שוב' }] },
      { matches: [{ a_id: String(wipesDalas._id), b_id: String(wipesShabi._id), confidence: 0.95, base_unit: 'מגבון', a_pack_qty: 400, b_pack_qty: 80, label: 'מגבונים', reason: 'הפוך' }] },
    ]);
    const r = await svc.runScan({ trigger: 'test', client });
    eq(r.proposed, 0, '3a שום הצעה חדשה');
    const all = await ProductMatch.find().lean();
    eq(all.length, 1, '3b עדיין רשומה אחת');
    eq(all[0].status, 'rejected', '3c ונשארה דחויה');
  }

  // ---------------------------------------------------------------- 4 ------
  head('4 — מוצר שנסרק לא נשלח שוב; מוצר ששמו השתנה נשלח');
  {
    const client = fakeClient([{ matches: [] }, { matches: [] }]);
    const r = await svc.runScan({ trigger: 'test', client });
    eq(r.scanned, 0, '4a אין מוצרים חדשים — לא נסרק כלום');
    eq(client.calls.length, 0, '4b והמודל לא נקרא');

    await Product.updateOne({ _id: dates._id }, { $set: { name: 'ממרח תמרים 500 גרם' } });
    const client2 = fakeClient([{ matches: [] }]);
    const r2 = await svc.runScan({ trigger: 'test', client: client2 });
    eq(r2.scanned, 1, '4c המוצר ששמו השתנה נסרק');
    eq(client2.calls.length, 1, '4d קריאה אחת למודל');
    const askedText = JSON.stringify(client2.calls[0].messages);
    ok(askedText.includes('500 גרם'), '4e עם השם החדש');
    ok(askedText.includes('2995') && askedText.includes('1402'), '4f מול כל המוצרים של הספק האחר');
    ok(!askedText.includes('"S1"'), '4g ולא מול מוצרי הספק שלו');
  }

  // ---------------------------------------------------------------- 5 ------
  head('5 — השהיה: פעמיים תוך דקה = ריצה אחת; כשל לא מסמן');
  {
    svc._resetThrottle();
    await Product.updateOne({ _id: towels._id }, { $set: { name: 'מגבת נייר צץ-רץ 2 שכבות' } });
    const client = fakeClient([{ matches: [] }, { matches: [] }]);
    const t0 = Date.now();
    const started1 = svc.throttledScan('import', { client, now: t0 });
    const started2 = svc.throttledScan('import', { client, now: t0 + 1000 });
    eq(started1, true, '5a הראשונה רצה');
    eq(started2, false, '5b השנייה נדחתה');
    await new Promise(r => setTimeout(r, 200));
    eq(client.calls.length, 1, '5c קריאה אחת בלבד');
    const started3 = svc.throttledScan('import', { client, now: t0 + svc.SCAN_COOLDOWN_MS + 1 });
    eq(started3, true, '5d אחרי ההשהיה — רצה שוב');
    await new Promise(r => setTimeout(r, 200));

    // A failed call leaves no mark, so the next trigger asks again.
    await Product.updateOne({ _id: towels._id }, { $set: { name: 'מגבת נייר צץ-רץ 3 שכבות' } });
    const failing = fakeClient([new Error('boom')]);
    const r = await svc.runScan({ trigger: 'test', client: failing });
    eq(r.scanned, 0, '5e כשל — לא נסרק');
    ok(r.error, '5f והשגיאה מדווחת');
    const fp = svc.fingerprintOf(await Product.findById(towels._id).lean());
    eq(await ProductScanMark.exists({ fingerprint: fp }), null, '5g בלי סימן — יישלח שוב בטריגר הבא');
    const last = await Setting.findOne({ key: svc.LAST_SCAN_KEY }).lean();
    ok(/boom/.test(last?.value?.error || ''), '5h השגיאה נרשמה בהגדרה');

    // No key: quiet exit.
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const r2 = await svc.runScan({ trigger: 'test' });
    ok(r2.skipped, '5i בלי מפתח — יוצא בשקט');
    process.env.ANTHROPIC_API_KEY = saved;
  }

  // __TASKS_APPEND_HERE__

  console.log(`\n${failures === 0 ? '🎉' : '💥'} ${checks - failures}/${checks} עברו`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); if (mongod) await mongod.stop(); } catch {}
  process.exit(1);
});
