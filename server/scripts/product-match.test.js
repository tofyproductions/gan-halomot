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
