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
 * call shifts one. An entry may be an Error (the call throws), a function of
 * the request (so it can answer with the row keys the request carried), an
 * object with `__response` (a raw response — a cut-off or a refusal), or the
 * JSON body itself. `calls` records what the model was asked, so a test can
 * assert which products were sent.
 */
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(req);
        let next = script.shift();
        if (next instanceof Error) throw next;
        if (typeof next === 'function') next = next(req);
        if (next && next.__response) return { usage: { input_tokens: 1000, output_tokens: 100 }, ...next.__response };
        return {
          stop_reason: 'end_turn',
          usage: { input_tokens: 1000, output_tokens: 100 },
          content: [{ type: 'text', text: JSON.stringify(next || { matches: [] }) }],
        };
      },
    },
  };
}

/** All the text the model was sent. */
function promptOf(req) {
  return req.messages[0].content.map(b => b.text).join('\n');
}

/** sku → row key (A1…, B1…) as the request laid them out: `A1 | ספק | מק"ט | …`. */
function keysBySku(req) {
  const out = {};
  for (const l of promptOf(req).split('\n')) {
    const m = l.match(/^([AB]\d+) \| [^|]* \| ([^|]*) \|/);
    if (m) out[m[2].trim()] = m[1];
  }
  return out;
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
      req => { const k = keysBySku(req); return { matches: [
        { a_id: k.S1, b_id: k['2995'], confidence: 0.92, base_unit: 'מגבון', a_pack_qty: 80, b_pack_qty: 400, label: 'מגבונים לחים', reason: 'אותו מוצר, אריזה שונה' },
        { a_id: k.S2, b_id: k['1402'], confidence: 0.2, base_unit: 'יחידה', a_pack_qty: 1, b_pack_qty: 1, label: '', reason: 'לא דומה' },
      ] }; },
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
    const prompt = promptOf(client.calls[0]);
    ok(!/[0-9a-f]{24}/.test(prompt), '2l אין מזהה מסד (24 הקסה) בבקשה');
    ok(/^A1 \|/m.test(prompt) && /^B1 \|/m.test(prompt), '2m השורות ממופתחות A1…/B1…');
    eq(client.calls.length, 1, '2n הספק השני לא נשאל שוב מול מוצרים חדשים שכבר הושוו מהצד השני');
    const req = client.calls[0];
    eq([req.max_tokens, req.thinking], [16384, { type: 'disabled' }], '2o max_tokens 16384 ובלי thinking');
    const blocks = req.messages[0].content;
    ok(blocks.length === 2 && blocks[0].cache_control?.type === 'ephemeral' && !blocks[1].cache_control
      && /^B1 \|/m.test(blocks[0].text) && /^A1 \|/m.test(blocks[1].text), '2p רשימה ב בבלוק שמור במטמון, השורות החדשות בבלוק שאחריו');
    eq(r.failed_chunks, 0, '2q אין מקטעים שנכשלו');
  }

  // ---------------------------------------------------------------- 3 ------
  head('3 — אותו זוג שוב: לא כפול; זוג שנדחה לא חוזר');
  {
    const first = await ProductMatch.findOne({ status: 'proposed' });
    await ProductMatch.updateOne({ _id: first._id }, { $set: { status: 'rejected', decided_by: 'בדיקה', decided_at: new Date() } });
    // Force a rescan of everything by wiping the marks — the memory of the PAIR must hold on its own.
    await ProductScanMark.deleteMany({});
    const client = fakeClient([
      req => { const k = keysBySku(req); return { matches: [
        { a_id: k.S1, b_id: k['2995'], confidence: 0.95, base_unit: 'מגבון', a_pack_qty: 80, b_pack_qty: 400, label: 'מגבונים', reason: 'שוב' },
        // Keys from the wrong list: an A-key as b_id, a B-key as a_id — ignored.
        { a_id: k['1402'], b_id: k.S2, confidence: 0.95, base_unit: 'יחידה', a_pack_qty: 1, b_pack_qty: 1, label: '', reason: 'הפוך' },
        { a_id: k.S2, b_id: k.S1, confidence: 0.95, base_unit: 'יחידה', a_pack_qty: 1, b_pack_qty: 1, label: '', reason: 'שניהם מרשימה א' },
      ] }; },
      req => { const k = keysBySku(req); return { matches: [{ a_id: k['2995'], b_id: k.S1, confidence: 0.95, base_unit: 'מגבון', a_pack_qty: 400, b_pack_qty: 80, label: 'מגבונים', reason: 'הפוך' }] }; },
    ]);
    const r = await svc.runScan({ trigger: 'test', client });
    eq(r.proposed, 0, '3a שום הצעה חדשה');
    const all = await ProductMatch.find().lean();
    eq(all.length, 1, '3b עדיין רשומה אחת');
    eq(all[0].status, 'rejected', '3c ונשארה דחויה');
    eq(r.scanned, 4, '3d מפתח מהרשימה הלא נכונה לא הפיל את המקטע — כולם נסרקו');
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
    ok(!askedText.includes('| S1 |'), '4g ולא מול מוצרי הספק שלו');
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
    ok(r.error && r.failed_chunks === 1, '5f והשגיאה מדווחת, מקטע אחד נכשל');
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

    // Trailing edge: a trigger dropped inside the cooldown runs once when the cooldown ends.
    svc._resetThrottle();
    svc._setCooldownForTests(150);
    let lastScanWrites = 0;
    const origFOU = Setting.findOneAndUpdate.bind(Setting);
    Setting.findOneAndUpdate = (filter, ...rest) => { if (filter?.key === svc.LAST_SCAN_KEY) lastScanWrites++; return origFOU(filter, ...rest); };
    try {
      const trailing = fakeClient([]);
      const t1 = Date.now();
      eq(svc.throttledScan('import', { client: trailing, now: t1 }), true, '5j ריצה ראשונה');
      eq(svc.throttledScan('import', { client: trailing, now: t1 + 10 }), false, '5k טריגר בתוך ההשהיה נדחה');
      eq(svc.throttledScan('import', { client: trailing, now: t1 + 20 }), false, '5l ועוד אחד');
      await new Promise(r => setTimeout(r, 60));
      eq(lastScanWrites, 1, '5m בינתיים ריצה אחת');
      await new Promise(r => setTimeout(r, 400));
      eq(lastScanWrites, 2, '5n בסוף ההשהיה — ריצה נוספת אחת בדיוק');
    } finally {
      Setting.findOneAndUpdate = origFOU;
      svc._resetThrottle();
    }
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

    // 6k — a proposal touching two DIFFERENT confirmed groups merges them into one (the older survives).
    const sA = await Supplier.create({ name: 'ספק A', vat_rate: 1.18 });
    const sB = await Supplier.create({ name: 'ספק B', vat_rate: 1.18 });
    const sC = await Supplier.create({ name: 'ספק C', vat_rate: 1.18 });
    const sD = await Supplier.create({ name: 'ספק D', vat_rate: 1.18 });
    const pA = await mk(sA._id, 'A1', 'מוצר A', 'יחידה', 10);
    const pB = await mk(sB._id, 'B1', 'מוצר B', 'יחידה', 10);
    const pC = await mk(sC._id, 'C1', 'מוצר C', 'יחידה', 10);
    const pD = await mk(sD._id, 'D1', 'מוצר D', 'יחידה', 10);
    const grp1 = await svc.manualMatch([String(pA._id), String(pB._id)], 'אורי');
    await new Promise(r => setTimeout(r, 5)); // distinct created_at — grp1 is the older group
    const grp2 = await svc.manualMatch([String(pC._id), String(pD._id)], 'אורי');
    const mergeProposal = await ProductMatch.create({
      products: [{ product_id: pB._id, supplier_id: sB._id, pack_qty: 1 }, { product_id: pC._id, supplier_id: sC._id, pack_qty: 1 }],
      base_unit: 'יחידה', status: 'proposed', confidence: 0.9, pair_key: ProductMatch.pairKey(pB._id, pC._id),
    });
    const merged = await svc.confirmMatch(mergeProposal._id, { decided_by: 'אורי' });
    eq(String(merged._id), String(grp1._id), '6k1 המטרה היא הקבוצה הישנה יותר');
    eq(merged.products.length, 4, '6k2 ארבעה חברים בקבוצה החיה');
    const grp2After = await ProductMatch.findById(grp2._id).lean();
    eq(String(grp2After.merged_into), String(grp1._id), '6k3 הקבוצה השנייה נספגה');
    eq(grp2After.status, 'confirmed', '6k4 אבל נשארה confirmed');
    const liveWithC = await ProductMatch.countDocuments({ status: 'confirmed', merged_into: null, 'products.product_id': pC._id });
    eq(liveWithC, 1, '6k5 מוצר C מופיע בקבוצה חיה אחת בלבד');

    // 6l — a proposal that would add a second product of a supplier already in the group is refused; the group is untouched.
    const pA2 = await mk(sA._id, 'A2', 'מוצר A גרסה שנייה', 'יחידה', 12);
    const beforeSnapshot = await ProductMatch.findById(grp1._id).lean();
    const badProposal = await ProductMatch.create({
      products: [{ product_id: pA2._id, supplier_id: sA._id, pack_qty: 1 }, { product_id: pD._id, supplier_id: sD._id, pack_qty: 1 }],
      base_unit: 'יחידה', status: 'proposed', confidence: 0.9, pair_key: ProductMatch.pairKey(pA2._id, pD._id),
    });
    let threw = null;
    try { await svc.confirmMatch(badProposal._id, { decided_by: 'אורי' }); } catch (e) { threw = e; }
    eq(threw && threw.status, 400, '6l1 נדחה עם 400');
    const afterSnapshot = await ProductMatch.findById(grp1._id).lean();
    eq(afterSnapshot, beforeSnapshot, '6l2 הקבוצה לא השתנתה');

    // 6m — unlinking the target rejects everything that was absorbed into it.
    const unlinked = await svc.unlinkMatch(String(grp1._id), 'אורי');
    eq(unlinked.status, 'rejected', '6m1 הקבוצה עצמה נדחית');
    const grp2Final = await ProductMatch.findById(grp2._id).lean();
    eq(grp2Final.status, 'rejected', '6m2 הקבוצה שנספגה נדחית גם היא');
    const mergeProposalFinal = await ProductMatch.findById(mergeProposal._id).lean();
    eq(mergeProposalFinal.status, 'rejected', '6m3 וגם ההצעה שמוזגה');

    // 6n — confirming an already-merged proposal a second time is a no-op: returns the live group, decided_at untouched.
    const sE = await Supplier.create({ name: 'ספק E', vat_rate: 1.18 });
    const sF = await Supplier.create({ name: 'ספק F', vat_rate: 1.18 });
    const sG = await Supplier.create({ name: 'ספק G', vat_rate: 1.18 });
    const pE = await mk(sE._id, 'E1', 'מוצר E', 'יחידה', 10);
    const pF = await mk(sF._id, 'F1', 'מוצר F', 'יחידה', 10);
    const pG = await mk(sG._id, 'G1', 'מוצר G', 'יחידה', 10);
    const grp3 = await svc.manualMatch([String(pE._id), String(pF._id)], 'אורי');
    const mergeProposal2 = await ProductMatch.create({
      products: [{ product_id: pF._id, supplier_id: sF._id, pack_qty: 1 }, { product_id: pG._id, supplier_id: sG._id, pack_qty: 1 }],
      base_unit: 'יחידה', status: 'proposed', confidence: 0.9, pair_key: ProductMatch.pairKey(pF._id, pG._id),
    });
    const grp3Merged = await svc.confirmMatch(mergeProposal2._id, { decided_by: 'אורי' });
    eq(String(grp3Merged._id), String(grp3._id), '6n0 ההצעה הראשונה מוזגת לקבוצה הקיימת');
    const decidedAtBefore = (await ProductMatch.findById(mergeProposal2._id).lean()).decided_at;
    const again = await svc.confirmMatch(mergeProposal2._id, { decided_by: 'מישהו אחר' });
    eq(String(again._id), String(grp3._id), '6n1 אישור חוזר על הצעה שמוזגה מחזיר את הקבוצה החיה');
    const decidedAtAfter = (await ProductMatch.findById(mergeProposal2._id).lean()).decided_at;
    eq(new Date(decidedAtAfter).getTime(), new Date(decidedAtBefore).getTime(), '6n2 decided_at לא השתנה');
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

    svc._resetThrottle();
    const lastBefore = (await Setting.findOne({ key: svc.LAST_SCAN_KEY }).lean())?.value?.at;
    await new Promise(r => setTimeout(r, 5));
    const scan = await invoke(c.scan, {});
    eq([scan.status, scan.body], [202, { started: true }], '8j סריקה ידנית מתחילה ברקע — 202');
    const scanAgain = await invoke(c.scan, {});
    eq([scanAgain.status, scanAgain.body.error], [409, 'סריקה כבר רצה'], '8k שנייה מיד — 409');
    await new Promise(r => setTimeout(r, 300));
    const lastAfter = (await Setting.findOne({ key: svc.LAST_SCAN_KEY }).lean())?.value;
    ok(lastAfter && lastAfter.trigger === 'manual' && new Date(lastAfter.at) > new Date(lastBefore), '8k2 הריצה ברקע הסתיימה ונרשמה');
    eq(svc.startScan('manual').started, true, '8k3 אחרי שסיימה — אפשר שוב (בלי השהיה)');
    await new Promise(r => setTimeout(r, 200));

    // Import triggers a throttled scan (observed through the throttle state, not the network).
    svc._resetThrottle();
    const pc = require('../src/controllers/product.controller');
    const imp = await invoke(pc.bulkImport, { body: { supplier_id: String(dalas._id), products: [{ sku: '9', name: 'סבון ידיים 5 ליטר', unit: 'מיכל', price_before_vat: 30 }] } });
    eq(imp.status, 201, '8l ייבוא הצליח');
    const second = svc.throttledScan('test');
    eq(second, false, '8m הייבוא כבר הפעיל סריקה — השנייה נדחתה');
    await new Promise(r => setTimeout(r, 300));
  }

  // ---------------------------------------------------------------- 9 ------
  head('9 — קטלוג שלם: מקטעים של 40, סימון לכל מקטע, מקטע שנכשל לא עוצר את השאר');
  {
    svc._resetThrottle();
    await svc.runScan({ trigger: 'test', client: fakeClient([]) }); // everything that exists so far is marked
    eq(svc.CHUNK, 40, '9-0 גודל מקטע 40');
    const big = await Supplier.create({ name: 'ספק גדול', vat_rate: 1.18 });
    const bigProducts = [];
    for (let i = 1; i <= 90; i++) {
      const name = i === 5 ? 'סבון | נוזלי\nגדול\r\nמאוד' : `פריט ${i}`;
      bigProducts.push(await mk(big._id, `X${i}`, name, 'יחידה', 1 + i));
    }
    const proposeFirst = sku => req => { const k = keysBySku(req); return { matches: [
      { a_id: k[sku], b_id: k['1402'], confidence: 0.9, base_unit: 'יחידה', a_pack_qty: 1, b_pack_qty: 1, label: 'בדיקה', reason: 'מקטע' },
    ] }; };
    const client = fakeClient([proposeFirst('X1'), new Error('chunk-2-boom'), proposeFirst('X81')]);
    const before = await ProductMatch.countDocuments();
    const r = await svc.runScan({ trigger: 'test', client });
    eq(client.calls.length, 3, '9a 90 מוצרים = שלוש קריאות');
    const aRows = client.calls.map(c => (c.messages[0].content[1].text.match(/^A\d+ \|/gm) || []).length);
    eq(aRows, [40, 40, 10], '9b 40 + 40 + 10 שורות');
    eq([r.scanned, r.proposed, r.failed_chunks], [50, 2, 1], '9c מקטעים 1 ו-3 נסרקו והציעו, מקטע 2 נכשל');
    ok(/chunk-2-boom/.test(r.error || '') && /ספק גדול/.test(r.error || ''), '9d השגיאה מדווחת עם שם הספק');
    eq(await ProductMatch.countDocuments(), before + 2, '9e שתי הצעות במסד');
    const isMarked = async p => !!(await ProductScanMark.exists({ fingerprint: svc.fingerprintOf(p) }));
    eq([await isMarked(bigProducts[0]), await isMarked(bigProducts[40]), await isMarked(bigProducts[79]), await isMarked(bigProducts[80])],
      [true, false, false, true], '9f מקטעים 1 ו-3 סומנו, מקטע 2 לא');
    const markedBig = await ProductScanMark.countDocuments({ product_id: { $in: bigProducts.map(p => p._id) } });
    eq(markedBig, 50, '9g בדיוק 50 סימנים');
    const last = (await Setting.findOne({ key: svc.LAST_SCAN_KEY }).lean()).value;
    ok(/chunk-2-boom/.test(last.error) && last.failed_chunks === 1 && last.scanned === 50, '9h הסריקה האחרונה רושמת את הכשל');
    const row5 = client.calls[0].messages[0].content[1].text.split('\n').find(l => l.startsWith('A5 |'));
    eq(row5 && row5.split('|').length, 6, '9i שם עם | ושורה חדשה נשאר שורה אחת של שש עמודות');
    const othersBlocks = client.calls.map(c => c.messages[0].content[0].text);
    ok(othersBlocks[0] === othersBlocks[1] && othersBlocks[1] === othersBlocks[2], '9j רשימה ב זהה בכל המקטעים — נשמרת במטמון');

    // A cut-off answer: counts as a failed chunk, nothing of it is marked, the cost is still counted.
    const cut = fakeClient([{ __response: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"matches":[{"a_id":"A1","b_id":"B' }] } }]);
    const beforeCut = await ProductMatch.countDocuments();
    const r2 = await svc.runScan({ trigger: 'test', client: cut });
    eq([r2.scanned, r2.failed_chunks], [0, 1], '9k תשובה שנחתכה = מקטע שנכשל');
    ok(/התשובה נחתכה/.test(r2.error || ''), '9l עם "התשובה נחתכה"');
    eq(await ProductScanMark.countDocuments({ product_id: { $in: bigProducts.map(p => p._id) } }), 50, '9m ושום דבר ממנו לא סומן');
    eq(await ProductMatch.countDocuments(), beforeCut, '9n ולא נשמרה הצעה');
    ok(r2.cost_usd > 0, '9o העלות נספרה בכל זאת');

    // Not JSON, a refusal, no text: each a failed chunk.
    const bad = await svc.runScan({ trigger: 'test', client: fakeClient([{ __response: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'זו לא תשובת JSON בכלל' }] } }]) });
    ok(bad.failed_chunks === 1 && /זו לא תשובת JSON בכלל/.test(bad.error || ''), '9p JSON שבור = כשל, עם תחילת הטקסט');
    const refused = await svc.runScan({ trigger: 'test', client: fakeClient([{ __response: { stop_reason: 'refusal', content: [] } }]) });
    eq([refused.scanned, refused.failed_chunks], [0, 1], '9q סירוב = כשל');
    const empty = await svc.runScan({ trigger: 'test', client: fakeClient([{ __response: { stop_reason: 'end_turn', content: [] } }]) });
    eq([empty.scanned, empty.failed_chunks], [0, 1], '9r בלי טקסט = כשל');

    // The next good run picks up exactly the failed chunk.
    const good = await svc.runScan({ trigger: 'test', client: fakeClient([]) });
    eq([good.scanned, good.failed_chunks, good.error], [40, 0, null], '9s הריצה הבאה סורקת רק את המקטע שנכשל');
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
