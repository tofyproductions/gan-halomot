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
זהה = אותו מוצר לשימוש, גם במותג אחר, גם באריזה אחרת (כמות שונה באריזה = אותו מוצר; ציין את הכמות).
לא זהה = גודל/וריאנט של הפריט עצמו: כוס 180 מ"ל מול 250 מ"ל, חיתול מידה 3 מול 5, טעם, אחוז שומן, סוג (מגבונים לחים מול מגבוני רצפה).
לכל מוצר לכל היותר התאמה אחת לכל ספק אחר — הקרובה ביותר באריזה.
יחידת בסיס זהה לשני הצדדים; העדף ק"ג/ליטר על גרם/מ"ל; דוגמאות: "12*80 מגבונים" → 960 מגבון; "ארגז 12 × 1 ליטר" → 12 ליטר; "5 ק"ג" → 5 ק"ג; "חבילה 2 גלילים" → 2 גליל.
אם הכמות לא ניתנת לקריאה מהשם — null.
העתק את המפתחות (A1, B7) בדיוק.
confidence 0–1; החזר רק זוגות בביטחון סביר.`;

/** Fresh products per model call. 40 rows answer in well under max_tokens. */
const CHUNK = 40;
const MAX_TOKENS = 16384;

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

/** A catalogue value can hold the column separator or a line break — neither may reach the table. */
function cell(v) {
  return String(v ?? '').replace(/[|\r\n]+/g, ' ').trim();
}

function line(key, p, supplierName) {
  return `${key} | ${cell(supplierName)} | ${cell(p.sku) || '-'} | ${cell(p.name)} | ${cell(p.unit) || '-'} | ${p.price_with_vat} ₪`;
}

function scanError(message) { return new Error(message); }

/**
 * Ask the model which of `fresh` (one chunk, all from one supplier) match any
 * of `others`. Rows are keyed A1…An / B1…Bm, never by database id — the keys
 * are short, cannot be half-copied, and a key from the wrong list is simply
 * not found. Returns `[{ a, b, m }]` with the products resolved.
 *
 * Anything but a complete, parseable answer THROWS: the caller must not mark
 * a chunk as scanned on the strength of a cut-off or refused reply.
 */
async function proposeFor({ fresh, others, supplierNames, apiClient, ledger }) {
  const aByKey = new Map(fresh.map((p, i) => [`A${i + 1}`, p]));
  const bByKey = new Map(others.map((p, i) => [`B${i + 1}`, p]));
  const header = 'מפתח | ספק | מק"ט | שם | יחידת מכירה | מחיר';
  const othersText = [
    'רשימה ב — המוצרים של הספקים האחרים:',
    header,
    ...[...bByKey].map(([k, p]) => line(k, p, supplierNames.get(String(p.supplier_id)))),
  ].join('\n');
  const freshText = [
    `רשימה א — מוצרים חדשים של הספק "${cell(supplierNames.get(String(fresh[0].supplier_id)))}":`,
    header,
    ...[...aByKey].map(([k, p]) => line(k, p, supplierNames.get(String(p.supplier_id)))),
    '',
    'החזר את הזוגות (a_id = מפתח מרשימה א, b_id = מפתח מרשימה ב) שהם אותו מוצר.',
  ].join('\n');

  const response = await apiClient.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'disabled' },
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        // The other suppliers' list is the same for every chunk of a supplier — cache it.
        { type: 'text', text: othersText, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: freshText },
      ],
    }],
  });
  ledger.add(MODEL, response.usage);
  if (response.stop_reason === 'max_tokens') throw scanError('התשובה נחתכה');
  if (response.stop_reason === 'refusal') throw scanError('המודל סירב לענות');
  const textBlock = (response.content || []).find(b => b.type === 'text');
  if (!textBlock?.text) throw scanError('אין טקסט בתשובה');
  let parsed;
  try { parsed = JSON.parse(textBlock.text); } catch {
    throw scanError(`תשובה שאינה JSON: ${textBlock.text.slice(0, 120)}`);
  }
  if (!Array.isArray(parsed?.matches)) throw scanError(`תשובה בלי matches: ${textBlock.text.slice(0, 120)}`);
  const out = [];
  for (const m of parsed.matches) {
    const a = aByKey.get(String(m?.a_id ?? '').trim());
    const b = bByKey.get(String(m?.b_id ?? '').trim());
    if (a && b) out.push({ a, b, m });
  }
  return out;
}

async function writeLastScan(value) {
  await Setting.findOneAndUpdate({ key: LAST_SCAN_KEY }, { $set: { value } }, { upsert: true });
}

async function markScanned(chunk, fps, now) {
  if (!chunk.length) return;
  await ProductScanMark.bulkWrite(chunk.map(p => ({ updateOne: {
    filter: { fingerprint: fps.get(String(p._id)) },
    update: { $set: { fingerprint: fps.get(String(p._id)), product_id: p._id, scanned_at: new Date(now) } },
    upsert: true,
  } })));
}

const NOT_CONFIGURED = 'סריקת התאמות אינה מוגדרת (חסר ANTHROPIC_API_KEY)';
function isConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

/**
 * One scan: every product without a mark, in chunks of CHUNK, against the
 * products of the other suppliers. Proposals are written only above
 * MIN_CONFIDENCE and only for a pair never seen before. A chunk's marks are
 * written the moment that chunk's answer is in; a failed chunk is logged,
 * left unmarked for the next trigger, and the scan moves on.
 *
 * Within one scan a supplier is not compared against the fresh products of a
 * supplier processed earlier in the same scan — that pair was already asked
 * from the other side.
 */
async function scanOnce({ trigger = 'manual', client: injected = null, now = Date.now() } = {}) {
  const apiClient = injected || getClient();
  if (!apiClient) {
    const value = { at: new Date(now), trigger, scanned: 0, proposed: 0, cost_usd: 0, error: NOT_CONFIGURED };
    await writeLastScan(value);
    return { scanned: 0, proposed: 0, cost_usd: 0, skipped: value.error, error: null, failed_chunks: 0 };
  }

  const ledger = newLedger();
  let proposed = 0;
  let scanned = 0;
  let failed_chunks = 0;
  const errors = [];
  const errorText = () => (errors.length ? errors.join(' · ').slice(0, 300) : null);

  try {
    const products = await Product.find({ is_active: true }).select('supplier_id sku name unit price_with_vat').lean();
    const suppliers = await Supplier.find({ _id: { $in: [...new Set(products.map(p => String(p.supplier_id)))] } }).select('name').lean();
    const supplierNames = new Map(suppliers.map(s => [String(s._id), s.name]));

    const fps = new Map(products.map(p => [String(p._id), fingerprintOf(p)]));
    const marked = new Set((await ProductScanMark.find({ fingerprint: { $in: [...fps.values()] } }).select('fingerprint').lean()).map(m => m.fingerprint));
    const fresh = products.filter(p => !marked.has(fps.get(String(p._id))));
    if (!fresh.length) {
      await writeLastScan({ at: new Date(now), trigger, scanned: 0, proposed: 0, cost_usd: 0, error: '', failed_chunks: 0 });
      return { scanned: 0, proposed: 0, cost_usd: 0, skipped: null, error: null, failed_chunks: 0 };
    }

    const bySupplier = new Map();
    fresh.forEach(p => {
      const k = String(p.supplier_id);
      if (!bySupplier.has(k)) bySupplier.set(k, []);
      bySupplier.get(k).push(p);
    });

    const alreadyCompared = new Set(); // fresh products of suppliers processed earlier in this scan
    for (const [supplierId, freshOfSupplier] of bySupplier) {
      const supplierName = supplierNames.get(supplierId) || supplierId;
      const others = products.filter(p => String(p.supplier_id) !== supplierId && !alreadyCompared.has(String(p._id)));
      for (let i = 0; i < freshOfSupplier.length; i += CHUNK) {
        const chunk = freshOfSupplier.slice(i, i + CHUNK);
        try {
          const pairs = others.length
            ? await proposeFor({ fresh: chunk, others, supplierNames, apiClient, ledger })
            : [];
          for (const { a, b, m } of pairs) {
            if (!(Number(m.confidence) >= MIN_CONFIDENCE)) continue;
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
          await markScanned(chunk, fps, now);
          scanned += chunk.length;
        } catch (err) {
          failed_chunks++;
          console.warn('[product-match] chunk failed', supplierName, err.message);
          errors.push(`${supplierName}: ${err.message}`);
        }
      }
      freshOfSupplier.forEach(p => alreadyCompared.add(String(p._id)));
    }
  } catch (err) {
    console.error('[product-match] scan failed:', err.message);
    errors.push(err.message);
    const error = errorText();
    await writeLastScan({ at: new Date(now), trigger, scanned, proposed, cost_usd: ledger.total, error, failed_chunks });
    return { scanned, proposed, cost_usd: ledger.total, skipped: null, error, failed_chunks };
  }

  const error = errorText();
  await writeLastScan({ at: new Date(now), trigger, scanned, proposed, cost_usd: ledger.total, error: error || '', failed_chunks });
  console.log(`[product-match] ${trigger}: scanned ${scanned}, proposed ${proposed}, failed chunks ${failed_chunks}, $${ledger.total.toFixed(4)}`);
  return { scanned, proposed, cost_usd: ledger.total, skipped: null, error, failed_chunks };
}

let lastStartedAt = 0;
let running = false;
let cooldownMs = SCAN_COOLDOWN_MS;
let pendingTimer = null;
let pendingTrigger = null;
let pendingOpts = {};
const BUSY = 'סריקה כבר רצה';

/** Run a scan now and wait for it. Never two at once: a scan already running is reported, not joined. */
async function runScan(opts = {}) {
  if (running) return { scanned: 0, proposed: 0, cost_usd: 0, skipped: null, error: BUSY, failed_chunks: 0 };
  running = true;
  try { return await scanOnce(opts); } finally { running = false; }
}

/** Start a scan in the background. The caller has checked `running`. */
function launch(trigger, { client: injected = null, now = Date.now() } = {}) {
  lastStartedAt = now;
  running = true;
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingTrigger = null; }
  setImmediate(() => {
    scanOnce({ trigger, client: injected, now })
      .catch(err => console.error('[product-match] background scan failed:', err.message))
      .finally(() => { running = false; });
  });
}

/**
 * The "scan now" button: starts in the background, ignores the cooldown,
 * never runs beside another scan.
 */
function startScan(trigger = 'manual', opts = {}) {
  if (running) return { started: false, reason: 'running' };
  launch(trigger, opts);
  return { started: true };
}

/**
 * Fire-and-forget with a cooldown. A catalogue import calls this; ten imports
 * in a minute are one scan — plus one more at the end of the cooldown, so the
 * last import of a burst is never left unscanned. Never called at boot.
 */
function throttledScan(trigger = 'import', opts = {}) {
  const { client: injected = null, now = Date.now() } = opts;
  if (running || now - lastStartedAt < cooldownMs) {
    pendingTrigger = trigger;
    pendingOpts = { client: injected };
    if (!pendingTimer) {
      // Still inside the cooldown → at its end. Past it but a scan still runs → look again in a second.
      const remaining = lastStartedAt + cooldownMs - now;
      const wait = remaining > 0 ? remaining : (running ? 1000 : 0);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        const t = pendingTrigger;
        pendingTrigger = null;
        if (t) throttledScan(t, { ...pendingOpts, now: Math.max(Date.now(), lastStartedAt + cooldownMs) });
      }, wait);
      if (pendingTimer.unref) pendingTimer.unref();
    }
    return false;
  }
  launch(trigger, { client: injected, now });
  return true;
}
function _resetThrottle() {
  lastStartedAt = 0; running = false; cooldownMs = SCAN_COOLDOWN_MS;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null; pendingTrigger = null; pendingOpts = {};
}
function _setCooldownForTests(ms) { cooldownMs = ms; }

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function notFound() { return httpError(404, 'התאמה לא נמצאה'); }
function supplierConflict() { return httpError(400, 'בקבוצה כבר יש מוצר של הספק הזה'); }

/**
 * A pack size from a request: null (unknown) or a finite number ≥ 0. Anything
 * else is refused — a NaN here would turn every per-unit price into nonsense.
 */
function packValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  if (typeof v === 'boolean' || (typeof v !== 'number' && typeof v !== 'string')) throw httpError(400, 'כמות באריזה חייבת להיות מספר אי-שלילי');
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw httpError(400, 'כמות באריזה חייבת להיות מספר אי-שלילי');
  return n;
}

/** `{ productId: value }` → a Map of validated values. Throws before anything is written. */
function packMap(pack_qty) {
  if (pack_qty === undefined || pack_qty === null) return new Map();
  if (typeof pack_qty !== 'object' || Array.isArray(pack_qty)) throw httpError(400, 'כמות באריזה חייבת להיות מספר אי-שלילי');
  const out = new Map();
  for (const [k, v] of Object.entries(pack_qty)) {
    if (v === undefined) continue;
    out.set(String(k), packValue(v));
  }
  return out;
}

/** The confirmed, un-merged group holding this product, if any. */
async function confirmedGroupOf(productId) {
  return ProductMatch.findOne({ status: 'confirmed', merged_into: null, 'products.product_id': productId });
}

/**
 * proposed → confirmed. If one side already sits in a confirmed group, the
 * other side joins that group and the proposal is kept with `merged_into`
 * (its pair_key keeps the pair from being proposed again).
 *
 * A proposal can touch TWO different confirmed groups at once (each side
 * already belongs to one). When that happens the older group is the target
 * and the other group's members are absorbed into it — the absorbed group
 * stays `confirmed` but gets its own `merged_into` set, so its pair_key keeps
 * guarding too. A supplier may appear once per group: before any write, every
 * pending addition (from an absorbed group or from the proposal itself) is
 * checked against a product of the same supplier already destined for the
 * target, under a different product id — if found, nothing is written.
 *
 * A group is measured in ONE base unit. A proposal (or an absorbed group) in a
 * different unit is refused before any write; a proposal with no unit at all
 * joins, but never overwrites a member's pack size.
 */
async function confirmMatch(id, { pack_qty = {}, base_unit, decided_by = '' } = {}) {
  const m = await ProductMatch.findById(id);
  if (!m) throw notFound();
  if (m.status === 'confirmed') return m.merged_into ? ProductMatch.findById(m.merged_into) : m;
  if (m.status === 'rejected') throw httpError(409, 'ההתאמה נדחתה — צור התאמה ידנית כדי להחזיר אותה');

  const packs = packMap(pack_qty);
  const now = new Date();
  for (const p of m.products) {
    if (packs.has(String(p.product_id))) p.pack_qty = packs.get(String(p.product_id));
  }
  if (base_unit !== undefined && base_unit !== null) m.base_unit = String(base_unit).trim();

  // Every DISTINCT confirmed group already holding one of this proposal's products.
  const seen = new Map();
  for (const p of m.products) {
    const g = await confirmedGroupOf(p.product_id);
    if (g && String(g._id) !== String(m._id)) seen.set(String(g._id), g);
  }
  const groups = [...seen.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (!groups.length) {
    m.status = 'confirmed'; m.decided_by = decided_by; m.decided_at = now;
    await m.save();
    return m;
  }

  const target = groups[0];
  const otherGroups = groups.slice(1);
  const hasProduct = (list, productId) => list.some(t => String(t.product_id) === String(productId));

  // Dry run first: validate the unit and every pending addition before touching anything.
  const groupUnit = target.base_unit || otherGroups.map(g => g.base_unit).find(Boolean) || '';
  if (groupUnit) {
    for (const u of [...otherGroups.map(g => g.base_unit), m.base_unit]) {
      if (u && u !== groupUnit) throw httpError(400, `הקבוצה נמדדת ב-${groupUnit}`);
    }
  }
  const sameUnit = !!m.base_unit; // after the check above, a non-empty unit is the group's unit

  const bySupplier = new Map(target.products.map(t => [String(t.supplier_id), String(t.product_id)]));
  const absorbedAdditions = [];
  for (const g of otherGroups) {
    for (const src of g.products) {
      if (hasProduct(target.products, src.product_id) || hasProduct(absorbedAdditions, src.product_id)) continue;
      const holder = bySupplier.get(String(src.supplier_id));
      if (holder && holder !== String(src.product_id)) throw supplierConflict();
      bySupplier.set(String(src.supplier_id), String(src.product_id));
      absorbedAdditions.push(src);
    }
  }
  for (const p of m.products) {
    if (hasProduct(target.products, p.product_id) || hasProduct(absorbedAdditions, p.product_id)) continue;
    const holder = bySupplier.get(String(p.supplier_id));
    if (holder && holder !== String(p.product_id)) throw supplierConflict();
    bySupplier.set(String(p.supplier_id), String(p.product_id));
  }

  // Validated — now write. Absorb the other groups' members first (skip what's already there, keep their pack_qty).
  for (const src of absorbedAdditions) {
    target.products.push({ product_id: src.product_id, supplier_id: src.supplier_id, pack_qty: src.pack_qty });
  }
  for (const g of otherGroups) { g.merged_into = target._id; await g.save(); }

  // Then the proposal's own products join the target. An existing member's pack
  // size is only replaced by a proposal measured in the group's own unit.
  for (const p of m.products) {
    const existing = target.products.find(t => String(t.product_id) === String(p.product_id));
    if (existing) { if (p.pack_qty !== null && sameUnit) existing.pack_qty = p.pack_qty; }
    else target.products.push({ product_id: p.product_id, supplier_id: p.supplier_id, pack_qty: p.pack_qty });
  }
  if (!target.base_unit) target.base_unit = groupUnit || m.base_unit || '';
  target.decided_by = decided_by; target.decided_at = now;
  await target.save();
  m.status = 'confirmed'; m.merged_into = target._id; m.decided_by = decided_by; m.decided_at = now;
  await m.save();
  return target;
}

/**
 * Pack sizes and base unit of a confirmed group, after the fact — a pack the
 * model misread or a match made by hand is fixed here.
 */
async function setPacks(id, { pack_qty, base_unit } = {}) {
  const m = await ProductMatch.findById(id);
  if (!m) throw notFound();
  if (m.status !== 'confirmed' || m.merged_into) throw httpError(400, 'אפשר לעדכן כמויות רק בהתאמה מאושרת');
  const packs = packMap(pack_qty);
  for (const p of m.products) {
    if (packs.has(String(p.product_id))) p.pack_qty = packs.get(String(p.product_id));
  }
  if (base_unit !== undefined && base_unit !== null) m.base_unit = String(base_unit).trim();
  await m.save();
  return m;
}

/**
 * proposed/confirmed → rejected. Anything absorbed into this group
 * (merged_into) is rejected too, and what was absorbed into THOSE — a group
 * that absorbed another before being absorbed itself.
 */
async function rejectMatch(id, decided_by = '') {
  const m = await ProductMatch.findById(id);
  if (!m) throw notFound();
  const now = new Date();
  m.status = 'rejected'; m.decided_by = decided_by; m.decided_at = now;
  await m.save();
  const set = { $set: { status: 'rejected', decided_by, decided_at: now } };
  const level1 = (await ProductMatch.find({ merged_into: m._id, status: { $ne: 'rejected' } }).select('_id').lean()).map(d => d._id);
  if (level1.length) {
    await ProductMatch.updateMany({ _id: { $in: level1 } }, set);
    await ProductMatch.updateMany({ merged_into: { $in: level1 }, status: { $ne: 'rejected' } }, set);
  }
  return m;
}

/** confirmed → rejected. The pair is remembered and never proposed again. */
async function unlinkMatch(id, decided_by = '') {
  return rejectMatch(id, decided_by);
}

/**
 * One pair by hand: a `proposed` doc (new, or the pair's old doc revived)
 * confirmed through confirmMatch, so a product already in a group brings the
 * other one into that group. On failure the new doc is deleted and a revived
 * one gets its old state back.
 */
async function manualPair(aId, bId, decided_by) {
  const pair_key = ProductMatch.pairKey(aId, bId);
  let doc = await ProductMatch.findOne({ pair_key });
  let restore = null;
  if (doc) {
    restore = { status: doc.status, merged_into: doc.merged_into, proposed_by: doc.proposed_by, confidence: doc.confidence };
    doc.status = 'proposed'; doc.merged_into = null; doc.proposed_by = 'user'; doc.confidence = 1;
    await doc.save();
  } else {
    const products = await Product.find({ _id: { $in: [aId, bId] } }).select('supplier_id').lean();
    const byId = new Map(products.map(p => [String(p._id), p]));
    doc = await ProductMatch.create({
      products: [aId, bId].map(i => ({ product_id: byId.get(String(i))._id, supplier_id: byId.get(String(i)).supplier_id, pack_qty: null })),
      status: 'proposed', proposed_by: 'user', confidence: 1, merged_into: null, pair_key,
    });
  }
  try {
    return await confirmMatch(doc._id, { decided_by });
  } catch (err) {
    if (restore) await ProductMatch.updateOne({ _id: doc._id }, { $set: restore });
    else await ProductMatch.deleteOne({ _id: doc._id });
    throw err;
  }
}

/** Two (or more) products the admin says are the same. Confirmed at once, joining any group they are in. */
async function manualMatch(productIds, decided_by = '') {
  const ids = [...new Set((productIds || []).map(String))];
  if (ids.length < 2) throw httpError(400, 'נדרשים לפחות שני מוצרים');
  const products = await Product.find({ _id: { $in: ids } }).select('supplier_id').lean();
  if (products.length !== ids.length) throw httpError(404, 'מוצר לא נמצא');
  const suppliers = new Set(products.map(p => String(p.supplier_id)));
  if (suppliers.size !== products.length) throw httpError(400, 'התאמה היא בין ספקים שונים — מוצר אחד לכל ספק');

  // Before creating anything: would the live groups of these products, joined, hold a supplier twice?
  const live = await ProductMatch.find({ status: 'confirmed', merged_into: null, 'products.product_id': { $in: ids } }).lean();
  const bySupplier = new Map(products.map(p => [String(p.supplier_id), String(p._id)]));
  for (const g of live) {
    for (const t of g.products) {
      const holder = bySupplier.get(String(t.supplier_id));
      if (holder && holder !== String(t.product_id)) throw supplierConflict();
      bySupplier.set(String(t.supplier_id), String(t.product_id));
    }
  }

  let group = await manualPair(ids[0], ids[1], decided_by);
  for (const next of ids.slice(2)) group = await manualPair(ids[0], next, decided_by);
  return group;
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
  fingerprintOf, runScan, startScan, throttledScan, isConfigured, _resetThrottle, _setCooldownForTests,
  confirmMatch, setPacks, rejectMatch, unlinkMatch, manualMatch, comparisonFor,
  MODEL, MIN_CONFIDENCE, SCAN_COOLDOWN_MS, LAST_SCAN_KEY, CHUNK, NOT_CONFIGURED, BUSY,
};
