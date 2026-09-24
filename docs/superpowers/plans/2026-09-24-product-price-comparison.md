# Product Price Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When ordering from one supplier, show what the same product costs at the other supplier — per real unit — for matches an admin has confirmed; matches are proposed by Claude and remembered so nothing is asked twice.

**Architecture:** Two new Mongoose models (`ProductMatch` = a group of equivalent products across suppliers with a status, `ProductScanMark` = which product fingerprints were already scanned). One service (`productMatch.service.js`) owns fingerprints, the Claude call (client injectable for tests), the throttle, decisions and the per-unit comparison. A small controller + routes under `/api/products/matches`, an admin review screen, and one caption line in the order form.

**Tech Stack:** Node/Express/Mongoose, `@anthropic-ai/sdk` (already a server dependency, see `server/src/services/form101Scan.js`), `aiCost.js` ledger, React + MUI client. Tests: plain `node scripts/*.test.js` with `mongodb-memory-server`.

**Spec:** `docs/superpowers/specs/2026-09-24-product-price-comparison-design.md` (Hebrew — read it first).

## Global Constraints

- Repo root `~/dev/gan-halomot`. Server tests run from `server/`. Client build `cd client && npm run build`. Hex ratchet `node scripts/design-hex-budget.test.js | tail -1` must not report a number higher than before your change (main reads "עלה ב-8" today). No hex colour literals in client code — MUI `color` props / theme tokens only.
- Model id: `process.env.PRODUCT_MATCH_MODEL || 'claude-sonnet-5'`. The API key is `ANTHROPIC_API_KEY`; without it the scan exits quietly with a Hebrew message, never throws to the caller.
- Proposal threshold: `confidence >= 0.6`. Throttle: at most one scan per 10 minutes (`SCAN_COOLDOWN_MS = 10 * 60 * 1000`). Never scan at server boot.
- Fingerprint = sha256 of `${supplier_id}|${sku}|${name}|${unit}`; a price change does NOT change it.
- A pair is remembered by `pair_key` = the two product ids sorted and joined with `:`; a `rejected` pair is never proposed again.
- Only `system_admin` may review/scan/decide; every ordering role may read confirmed comparisons.
- Hebrew user-facing strings. Commit messages English, conventional prefix, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Do NOT push.
- Tests must stub `dotenv` out of `require.cache` before any `src/` require (copy from `scripts/supplier-catalogue.test.js` lines 26-30) and must never call the real Anthropic API — the service takes an injected client.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/models/ProductMatch.js` (new) | a group of equivalent products; status proposed/confirmed/rejected; `pair_key` memory |
| `server/src/models/ProductScanMark.js` (new) | fingerprints already sent to the model |
| `server/src/models/index.js` | register both |
| `server/src/services/productMatch.service.js` (new) | `fingerprintOf`, `runScan`, `throttledScan`, `comparisonFor`, `confirmMatch`, `rejectMatch`, `unlinkMatch`, `manualMatch` |
| `server/src/controllers/productMatch.controller.js` (new) | HTTP handlers for `/products/matches*` |
| `server/src/routes/product.routes.js` | mount the match routes BEFORE `/:id/image` |
| `server/src/controllers/product.controller.js` | trigger `throttledScan('import')` after `create` and `bulkImport` |
| `server/scripts/product-match.test.js` (new) | the spec's 8 tests |
| `server/package.json` | `test:product-match` |
| `client/src/components/orders/ProductMatches.jsx` (new) | admin review screen |
| `client/src/App.jsx`, `client/src/config/tabs.js` | route + nav entry |
| `client/src/components/orders/OrderForm.jsx` | the comparison caption under each product |

---

### Task 1: Models, fingerprint, test harness

**Files:**
- Create: `server/src/models/ProductMatch.js`, `server/src/models/ProductScanMark.js`
- Modify: `server/src/models/index.js` (after `ScannedAttachment` at lines 94 and 197)
- Create: `server/src/services/productMatch.service.js` (only `fingerprintOf` for now)
- Create: `server/scripts/product-match.test.js`
- Modify: `server/package.json`

**Interfaces:**
- Produces: `ProductMatch` schema `{ products: [{ product_id, supplier_id, pack_qty: Number|null }], base_unit: String, label: String, status: 'proposed'|'confirmed'|'rejected', confidence: Number, reason: String, proposed_by: 'ai'|'user', decided_by: String, decided_at: Date|null, pair_key: String (unique, sparse), merged_into: ObjectId|null }` with timestamps `created_at/updated_at`.
- Produces: `ProductScanMark` `{ fingerprint: String unique, product_id, scanned_at }`.
- Produces: `fingerprintOf(product) → string` (64 hex chars).

- [ ] **Step 1: Write the harness with section 1**

Create `server/scripts/product-match.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node scripts/product-match.test.js`
Expected: crash — `ProductMatch` undefined / module `productMatch.service` not found.

- [ ] **Step 3: Write the models**

`server/src/models/ProductMatch.js`:

```js
const mongoose = require('mongoose');

/**
 * One thing, sold by several suppliers.
 *
 * A group holds one product per supplier and what a unit of sale contains
 * (`pack_qty` — 400 wipes in DALAS's carton, 80 in שאבי's pack) so the two
 * prices can be compared per wipe, not per box. Claude proposes pairs; an
 * admin confirms or rejects them; the order form reads only `confirmed`.
 *
 * `pair_key` is the memory. It is the two product ids sorted and joined, and
 * it is unique: a pair that was proposed once — and above all a pair that was
 * REJECTED — is never proposed again, however many scans run. A confirmed pair
 * whose product is already in a confirmed group is merged into that group and
 * kept here with `merged_into` set, so its key keeps guarding.
 */
const memberSchema = new mongoose.Schema({
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  supplier_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  /** Base units per unit of sale. null = unknown, compare per pack only. */
  pack_qty: { type: Number, default: null },
}, { _id: false });

const productMatchSchema = new mongoose.Schema({
  products: { type: [memberSchema], default: [] },
  base_unit: { type: String, default: '' },
  label: { type: String, default: '' },
  status: { type: String, enum: ['proposed', 'confirmed', 'rejected'], default: 'proposed', index: true },
  confidence: { type: Number, default: 0 },
  reason: { type: String, default: '' },
  proposed_by: { type: String, enum: ['ai', 'user'], default: 'ai' },
  decided_by: { type: String, default: '' },
  decided_at: { type: Date, default: null },
  pair_key: { type: String, default: null, unique: true, sparse: true },
  merged_into: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductMatch', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

productMatchSchema.index({ 'products.product_id': 1 });

/** The two ids sorted, so A:B and B:A are the same pair. */
productMatchSchema.statics.pairKey = function pairKey(a, b) {
  return [String(a), String(b)].sort().join(':');
};

module.exports = mongoose.model('ProductMatch', productMatchSchema);
```

`server/src/models/ProductScanMark.js`:

```js
const mongoose = require('mongoose');

/**
 * Which products the matcher has already looked at.
 *
 * The fingerprint is supplier + sku + name + unit — the things that decide
 * whether two products are the same. A price change is not a reason to ask
 * the model again; a renamed product is. A product with a mark is never sent
 * as "new" again, which is what keeps every catalogue import from re-reading
 * the whole world.
 */
const productScanMarkSchema = new mongoose.Schema({
  fingerprint: { type: String, required: true, unique: true, index: true },
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  scanned_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('ProductScanMark', productScanMarkSchema);
```

In `server/src/models/index.js`, after line 94 (`const ScannedAttachment = require('./ScannedAttachment');`) add:
```js
const ProductMatch = require('./ProductMatch');
const ProductScanMark = require('./ProductScanMark');
```
and in the exports object after `ScannedAttachment,` add `ProductMatch, ProductScanMark,`.

- [ ] **Step 4: Write `fingerprintOf` in the service skeleton**

Create `server/src/services/productMatch.service.js`:

```js
/**
 * The same product at the other supplier.
 *
 * See docs/superpowers/specs/2026-09-24-product-price-comparison-design.md.
 * This file owns: the fingerprint that says "already looked at", the call to
 * Claude (client injectable so tests never touch the network), the throttle,
 * the admin's decisions, and the per-unit comparison the order form shows.
 */
const crypto = require('crypto');

/** supplier + sku + name + unit. Not the price: a price change is not a new product. */
function fingerprintOf(p) {
  const s = [p.supplier_id, p.sku || '', p.name || '', p.unit || ''].map(String).join('|');
  return crypto.createHash('sha256').update(s).digest('hex');
}

module.exports = { fingerprintOf };
```

- [ ] **Step 5: Run the test, register the npm script, commit**

Run: `cd server && node scripts/product-match.test.js` → `🎉 6/6 עברו`.

In `server/package.json` next to `"test:order-group"` add `"test:product-match": "node scripts/product-match.test.js",`.

```bash
cd ~/dev/gan-halomot
git add server/src/models/ProductMatch.js server/src/models/ProductScanMark.js server/src/models/index.js server/src/services/productMatch.service.js server/scripts/product-match.test.js server/package.json
git commit -m "feat(products): a match between suppliers' products, and the memory of what was scanned

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The scan — Claude proposes pairs, memory and throttle

**Files:**
- Modify: `server/src/services/productMatch.service.js`
- Test: `server/scripts/product-match.test.js` (sections 2, 3, 4, 5)

**Interfaces:**
- Consumes: `fingerprintOf`, models.
- Produces: `runScan({ trigger, client, now }) → Promise<{ scanned: number, proposed: number, skipped: string|null, cost_usd: number }>`; `throttledScan(trigger, { client, now })` (fire-and-forget, returns `true` if a scan was started, `false` if throttled); `MODEL`, `SCAN_COOLDOWN_MS`, `MIN_CONFIDENCE`, `LAST_SCAN_KEY = 'product_match_last_scan'`, `_resetThrottle()` for tests.

- [ ] **Step 1: Append the failing tests**

Replace `// __TASKS_APPEND_HERE__` with:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node scripts/product-match.test.js`
Expected: section 2 fails — `svc.runScan is not a function`.

- [ ] **Step 3: Implement the scan**

Replace the whole of `server/src/services/productMatch.service.js` with:

```js
/**
 * The same product at the other supplier.
 *
 * See docs/superpowers/specs/2026-09-24-product-price-comparison-design.md.
 * This file owns: the fingerprint that says "already looked at", the call to
 * Claude (client injectable so tests never touch the network), the throttle,
 * the admin's decisions, and the per-unit comparison the order form shows.
 */
const crypto = require('crypto');
const { Product, Supplier, ProductMatch, ProductScanMark, Setting } = require('../models');
const { newLedger } = require('./aiCost');

const MODEL = process.env.PRODUCT_MATCH_MODEL || 'claude-sonnet-5';
const MIN_CONFIDENCE = 0.6;
const SCAN_COOLDOWN_MS = 10 * 60 * 1000;
const LAST_SCAN_KEY = 'product_match_last_scan';

/** supplier + sku + name + unit. Not the price: a price change is not a new product. */
function fingerprintOf(p) {
  const s = [p.supplier_id, p.sku || '', p.name || '', p.unit || ''].map(String).join('|');
  return crypto.createHash('sha256').update(s).digest('hex');
}

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  return client;
}

const SYSTEM = `אתה מתאים מוצרים בין קטלוגים של ספקים לגן ילדים בישראל.
מוצר "זהה" = אותו דבר לשימוש (למשל מגבונים לחים, שמן קנולה, מגבת נייר), גם אם המותג שונה וגם אם האריזה שונה.
לא זהה: סוג שונה (מגבונים לחים מול מגבוני רצפה), גודל תכולה שונה מהותית (שמן 1 ליטר מול 5 ליטר הם אותו מוצר — ציין כמות; ממרח תמרים מול ממרח שוקולד לא).
לכל זוג קבע יחידת בסיס (מגבון, ק"ג, ליטר, יחידה, גליל, מטר) וכמה יחידות בסיס יש באריזת המכירה של כל צד, לפי השם. אם לא ניתן לדעת — null.
החזר רק זוגות שבהם אתה בטוח לפחות במידה סבירה; confidence בין 0 ל-1.`;

const SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          a_id: { type: 'string' },
          b_id: { type: 'string' },
          confidence: { type: 'number' },
          base_unit: { type: 'string' },
          a_pack_qty: { type: ['number', 'null'] },
          b_pack_qty: { type: ['number', 'null'] },
          label: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['a_id', 'b_id', 'confidence', 'base_unit', 'a_pack_qty', 'b_pack_qty', 'label', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['matches'],
  additionalProperties: false,
};

function line(p, supplierName) {
  return `${p._id} | ${supplierName} | ${p.sku || '-'} | ${p.name} | ${p.unit || '-'} | ${p.price_with_vat} ₪`;
}

/**
 * Ask the model which of `fresh` (all from one supplier) match any of `others`.
 * Returns the parsed `matches` array (may be empty).
 */
async function proposeFor({ fresh, others, supplierNames, apiClient, ledger }) {
  const text = [
    `רשימה א — מוצרים חדשים של הספק "${supplierNames.get(String(fresh[0].supplier_id))}":`,
    'id | ספק | מק"ט | שם | יחידת מכירה | מחיר',
    ...fresh.map(p => line(p, supplierNames.get(String(p.supplier_id)))),
    '',
    'רשימה ב — כל המוצרים של הספקים האחרים:',
    'id | ספק | מק"ט | שם | יחידת מכירה | מחיר',
    ...others.map(p => line(p, supplierNames.get(String(p.supplier_id)))),
    '',
    'החזר את הזוגות (a_id מרשימה א, b_id מרשימה ב) שהם אותו מוצר.',
  ].join('\n');

  const response = await apiClient.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  });
  ledger.add(MODEL, response.usage);
  if (response.stop_reason === 'refusal') return [];
  const textBlock = (response.content || []).find(b => b.type === 'text');
  if (!textBlock?.text) return [];
  let parsed;
  try { parsed = JSON.parse(textBlock.text); } catch { return []; }
  return Array.isArray(parsed?.matches) ? parsed.matches : [];
}

async function writeLastScan(value) {
  await Setting.findOneAndUpdate({ key: LAST_SCAN_KEY }, { $set: { value } }, { upsert: true });
}

/**
 * One scan: every product without a mark, against every product of the other
 * suppliers. Proposals are written only above MIN_CONFIDENCE and only for a
 * pair never seen before. Marks are written only when the model answered —
 * a failed call leaves the products "new" for the next trigger.
 */
async function runScan({ trigger = 'manual', client: injected = null, now = Date.now() } = {}) {
  const apiClient = injected || getClient();
  if (!apiClient) {
    const value = { at: new Date(now), trigger, scanned: 0, proposed: 0, cost_usd: 0, error: 'סריקת התאמות אינה מוגדרת (חסר ANTHROPIC_API_KEY)' };
    await writeLastScan(value);
    return { scanned: 0, proposed: 0, cost_usd: 0, skipped: value.error, error: null };
  }

  const products = await Product.find({ is_active: true }).select('supplier_id sku name unit price_with_vat').lean();
  const suppliers = await Supplier.find({ _id: { $in: [...new Set(products.map(p => String(p.supplier_id)))] } }).select('name').lean();
  const supplierNames = new Map(suppliers.map(s => [String(s._id), s.name]));

  const fps = new Map(products.map(p => [String(p._id), fingerprintOf(p)]));
  const marked = new Set((await ProductScanMark.find({ fingerprint: { $in: [...fps.values()] } }).select('fingerprint').lean()).map(m => m.fingerprint));
  const fresh = products.filter(p => !marked.has(fps.get(String(p._id))));
  if (!fresh.length) {
    await writeLastScan({ at: new Date(now), trigger, scanned: 0, proposed: 0, cost_usd: 0, error: '' });
    return { scanned: 0, proposed: 0, cost_usd: 0, skipped: null, error: null };
  }

  const ledger = newLedger();
  const bySupplier = new Map();
  fresh.forEach(p => {
    const k = String(p.supplier_id);
    if (!bySupplier.has(k)) bySupplier.set(k, []);
    bySupplier.get(k).push(p);
  });

  let proposed = 0;
  const scannedIds = [];
  try {
    for (const [supplierId, freshOfSupplier] of bySupplier) {
      const others = products.filter(p => String(p.supplier_id) !== supplierId);
      const matches = others.length
        ? await proposeFor({ fresh: freshOfSupplier, others, supplierNames, apiClient, ledger })
        : [];
      const byId = new Map(products.map(p => [String(p._id), p]));
      for (const m of matches) {
        if (!(Number(m.confidence) >= MIN_CONFIDENCE)) continue;
        const a = byId.get(String(m.a_id));
        const b = byId.get(String(m.b_id));
        if (!a || !b || String(a.supplier_id) === String(b.supplier_id)) continue;
        const pair_key = ProductMatch.pairKey(a._id, b._id);
        if (await ProductMatch.exists({ pair_key })) continue;
        try {
          await ProductMatch.create({
            products: [
              { product_id: a._id, supplier_id: a.supplier_id, pack_qty: m.a_pack_qty ?? null },
              { product_id: b._id, supplier_id: b.supplier_id, pack_qty: m.b_pack_qty ?? null },
            ],
            base_unit: m.base_unit || '', label: m.label || '', status: 'proposed',
            confidence: Number(m.confidence) || 0, reason: m.reason || '', proposed_by: 'ai', pair_key,
          });
          proposed++;
        } catch (e) {
          if (e.code !== 11000) throw e; // a concurrent scan wrote the same pair — fine
        }
      }
      scannedIds.push(...freshOfSupplier.map(p => p._id));
    }
  } catch (err) {
    console.error('[product-match] scan failed:', err.message);
    await writeLastScan({ at: new Date(now), trigger, scanned: scannedIds.length, proposed, cost_usd: ledger.total, error: err.message });
    return { scanned: 0, proposed, cost_usd: ledger.total, skipped: null, error: err.message };
  }

  if (scannedIds.length) {
    const marks = scannedIds.map(id => ({ updateOne: {
      filter: { fingerprint: fps.get(String(id)) },
      update: { $set: { fingerprint: fps.get(String(id)), product_id: id, scanned_at: new Date(now) } },
      upsert: true,
    } }));
    await ProductScanMark.bulkWrite(marks);
  }
  await writeLastScan({ at: new Date(now), trigger, scanned: scannedIds.length, proposed, cost_usd: ledger.total, error: '' });
  console.log(`[product-match] ${trigger}: scanned ${scannedIds.length}, proposed ${proposed}, $${ledger.total.toFixed(4)}`);
  return { scanned: scannedIds.length, proposed, cost_usd: ledger.total, skipped: null, error: null };
}

let lastStartedAt = 0;
let running = false;
/**
 * Fire-and-forget with a cooldown. A catalogue import calls this; ten imports
 * in a minute are one scan. Never called at boot.
 */
function throttledScan(trigger = 'import', { client: injected = null, now = Date.now() } = {}) {
  if (running || now - lastStartedAt < SCAN_COOLDOWN_MS) return false;
  lastStartedAt = now;
  running = true;
  setImmediate(() => {
    runScan({ trigger, client: injected, now })
      .catch(err => console.error('[product-match] background scan failed:', err.message))
      .finally(() => { running = false; });
  });
  return true;
}
function _resetThrottle() { lastStartedAt = 0; running = false; }

module.exports = {
  fingerprintOf, runScan, throttledScan, _resetThrottle,
  MODEL, MIN_CONFIDENCE, SCAN_COOLDOWN_MS, LAST_SCAN_KEY,
};
```

- [ ] **Step 4: Run the tests**

Run: `cd server && node scripts/product-match.test.js` → all of 1–5 pass. Check `aiCost.js` `PRICES` has an entry for `claude-sonnet-5`; if not, add one next to the existing rows using Anthropic's published rate for that model (the `FALLBACK` tier prices unknown models at the most expensive tier, which still satisfies `2k`).

- [ ] **Step 5: Commit**

```bash
cd ~/dev/gan-halomot
git add server/src/services/productMatch.service.js server/scripts/product-match.test.js server/src/services/aiCost.js
git commit -m "feat(products): Claude proposes the same product across suppliers, and remembers what it was asked

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Decisions and the comparison

**Files:**
- Modify: `server/src/services/productMatch.service.js`
- Test: `server/scripts/product-match.test.js` (sections 6, 7)

**Interfaces:**
- Produces: `confirmMatch(id, { pack_qty: {[productId]: number|null}, base_unit, decided_by }) → group doc` (merges into an existing confirmed group when a side already belongs to one); `rejectMatch(id, decided_by)`; `unlinkMatch(id, decided_by)` (`confirmed → rejected`); `manualMatch(productIds, decided_by) → confirmed group`; `comparisonFor(supplierId) → { [productId]: [{ match_id, supplier_name, product_id, product_name, unit, price_with_vat, pack_qty, per_unit_price, my_pack_qty, my_per_unit_price, base_unit, diff_pct }] }`.

- [ ] **Step 1: Append the failing tests**

Replace `// __TASKS_APPEND_HERE__` with:

```js
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

  // __TASKS_APPEND_HERE__
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node scripts/product-match.test.js` → section 6 fails: `svc.confirmMatch is not a function`.

- [ ] **Step 3: Implement decisions and comparison**

Append to `server/src/services/productMatch.service.js` (before `module.exports`) and extend the exports:

```js
function notFound() { const e = new Error('התאמה לא נמצאה'); e.status = 404; return e; }

/** The confirmed, un-merged group holding this product, if any. */
async function confirmedGroupOf(productId) {
  return ProductMatch.findOne({ status: 'confirmed', merged_into: null, 'products.product_id': productId });
}

/**
 * proposed → confirmed. If one side already sits in a confirmed group, the
 * other side joins that group and the proposal is kept with `merged_into`
 * (its pair_key keeps the pair from being proposed again).
 */
async function confirmMatch(id, { pack_qty = {}, base_unit, decided_by = '' } = {}) {
  const m = await ProductMatch.findById(id);
  if (!m) throw notFound();
  if (m.status === 'confirmed' && !m.merged_into) return m;
  const now = new Date();
  for (const p of m.products) {
    const v = pack_qty[String(p.product_id)];
    if (v !== undefined) p.pack_qty = v === null || v === '' ? null : Number(v);
  }
  if (base_unit !== undefined) m.base_unit = base_unit;

  let target = null;
  for (const p of m.products) {
    target = await confirmedGroupOf(p.product_id);
    if (target) break;
  }
  if (target && String(target._id) !== String(m._id)) {
    for (const p of m.products) {
      const existing = target.products.find(t => String(t.product_id) === String(p.product_id));
      if (existing) { if (p.pack_qty !== null) existing.pack_qty = p.pack_qty; }
      else target.products.push({ product_id: p.product_id, supplier_id: p.supplier_id, pack_qty: p.pack_qty });
    }
    if (m.base_unit && !target.base_unit) target.base_unit = m.base_unit;
    target.decided_by = decided_by; target.decided_at = now;
    await target.save();
    m.status = 'confirmed'; m.merged_into = target._id; m.decided_by = decided_by; m.decided_at = now;
    await m.save();
    return target;
  }
  m.status = 'confirmed'; m.decided_by = decided_by; m.decided_at = now;
  await m.save();
  return m;
}

async function rejectMatch(id, decided_by = '') {
  const m = await ProductMatch.findById(id);
  if (!m) throw notFound();
  m.status = 'rejected'; m.decided_by = decided_by; m.decided_at = new Date();
  await m.save();
  return m;
}

/** confirmed → rejected. The pair is remembered and never proposed again. */
async function unlinkMatch(id, decided_by = '') {
  return rejectMatch(id, decided_by);
}

/** Two (or more) products the admin says are the same. Confirmed at once. */
async function manualMatch(productIds, decided_by = '') {
  const ids = [...new Set((productIds || []).map(String))];
  if (ids.length < 2) { const e = new Error('נדרשים לפחות שני מוצרים'); e.status = 400; throw e; }
  const products = await Product.find({ _id: { $in: ids } }).select('supplier_id').lean();
  if (products.length !== ids.length) { const e = new Error('מוצר לא נמצא'); e.status = 404; throw e; }
  const suppliers = new Set(products.map(p => String(p.supplier_id)));
  if (suppliers.size !== products.length) { const e = new Error('התאמה היא בין ספקים שונים — מוצר אחד לכל ספק'); e.status = 400; throw e; }
  const pair_key = ids.length === 2 ? ProductMatch.pairKey(ids[0], ids[1]) : null;
  const existing = pair_key ? await ProductMatch.findOne({ pair_key }) : null;
  if (existing) {
    existing.status = 'confirmed'; existing.merged_into = null; existing.proposed_by = 'user';
    existing.decided_by = decided_by; existing.decided_at = new Date();
    await existing.save();
    return existing;
  }
  return ProductMatch.create({
    products: products.map(p => ({ product_id: p._id, supplier_id: p.supplier_id, pack_qty: null })),
    status: 'confirmed', proposed_by: 'user', confidence: 1, decided_by, decided_at: new Date(), pair_key,
  });
}

function perUnit(price, packQty) {
  if (!packQty || packQty <= 0) return null;
  return Number((price / packQty).toFixed(4));
}

/**
 * For every product of `supplierId` in a confirmed group: the other members
 * with their prices — per pack, and per base unit when both packs are known.
 * diff_pct > 0 means the OTHER supplier is dearer per unit.
 */
async function comparisonFor(supplierId) {
  const groups = await ProductMatch.find({ status: 'confirmed', merged_into: null, 'products.supplier_id': supplierId }).lean();
  if (!groups.length) return {};
  const productIds = [...new Set(groups.flatMap(g => g.products.map(p => String(p.product_id))))];
  const products = await Product.find({ _id: { $in: productIds }, is_active: true }).select('supplier_id name unit price_with_vat').lean();
  const byId = new Map(products.map(p => [String(p._id), p]));
  const supplierIds = [...new Set(products.map(p => String(p.supplier_id)))];
  const suppliers = await Supplier.find({ _id: { $in: supplierIds } }).select('name').lean();
  const supplierName = new Map(suppliers.map(s => [String(s._id), s.name]));

  const out = {};
  for (const g of groups) {
    const mine = g.products.filter(p => String(p.supplier_id) === String(supplierId));
    const others = g.products.filter(p => String(p.supplier_id) !== String(supplierId));
    for (const me of mine) {
      const myProduct = byId.get(String(me.product_id));
      if (!myProduct) continue;
      const myPer = perUnit(myProduct.price_with_vat, me.pack_qty);
      const rows = [];
      for (const o of others) {
        const op = byId.get(String(o.product_id));
        if (!op) continue;
        const per = perUnit(op.price_with_vat, o.pack_qty);
        rows.push({
          match_id: g._id, supplier_name: supplierName.get(String(o.supplier_id)) || '',
          product_id: op._id, product_name: op.name, unit: op.unit || '',
          price_with_vat: op.price_with_vat, pack_qty: o.pack_qty, per_unit_price: per,
          my_pack_qty: me.pack_qty, my_per_unit_price: myPer, base_unit: g.base_unit || '',
          diff_pct: per !== null && myPer ? Math.round((per / myPer - 1) * 100) : null,
        });
      }
      if (rows.length) out[String(me.product_id)] = rows;
    }
  }
  return out;
}
```

Extend `module.exports` to include `confirmMatch, rejectMatch, unlinkMatch, manualMatch, comparisonFor`.

- [ ] **Step 4: Run the tests**

Run: `cd server && node scripts/product-match.test.js` → sections 1–7 pass.

- [ ] **Step 5: Commit**

```bash
cd ~/dev/gan-halomot
git add server/src/services/productMatch.service.js server/scripts/product-match.test.js
git commit -m "feat(products): an admin confirms or rejects a match, and the price per real unit is computed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Controller, routes, import trigger

**Files:**
- Create: `server/src/controllers/productMatch.controller.js`
- Modify: `server/src/routes/product.routes.js`
- Modify: `server/src/controllers/product.controller.js` (end of `create` and `bulkImport`)
- Test: `server/scripts/product-match.test.js` (section 8)

**Interfaces:**
- Produces routes (all under `/api/products`): `GET /matches?supplier=` (any authenticated; confirmed comparisons map), `GET /matches/review` (system_admin), `POST /matches/scan` (system_admin), `POST /matches` `{ product_ids }` (system_admin), `POST /matches/:id/confirm` `{ pack_qty, base_unit }`, `POST /matches/:id/reject`, `POST /matches/:id/unlink` (system_admin).

- [ ] **Step 1: Append the failing test**

Replace `// __TASKS_APPEND_HERE__` with:

```js
  // ---------------------------------------------------------------- 8 ------
  head('8 — נתיבים: מאושרות לכולם, סקירה וסריקה למנהל מערכת בלבד');
  {
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
    const imp = await invoke(pc.create, { body: { supplier_id: String(dalas._id), products: [{ sku: '9', name: 'סבון ידיים 5 ליטר', unit: 'מיכל', price_before_vat: 30 }] } });
    eq(imp.status, 201, '8l ייבוא הצליח');
    const second = svc.throttledScan('test');
    eq(second, false, '8m הייבוא כבר הפעיל סריקה — השנייה נדחתה');
    await new Promise(r => setTimeout(r, 300));
  }

  // __TASKS_APPEND_HERE__
```

Note on `8j`/`8l`: the controller's `scan` and the import trigger run the REAL `runScan` with the real client factory, which will try the network because `ANTHROPIC_API_KEY` is set in the harness. Before section 8, stub the SDK out of `require.cache` so `new Anthropic()` returns the fake:

```js
  // Put this at the top of section 8, before requiring the controller:
  {
    const sdkPath = require.resolve('@anthropic-ai/sdk');
    const fake = fakeClient([{ matches: [] }, { matches: [] }, { matches: [] }]);
    require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, children: [], paths: [], exports: function Anthropic() { return fake; } };
  }
```
`getClient()` in the service requires the SDK lazily and caches the instance in a module variable; because sections 2–7 always injected a client, the cached `client` is still `null` and the stub is what gets constructed.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node scripts/product-match.test.js` → section 8 fails: cannot find module `productMatch.controller`.

- [ ] **Step 3: Write the controller**

Create `server/src/controllers/productMatch.controller.js`:

```js
const { ProductMatch, Product, Setting } = require('../models');
const svc = require('../services/productMatch.service');

function send(res, err) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  throw err;
}

/** GET /products/matches?supplier= — confirmed comparisons for the order form. */
async function matches(req, res, next) {
  try {
    const { supplier } = req.query;
    if (!supplier) return res.status(400).json({ error: 'supplier is required' });
    res.json({ matches: await svc.comparisonFor(String(supplier)) });
  } catch (error) { next(error); }
}

async function withProducts(groups) {
  const ids = [...new Set(groups.flatMap(g => g.products.map(p => String(p.product_id))))];
  const products = await Product.find({ _id: { $in: ids } }).select('+image_data').lean();
  const byId = new Map(products.map(p => [String(p._id), p]));
  const supplierIds = [...new Set(products.map(p => String(p.supplier_id)))];
  const { Supplier } = require('../models');
  const suppliers = await Supplier.find({ _id: { $in: supplierIds } }).select('name').lean();
  const sName = new Map(suppliers.map(s => [String(s._id), s.name]));
  return groups.map(g => ({
    ...g, id: g._id,
    products: g.products.map(m => {
      const p = byId.get(String(m.product_id)) || {};
      const { image_data, ...rest } = p;
      return { ...rest, id: p._id, has_image: !!image_data, supplier_name: sName.get(String(m.supplier_id)) || '', pack_qty: m.pack_qty };
    }),
  }));
}

/** GET /products/matches/review — proposed + confirmed with full products, and the last scan. */
async function review(req, res, next) {
  try {
    const [proposed, confirmed, last] = await Promise.all([
      ProductMatch.find({ status: 'proposed' }).sort({ confidence: -1 }).lean(),
      ProductMatch.find({ status: 'confirmed', merged_into: null }).sort({ updated_at: -1 }).lean(),
      Setting.findOne({ key: svc.LAST_SCAN_KEY }).lean(),
    ]);
    res.json({ proposed: await withProducts(proposed), confirmed: await withProducts(confirmed), last_scan: last?.value || null });
  } catch (error) { next(error); }
}

/** POST /products/matches/scan — run now, ignoring the cooldown. */
async function scan(req, res, next) {
  try {
    const r = await svc.runScan({ trigger: 'manual' });
    if (r.skipped) return res.status(400).json({ error: r.skipped, ...r });
    if (r.error) return res.status(502).json({ error: `הסריקה נכשלה: ${r.error}`, ...r });
    res.json(r);
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  try {
    const g = await svc.manualMatch(req.body.product_ids, req.user?.full_name || '');
    res.status(201).json({ match: { ...g.toObject(), id: g._id } });
  } catch (error) { try { send(res, error); } catch (e) { next(e); } }
}

async function confirm(req, res, next) {
  try {
    const g = await svc.confirmMatch(req.params.id, { pack_qty: req.body.pack_qty || {}, base_unit: req.body.base_unit, decided_by: req.user?.full_name || '' });
    res.json({ match: { ...g.toObject(), id: g._id } });
  } catch (error) { try { send(res, error); } catch (e) { next(e); } }
}

async function reject(req, res, next) {
  try {
    const g = await svc.rejectMatch(req.params.id, req.user?.full_name || '');
    res.json({ match: { ...g.toObject(), id: g._id } });
  } catch (error) { try { send(res, error); } catch (e) { next(e); } }
}

async function unlink(req, res, next) {
  try {
    const g = await svc.unlinkMatch(req.params.id, req.user?.full_name || '');
    res.json({ match: { ...g.toObject(), id: g._id } });
  } catch (error) { try { send(res, error); } catch (e) { next(e); } }
}

module.exports = { matches, review, scan, create, confirm, reject, unlink };
```

In `server/src/routes/product.routes.js`, replace the file body with:

```js
const express = require('express');
const router = express.Router();
const c = require('../controllers/product.controller');
const m = require('../controllers/productMatch.controller');
const { requireRole } = require('../middleware/auth');

const adminOnly = requireRole('system_admin');

router.get('/', c.getAll);

// The same product at another supplier. Before /:id so "matches" is never
// read as a product id. Confirmed comparisons are for whoever orders; the
// review, the scan and every decision are the system admin's.
router.get('/matches', m.matches);
router.get('/matches/review', adminOnly, m.review);
router.post('/matches/scan', adminOnly, m.scan);
router.post('/matches', adminOnly, m.create);
router.post('/matches/:id/confirm', adminOnly, m.confirm);
router.post('/matches/:id/reject', adminOnly, m.reject);
router.post('/matches/:id/unlink', adminOnly, m.unlink);

// The stored picture, as bytes. Before /:id so it is not read as an id.
router.get('/:id/image', c.image);
router.post('/', c.create);
router.post('/import', c.bulkImport);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;
```

In `server/src/controllers/product.controller.js`: in `create`, right before `res.status(201).json({` (the one that reports `count/updated`), and in `bulkImport` right before its final `res.status(201).json(...)`, add:

```js
    // A new price list is the moment to ask which of its lines exist at the
    // other suppliers. Background, throttled, never awaited.
    require('../services/productMatch.service').throttledScan('import');
```

- [ ] **Step 4: Run the tests**

Run: `cd server && node scripts/product-match.test.js` → all sections pass. Also `node scripts/supplier-catalogue.test.js` (it calls `create`/`bulkImport` — the throttled scan starts in the background there; with no `ANTHROPIC_API_KEY` in that harness it exits quietly. If the process now lingers because of the background promise, ensure `runScan` has no open handles — it does not; `setImmediate` resolves within the run).

- [ ] **Step 5: Commit**

```bash
cd ~/dev/gan-halomot
git add server/src/controllers/productMatch.controller.js server/src/routes/product.routes.js server/src/controllers/product.controller.js server/scripts/product-match.test.js
git commit -m "feat(products): match routes — comparisons for whoever orders, review and scan for the admin, a scan after every import

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Admin review screen

**Files:**
- Create: `client/src/components/orders/ProductMatches.jsx`
- Modify: `client/src/App.jsx` (lazy import near line 112, route near line 248)
- Modify: `client/src/config/tabs.js` (after the `suppliers` item, line 150)

**Interfaces:**
- Consumes: `GET /products/matches/review`, `POST /products/matches/scan`, `POST /products/matches/:id/confirm { pack_qty: {productId: n|null}, base_unit }`, `/reject`, `/unlink`, `POST /products/matches { product_ids }`; `GET /products?supplier=` for the manual-match picker; `ProductThumb` (`client/src/components/orders/ProductThumb.jsx`, props `{ product, size, radius }`); `formatCurrencyExact`.

- [ ] **Step 1: Write the screen**

```jsx
import { useCallback, useEffect, useState } from 'react';
import {
  Box, Typography, Card, CardContent, Button, Stack, Chip, Tabs, Tab, TextField, MenuItem,
  Alert, Divider, Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import AddLinkIcon from '@mui/icons-material/AddLink';
import { toast } from 'react-toastify';
import api from '../../api/client';
import ProductThumb from './ProductThumb';
import LoadingSpinner from '../shared/LoadingSpinner';
import { formatCurrencyExact } from '../../utils/hebrewYear';

const perUnit = (price, qty) => (qty > 0 ? price / qty : null);

/** One side of a match: picture, name, price per pack and — live — per base unit. */
function Side({ product, packQty, onPackQty, baseUnit, editable }) {
  const per = perUnit(product.price_with_vat, Number(packQty));
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <ProductThumb product={product} size={48} radius={1.5} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary">{product.supplier_name}</Typography>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>{product.name}</Typography>
          <Typography variant="caption" color="text.secondary">{product.sku}{product.unit ? ` · ${product.unit}` : ''}</Typography>
          <Typography variant="body2" sx={{ mt: 0.5 }}>{formatCurrencyExact(product.price_with_vat)} ל{product.unit || 'אריזה'}</Typography>
        </Box>
      </Stack>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
        {editable ? (
          <TextField
            size="small" type="number" label={`כמות ${baseUnit || 'יחידות'} באריזה`} value={packQty ?? ''}
            onChange={e => onPackQty(e.target.value)} inputProps={{ min: 0, step: 'any' }} sx={{ width: 170 }}
          />
        ) : (
          <Typography variant="body2" color="text.secondary">{packQty ? `${packQty} ${baseUnit || ''} באריזה` : 'כמות באריזה לא ידועה'}</Typography>
        )}
        {per !== null && (
          <Typography variant="body2" sx={{ fontWeight: 700 }}>{formatCurrencyExact(per)} ל{baseUnit || 'יחידה'}</Typography>
        )}
      </Stack>
    </Box>
  );
}

function MatchCard({ match, mode, onDecided }) {
  const [packQty, setPackQty] = useState(() => Object.fromEntries(match.products.map(p => [String(p.id), p.pack_qty ?? ''])));
  const [baseUnit, setBaseUnit] = useState(match.base_unit || '');
  const [busy, setBusy] = useState(false);

  const act = async (action) => {
    setBusy(true);
    try {
      if (action === 'confirm') {
        const pq = Object.fromEntries(Object.entries(packQty).map(([k, v]) => [k, v === '' ? null : Number(v)]));
        await api.post(`/products/matches/${match.id}/confirm`, { pack_qty: pq, base_unit: baseUnit });
        toast.success('ההתאמה אושרה');
      } else if (action === 'reject') {
        await api.post(`/products/matches/${match.id}/reject`);
        toast.info('נרשם — לא יוצע שוב');
      } else {
        await api.post(`/products/matches/${match.id}/unlink`);
        toast.info('ההתאמה בוטלה');
      }
      onDecided();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    } finally {
      setBusy(false);
    }
  };

  const editable = mode === 'proposed';
  const pers = match.products.map(p => perUnit(p.price_with_vat, Number(packQty[String(p.id)])));
  const cheapest = pers.every(v => v !== null) ? Math.min(...pers) : null;

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            {editable ? (
              <TextField size="small" label="יחידת בסיס" value={baseUnit} onChange={e => setBaseUnit(e.target.value)} sx={{ width: 140 }} />
            ) : (
              <Chip label={match.base_unit || 'יחידה'} size="small" variant="outlined" />
            )}
            {match.label && <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{match.label}</Typography>}
          </Stack>
          {mode === 'proposed' && <Chip label={`ביטחון ${Math.round((match.confidence || 0) * 100)}%`} size="small" color={match.confidence >= 0.8 ? 'success' : 'warning'} variant="outlined" />}
          {mode === 'confirmed' && match.proposed_by === 'user' && <Chip label="ידני" size="small" variant="outlined" />}
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} divider={<Divider orientation="vertical" flexItem />}>
          {match.products.map(p => (
            <Side
              key={p.id} product={p} baseUnit={baseUnit} editable={editable}
              packQty={packQty[String(p.id)]} onPackQty={v => setPackQty(s => ({ ...s, [String(p.id)]: v }))}
            />
          ))}
        </Stack>
        {cheapest !== null && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            הזול ביותר ל{baseUnit || 'יחידה'}: {formatCurrencyExact(cheapest)}
          </Typography>
        )}
        {match.reason && <Alert severity="info" sx={{ mt: 1.5, borderRadius: 2 }}>{match.reason}</Alert>}
        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          {mode === 'proposed' ? (
            <>
              <Button variant="contained" color="success" startIcon={<CheckIcon />} onClick={() => act('confirm')} disabled={busy}>אשר</Button>
              <Button variant="outlined" color="error" startIcon={<CloseIcon />} onClick={() => act('reject')} disabled={busy}>לא אותו דבר</Button>
            </>
          ) : (
            <Button variant="outlined" color="error" startIcon={<LinkOffIcon />} onClick={() => act('unlink')} disabled={busy}>בטל התאמה</Button>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

/** Pick two products from two suppliers and declare them the same. */
function ManualMatchDialog({ open, onClose, onCreated }) {
  const [suppliers, setSuppliers] = useState([]);
  const [a, setA] = useState({ supplier: '', products: [], product: '' });
  const [b, setB] = useState({ supplier: '', products: [], product: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.get('/suppliers').then(res => setSuppliers(res.data.suppliers || [])).catch(() => setSuppliers([]));
    setA({ supplier: '', products: [], product: '' }); setB({ supplier: '', products: [], product: '' });
  }, [open]);

  const pickSupplier = (side, set) => async (e) => {
    const supplier = e.target.value;
    set({ supplier, products: [], product: '' });
    try {
      const res = await api.get('/products', { params: { supplier } });
      set(s => ({ ...s, products: res.data.products || [] }));
    } catch { /* keep empty */ }
  };

  const submit = async () => {
    if (!a.product || !b.product) return toast.error('בחר מוצר מכל צד');
    setBusy(true);
    try {
      await api.post('/products/matches', { product_ids: [a.product, b.product] });
      toast.success('ההתאמה נוצרה');
      onCreated(); onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    } finally { setBusy(false); }
  };

  const sideFields = (state, setState, label) => (
    <Stack spacing={1} sx={{ flex: 1 }}>
      <TextField select size="small" label={`ספק ${label}`} value={state.supplier} onChange={pickSupplier(label, setState)}>
        {suppliers.map(s => <MenuItem key={s._id || s.id} value={s._id || s.id}>{s.name}</MenuItem>)}
      </TextField>
      <TextField select size="small" label={`מוצר ${label}`} value={state.product} onChange={e => setState(s => ({ ...s, product: e.target.value }))} disabled={!state.products.length}>
        {state.products.map(p => <MenuItem key={p._id || p.id} value={p._id || p.id}>{p.name}</MenuItem>)}
      </TextField>
    </Stack>
  );

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" fullWidth maxWidth="sm">
      <DialogTitle sx={{ fontWeight: 700 }}>התאמה ידנית</DialogTitle>
      <DialogContent>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 1 }}>
          {sideFields(a, setA, 'א')}
          {sideFields(b, setB, 'ב')}
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          את כמות היחידות באריזה תוכל/י להשלים אחר כך בלשונית "מאושרות" — עד אז ההשוואה תוצג לפי אריזה.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={submit} disabled={busy || !a.product || !b.product || a.supplier === b.supplier}>צור התאמה</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function ProductMatches() {
  const [tab, setTab] = useState(0);
  const [data, setData] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);

  const load = useCallback(() => {
    api.get('/products/matches/review')
      .then(res => setData(res.data))
      .catch(() => toast.error('שגיאה בטעינת התאמות'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const runScan = async () => {
    setScanning(true);
    try {
      const res = await api.post('/products/matches/scan');
      const { scanned, proposed } = res.data;
      toast.success(scanned === 0 ? 'אין מוצרים חדשים לסרוק' : `נסרקו ${scanned} מוצרים · ${proposed} הצעות חדשות`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'הסריקה נכשלה');
    } finally { setScanning(false); }
  };

  if (!data) return <LoadingSpinner />;
  const last = data.last_scan;
  const list = tab === 0 ? data.proposed : data.confirmed;

  return (
    <Box dir="rtl" sx={{ maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={1}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>התאמות מוצרים</Typography>
          <Typography variant="body2" color="text.secondary">
            {last?.at ? `סריקה אחרונה: ${new Date(last.at).toLocaleString('he-IL')} · ${last.scanned} נסרקו · ${last.proposed} הוצעו` : 'עדיין לא נסרק'}
            {last?.error ? ` · ${last.error}` : ''}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={<AddLinkIcon />} onClick={() => setManualOpen(true)}>התאמה ידנית</Button>
          <Button variant="contained" startIcon={<RefreshIcon />} onClick={runScan} disabled={scanning}>{scanning ? 'סורק...' : 'סרוק עכשיו'}</Button>
        </Stack>
      </Stack>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label={`ממתינות לאישור (${data.proposed.length})`} />
        <Tab label={`מאושרות (${data.confirmed.length})`} />
      </Tabs>
      {list.length === 0 ? (
        <Typography color="text.secondary" sx={{ textAlign: 'center', py: 6 }}>
          {tab === 0 ? 'אין הצעות ממתינות. לחץ "סרוק עכשיו" אחרי העלאת קטלוג.' : 'אין התאמות מאושרות'}
        </Typography>
      ) : list.map(m => (
        <MatchCard key={m.id} match={m} mode={tab === 0 ? 'proposed' : 'confirmed'} onDecided={load} />
      ))}
      <ManualMatchDialog open={manualOpen} onClose={() => setManualOpen(false)} onCreated={load} />
    </Box>
  );
}
```

- [ ] **Step 2: Route and nav**

`client/src/App.jsx`: after the `SupplierManager` lazy import (line 112) add
```jsx
const ProductMatches = lazy(() => import('./components/orders/ProductMatches'));
```
and after `<Route path="suppliers" element={<SupplierManager />} />` (line 248) add
```jsx
        <Route path="products/matches" element={<ProductMatches />} />
```

`client/src/config/tabs.js`: after the `suppliers` item (line 150) add
```js
      { id: 'product-matches', label: 'התאמות מוצרים', path: '/products/matches', defaultRoles: ['system_admin'] },
```
Check `client/src/components/admin/PermissionsManager.jsx` and `client/src/constants/roles.js` / server `constants/roles.js` for a list of tab ids that must be kept in sync (grep for `'suppliers'`); if the id must be registered elsewhere for the nav to render, add `'product-matches'` there too and note it in the report.

- [ ] **Step 3: Build and ratchet**

Run: `cd client && npm run build && cd ../server && node scripts/design-hex-budget.test.js | tail -1` → `✓ built`, ratchet unchanged.

- [ ] **Step 4: Commit**

```bash
cd ~/dev/gan-halomot
git add client/src/components/orders/ProductMatches.jsx client/src/App.jsx client/src/config/tabs.js
git commit -m "feat(products): the admin's screen — proposed matches side by side, confirm or reject, scan now, match by hand

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The line in the order form

**Files:**
- Modify: `client/src/components/orders/OrderForm.jsx`

**Interfaces:**
- Consumes: `GET /products/matches?supplier=` → `{ matches: { [productId]: [{ supplier_name, product_name, unit, price_with_vat, pack_qty, per_unit_price, my_pack_qty, my_per_unit_price, base_unit, diff_pct }] } }`.

- [ ] **Step 1: Load the comparisons when the supplier changes**

After `const [groupInfo, setGroupInfo] = useState(null);` add:
```jsx
  const [matchMap, setMatchMap] = useState({});
```
After the "Load products when supplier changes" effect add:
```jsx
  // What the same product costs at the other supplier — confirmed matches only.
  useEffect(() => {
    if (!selectedSupplier) { setMatchMap({}); return; }
    let alive = true;
    api.get('/products/matches', { params: { supplier: selectedSupplier } })
      .then(res => { if (alive) setMatchMap(res.data.matches || {}); })
      .catch(() => { if (alive) setMatchMap({}); });
    return () => { alive = false; };
  }, [selectedSupplier]);
```

- [ ] **Step 2: Render the caption in the catalogue row**

Add a small component above `export default function OrderForm()`:

```jsx
/**
 * "אצל דאלאס: 0.24 ₪ ל-מגבון (96.78 ₪ לקרטון 400) · זול ב-12%".
 * Green when the other supplier is cheaper per unit — that is the fact worth
 * knowing while the finger is on this row. Grey when it is dearer. Per pack
 * only, with a note, when a pack size is unknown.
 */
function OtherSupplierPrice({ rows }) {
  if (!rows || !rows.length) return null;
  return (
    <Box sx={{ mt: 0.25 }}>
      {rows.map((r, i) => {
        const cheaper = r.diff_pct !== null && r.diff_pct < 0;
        const pct = r.diff_pct === null ? null : Math.abs(r.diff_pct);
        const perPack = `${formatCurrencyExact(r.price_with_vat)} ל${r.unit || 'אריזה'}${r.pack_qty ? ` ${r.pack_qty}` : ''}`;
        const text = r.per_unit_price !== null
          ? `אצל ${r.supplier_name}: ${formatCurrencyExact(r.per_unit_price)} ל-${r.base_unit || 'יחידה'} (${perPack})${pct !== null && pct !== 0 ? ` · ${cheaper ? 'זול' : 'יקר'} ב-${pct}%` : ''}`
          : `אצל ${r.supplier_name}: ${perPack} · לפי אריזה`;
        return (
          <Typography key={i} variant="caption" sx={{ display: 'block', fontWeight: cheaper ? 700 : 400 }} color={cheaper ? 'success.main' : 'text.secondary'}>
            {text}
          </Typography>
        );
      })}
    </Box>
  );
}
```

In the catalogue row, right after the `{p.standing_note && (...)}` block inside the `<Box sx={{ flex: 1 }}>`, add:
```jsx
                              <OtherSupplierPrice rows={matchMap[String(p._id || p.id)]} />
```

- [ ] **Step 3: Build, ratchet, commit**

Run: `cd client && npm run build && cd ../server && node scripts/design-hex-budget.test.js | tail -1`.

```bash
cd ~/dev/gan-halomot
git add client/src/components/orders/OrderForm.jsx
git commit -m "feat(orders): beside each product, what it costs at the other supplier per real unit

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

- **Spec coverage:** scan + memory + threshold + throttle + no-boot (T2); admin confirm/reject/unlink/manual/merge (T3, T5); comparison per unit with the unknown-pack fallback (T3, T6); routes + roles + import trigger (T4); admin screen with two tabs, editable pack qty, live per-unit price, reason, scan-now, last-scan (T5); order form line, green when cheaper, "לפי אריזה" fallback (T6); cost in the ledger + last-scan Setting (T2). Spec step 5 (first production scan + joint review) is an operational step after deploy, not code.
- **Types:** `comparisonFor` row field names in T3 = what T6 reads; `review` response `{ proposed, confirmed, last_scan }` with `products[].id/pack_qty/supplier_name` = what T5 reads; `confirm` body `{ pack_qty: {id: n|null}, base_unit }` matches `confirmMatch`.
- **Placeholders:** none.
