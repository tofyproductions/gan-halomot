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
