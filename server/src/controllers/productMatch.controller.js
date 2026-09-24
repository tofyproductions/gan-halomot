const { ProductMatch, Product, Supplier, Setting } = require('../models');
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

/**
 * Groups with their full products. A proposal whose product was removed (or
 * deactivated) since is dropped and rejected — it can never be confirmed
 * sensibly. A confirmed group only hides the removed member; with fewer than
 * two left it is not shown. `liveGroups`, when given, marks each product that
 * already sits in a confirmed group with `existing_group: { id, base_unit }`.
 */
async function withProducts(groups, { rejectBroken = false, liveGroups = null } = {}) {
  const ids = [...new Set(groups.flatMap(g => g.products.map(p => String(p.product_id))))];
  const products = await Product.find({ _id: { $in: ids } }).select('+image_data').lean();
  const byId = new Map(products.filter(p => p.is_active !== false).map(p => [String(p._id), p]));
  const supplierIds = [...new Set(products.map(p => String(p.supplier_id)))];
  const suppliers = await Supplier.find({ _id: { $in: supplierIds } }).select('name').lean();
  const sName = new Map(suppliers.map(s => [String(s._id), s.name]));
  const groupOf = new Map();
  for (const g of liveGroups || []) {
    for (const p of g.products) groupOf.set(String(p.product_id), { id: g._id, base_unit: g.base_unit || '' });
  }

  const broken = [];
  const out = [];
  for (const g of groups) {
    const present = g.products.filter(m => byId.has(String(m.product_id)));
    if (rejectBroken && present.length !== g.products.length) { broken.push(g._id); continue; }
    if (present.length < 2) continue;
    out.push({
      ...g, id: g._id,
      products: present.map(m => {
        const p = byId.get(String(m.product_id));
        const { image_data, ...rest } = p;
        const existing_group = liveGroups ? groupOf.get(String(m.product_id)) || null : undefined;
        return {
          ...rest, id: p._id, has_image: !!image_data, supplier_name: sName.get(String(m.supplier_id)) || '', pack_qty: m.pack_qty,
          ...(existing_group !== undefined ? { existing_group } : {}),
        };
      }),
    });
  }
  if (broken.length) {
    await ProductMatch.updateMany(
      { _id: { $in: broken }, status: 'proposed' },
      { $set: { status: 'rejected', decided_by: 'system', decided_at: new Date(), reason: 'מוצר הוסר' } },
    );
  }
  return out;
}

/** GET /products/matches/review — proposed + confirmed with full products, and the last scan. */
async function review(req, res, next) {
  try {
    const [proposed, confirmed, last] = await Promise.all([
      ProductMatch.find({ status: 'proposed' }).sort({ confidence: -1 }).lean(),
      ProductMatch.find({ status: 'confirmed', merged_into: null }).sort({ updated_at: -1 }).lean(),
      Setting.findOne({ key: svc.LAST_SCAN_KEY }).lean(),
    ]);
    res.json({
      proposed: await withProducts(proposed, { rejectBroken: true, liveGroups: confirmed }),
      confirmed: await withProducts(confirmed),
      last_scan: last?.value || null,
    });
  } catch (error) { next(error); }
}

/**
 * POST /products/matches/scan — start now, ignoring the cooldown, in the
 * background: a whole catalogue takes minutes, far past an HTTP request. The
 * screen polls /review until last_scan.at moves.
 */
async function scan(req, res, next) {
  try {
    if (!svc.isConfigured()) return res.status(400).json({ error: svc.NOT_CONFIGURED });
    const r = svc.startScan('manual');
    if (!r.started) return res.status(409).json({ error: svc.BUSY });
    res.status(202).json({ started: true });
  } catch (error) { next(error); }
}

/** POST /products/matches/:id/packs — pack sizes and base unit of a confirmed group. */
async function packs(req, res, next) {
  try {
    const g = await svc.setPacks(req.params.id, { pack_qty: req.body.pack_qty, base_unit: req.body.base_unit });
    res.json({ match: { ...g.toObject(), id: g._id } });
  } catch (error) { try { send(res, error); } catch (e) { next(e); } }
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

module.exports = { matches, review, scan, create, confirm, packs, reject, unlink };
