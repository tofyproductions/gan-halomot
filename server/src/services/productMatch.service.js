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
    status: 'confirmed', proposed_by: 'user', confidence: 1, decided_by, decided_at: new Date(),
    ...(pair_key ? { pair_key } : {}),
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

module.exports = {
  fingerprintOf, runScan, throttledScan, _resetThrottle,
  confirmMatch, rejectMatch, unlinkMatch, manualMatch, comparisonFor,
  MODEL, MIN_CONFIDENCE, SCAN_COOLDOWN_MS, LAST_SCAN_KEY,
};
