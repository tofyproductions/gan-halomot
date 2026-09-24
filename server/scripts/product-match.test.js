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

  // ---------------------------------------------------------------- 6 ------
  head('6 — אישור, מיזוג לקבוצה, דחייה, ביטול');
  let confirmedGroupId;
  {
    // Fresh proposal between the wipes (the earlier one was rejected — use a new pair via a third supplier).
    const third = await Supplier.create({ name: 'ספק ג', vat_rate: 1.18 });
    const wipesThird = await mk(third._id, 'T1', 'מגבונים לחים 60 יח׳', 'חבילה', 6);
    const p1 = await ProductMatch.create({
      products: [{ product_id: wipesShabi._id, supplier_id: shabi._id, pack_qty: 80 }, { product_id: wipesThird._id, supplier_id: third._id, pack_qty: 60 }],
      base_unit: 'מגבון', label: 'מגבונים', status: 'proposed', confidence: 0.9, pair_key: ProductMatch.pairKey(wipesShabi._id, wipesThird._id),
    });
    const g = await svc.confirmMatch(p1._id, { pack_qty: { [String(wipesShabi._id)]: 80, [String(wipesThird._id)]: 60 }, base_unit: 'מגבון', decided_by: 'אורי' });
    eq(g.status, 'confirmed', '6a אושר');
    eq(g.decided_by, 'אורי', '6b מי אישר');
    confirmedGroupId = String(g._id);

    // A second proposal whose one side is already in the confirmed group → merged.
    const p2 = await ProductMatch.create({
      products: [{ product_id: wipesThird._id, supplier_id: third._id, pack_qty: 60 }, { product_id: wipesDalas._id, supplier_id: dalas._id, pack_qty: 400 }],
      base_unit: 'מגבון', label: 'מגבונים', status: 'proposed', confidence: 0.8, pair_key: ProductMatch.pairKey(wipesThird._id, wipesDalas._id),
    });
    const g2 = await svc.confirmMatch(p2._id, { pack_qty: { [String(wipesDalas._id)]: 400 }, base_unit: 'מגבון', decided_by: 'אורי' });
    eq(String(g2._id), confirmedGroupId, '6c מוזג לקבוצה הקיימת');
    eq(g2.products.length, 3, '6d שלושה חברים');
    const p2db = await ProductMatch.findById(p2._id).lean();
    eq([p2db.status, String(p2db.merged_into)], ['confirmed', confirmedGroupId], '6e ההצעה נשמרה עם merged_into — ה-pair_key ממשיך לשמור');

    // Reject and unlink.
    const p3 = await ProductMatch.create({
      products: [{ product_id: dates._id, supplier_id: shabi._id, pack_qty: 1 }, { product_id: towels._id, supplier_id: dalas._id, pack_qty: 1 }],
      base_unit: 'יחידה', status: 'proposed', confidence: 0.7, pair_key: ProductMatch.pairKey(dates._id, towels._id),
    });
    const rj = await svc.rejectMatch(p3._id, 'אורי');
    eq(rj.status, 'rejected', '6f נדחה');
    const un = await svc.unlinkMatch(confirmedGroupId, 'אורי');
    eq(un.status, 'rejected', '6g ביטול התאמה = rejected');
    // Manual match re-creates a confirmed group between two of them.
    const man = await svc.manualMatch([String(wipesShabi._id), String(wipesDalas._id)], 'אורי');
    eq([man.status, man.proposed_by], ['confirmed', 'user'], '6h התאמה ידנית מאושרת מיד');
    ok(await ProductMatch.findOne({ pair_key: ProductMatch.pairKey(wipesShabi._id, wipesDalas._id) }), '6i עם pair_key');
    confirmedGroupId = String(man._id);
    await ProductMatch.updateOne({ _id: man._id }, { $set: { base_unit: 'מגבון', 'products.$[a].pack_qty': 80, 'products.$[b].pack_qty': 400 } },
      { arrayFilters: [{ 'a.product_id': wipesShabi._id }, { 'b.product_id': wipesDalas._id }] });

    // Two documents with no pair_key at all must both save — a sparse unique index skips ABSENT fields, not null.
    const noKey1 = await ProductMatch.create({
      products: [{ product_id: dates._id, supplier_id: shabi._id, pack_qty: 1 }, { product_id: towels._id, supplier_id: dalas._id, pack_qty: 1 }],
      base_unit: 'יחידה', status: 'proposed', confidence: 0.5,
    });
    const noKey2 = await ProductMatch.create({
      products: [{ product_id: wipesThird._id, supplier_id: third._id, pack_qty: 60 }, { product_id: towels._id, supplier_id: dalas._id, pack_qty: 1 }],
      base_unit: 'יחידה', status: 'proposed', confidence: 0.5,
    });
    ok(noKey1._id && noKey2._id, '6j שתי התאמות בלי pair_key כלל — שתיהן נשמרות');
  }

  // ---------------------------------------------------------------- 7 ------
  head('7 — ההשוואה: מחיר ליחידה ואחוז ההפרש');
  {
    const cmp = await svc.comparisonFor(String(shabi._id));
    const rows = cmp[String(wipesShabi._id)];
    ok(Array.isArray(rows) && rows.length === 1, '7a למגבונים של שאבי יש השוואה אחת');
    const r = rows[0];
    eq(r.supplier_name, 'דאלאס', '7b מול דאלאס');
    eq(r.per_unit_price, Number((96.78 / 400).toFixed(4)), '7c מחיר למגבון אצל דאלאס');
    eq(r.my_per_unit_price, Number((9.44 / 80).toFixed(4)), '7d ומחיר למגבון אצלי');
    eq(r.diff_pct, Math.round(((96.78 / 400) / (9.44 / 80) - 1) * 100), '7e אחוז ההפרש (חיובי = הספק האחר יקר יותר)');
    eq(cmp[String(dates._id)], undefined, '7f למוצר בלי התאמה — כלום');

    // Unknown pack → per-unit null, pack price still there.
    await ProductMatch.updateOne({ _id: confirmedGroupId }, { $set: { 'products.$[b].pack_qty': null } }, { arrayFilters: [{ 'b.product_id': wipesDalas._id }] });
    const cmp2 = await svc.comparisonFor(String(shabi._id));
    eq(cmp2[String(wipesShabi._id)][0].per_unit_price, null, '7g כמות לא ידועה → אין מחיר ליחידה');
    eq(cmp2[String(wipesShabi._id)][0].price_with_vat, 96.78, '7h אבל מחיר האריזה כן');
    eq(cmp2[String(wipesShabi._id)][0].diff_pct, null, '7i ובלי אחוז');
  }

  // ---------------------------------------------------------------- 8 ------
  head('8 — נתיבים: מאושרות לכולם, סקירה וסריקה למנהל מערכת בלבד');
  {
    // Put this at the top of section 8, before requiring the controller:
    const sdkPath = require.resolve('@anthropic-ai/sdk');
    const fake = fakeClient([{ matches: [] }, { matches: [] }, { matches: [] }]);
    require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, children: [], paths: [], exports: function Anthropic() { return fake; } };

    const c = require('../src/controllers/productMatch.controller');
    function invoke(fn, { body = {}, params = {}, query = {}, user = { id: 'u1', role: 'system_admin', full_name: 'אורי' } } = {}) {
      return new Promise((resolve, reject) => {
        const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(p) { resolve({ status: this.statusCode, body: p }); } };
        fn({ body, params, query, user }, res, (err) => (err ? reject(err) : resolve({ status: 500, body: null })));
      });
    }
    const cook = { id: 'u2', role: 'cook', full_name: 'טבחית' };
    const r = await invoke(c.matches, { query: { supplier: String(shabi._id) }, user: cook });
    eq(r.status, 200, '8a טבחית קוראת השוואות');
    ok(r.body.matches && r.body.matches[String(wipesShabi._id)], '8b ומקבלת את המגבונים');

    const rv = await invoke(c.review, {});
    eq(rv.status, 200, '8c סקירה למנהל');
    ok(Array.isArray(rv.body.proposed) && Array.isArray(rv.body.confirmed), '8d שתי רשימות');
    ok(rv.body.confirmed[0].products[0].name, '8e עם המוצרים מלאים (שם)');
    ok('last_scan' in rv.body, '8f ומועד הסריקה האחרונה');

    // The review controller's role gate lives in the ROUTES (requireRole) — assert the route file wires it.
    const routesSrc = require('fs').readFileSync(require.resolve('../src/routes/product.routes'), 'utf8');
    ok(/matches\/review'[^\n]*system_admin|adminOnly[^\n]*review/.test(routesSrc), '8g הנתיב review מוגן ל-system_admin');
    ok(/matches\/scan'[^\n]*(system_admin|adminOnly)/.test(routesSrc), '8h וגם scan');
    ok(routesSrc.indexOf("'/matches'") < routesSrc.indexOf("'/:id/image'"), '8i נתיבי matches לפני /:id/image');

    const scan = await invoke(c.scan, {});
    eq(scan.status, 200, '8j סריקה ידנית עונה');
    ok('scanned' in scan.body && 'proposed' in scan.body, '8k עם מספרים');

    // Import triggers a throttled scan (observed through the throttle state, not the network).
    svc._resetThrottle();
    const pc = require('../src/controllers/product.controller');
    const imp = await invoke(pc.bulkImport, { body: { supplier_id: String(dalas._id), products: [{ sku: '9', name: 'סבון ידיים 5 ליטר', unit: 'מיכל', price_before_vat: 30 }] } });
    eq(imp.status, 201, '8l ייבוא הצליח');
    const second = svc.throttledScan('test');
    eq(second, false, '8m הייבוא כבר הפעיל סריקה — השנייה נדחתה');
    await new Promise(r => setTimeout(r, 300));
  }

  // __TASKS_APPEND_HERE_3__

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
