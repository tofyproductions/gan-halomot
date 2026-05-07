const { StockCategory, StockItem, StockMovement, StockBatch, Product, Supplier } = require('../models');

const DEFAULT_CATEGORIES = [
  { name: 'מלאי מזון',   sort_order: 10 },
  { name: 'מלאי יצירות', sort_order: 20 },
];

// Ensure a branch has its default categories. Idempotent.
async function ensureDefaultCategories(branch_id) {
  const count = await StockCategory.countDocuments({ branch_id, is_active: true });
  if (count > 0) return;
  await StockCategory.insertMany(DEFAULT_CATEGORIES.map(c => ({ ...c, branch_id })));
}

function userInfo(req) {
  return {
    by_user_id: req.user?.id || null,
    by_user_name: req.user?.full_name || req.user?.email || '',
  };
}

// ---------- Categories ----------

async function listCategories(req, res, next) {
  try {
    const { branch_id } = req.query;
    if (!branch_id) return res.status(400).json({ error: 'branch_id נדרש' });
    await ensureDefaultCategories(branch_id);
    const categories = await StockCategory.find({ branch_id, is_active: true }).sort({ sort_order: 1, created_at: 1 });
    res.json({ categories });
  } catch (err) { next(err); }
}

async function createCategory(req, res, next) {
  try {
    const { branch_id, name, sort_order } = req.body;
    if (!branch_id || !name) return res.status(400).json({ error: 'branch_id ו-name נדרשים' });
    const category = await StockCategory.create({ branch_id, name: name.trim(), sort_order: sort_order || 100 });
    res.status(201).json({ category });
  } catch (err) { next(err); }
}

async function updateCategory(req, res, next) {
  try {
    const { id } = req.params;
    const { name, sort_order } = req.body;
    const update = {};
    if (name !== undefined) update.name = name.trim();
    if (sort_order !== undefined) update.sort_order = sort_order;
    const category = await StockCategory.findByIdAndUpdate(id, update, { new: true });
    if (!category) return res.status(404).json({ error: 'קטגוריה לא נמצאה' });
    res.json({ category });
  } catch (err) { next(err); }
}

async function deleteCategory(req, res, next) {
  try {
    const { id } = req.params;
    // Prevent deleting if items exist; soft-delete the category and refuse if items still active.
    const itemsCount = await StockItem.countDocuments({ category_id: id, is_active: true });
    if (itemsCount > 0) {
      return res.status(400).json({ error: `יש ${itemsCount} פריטים פעילים בקטגוריה. העבר או מחק אותם קודם.` });
    }
    await StockCategory.findByIdAndUpdate(id, { is_active: false });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// ---------- Items ----------

async function listItems(req, res, next) {
  try {
    const { branch_id, category_id, q, supplier_id } = req.query;
    if (!branch_id) return res.status(400).json({ error: 'branch_id נדרש' });
    const filter = { branch_id, is_active: true };
    if (category_id) filter.category_id = category_id;
    if (supplier_id) filter.supplier_id = supplier_id;
    if (q) filter.name = { $regex: q.trim(), $options: 'i' };
    const items = await StockItem.find(filter)
      .populate('product_id', 'name image_url price_with_vat')
      .populate('supplier_id', 'name')
      .sort({ name: 1 });
    res.json({ items });
  } catch (err) { next(err); }
}

async function createItem(req, res, next) {
  try {
    const { branch_id, category_id, product_id, name, unit, pack_size, min_qty, warn_qty, qty, notes } = req.body;
    if (!branch_id || !category_id) return res.status(400).json({ error: 'branch_id ו-category_id נדרשים' });

    let resolvedName = (name || '').trim();
    let supplier_id = null;
    if (product_id) {
      const product = await Product.findById(product_id);
      if (!product) return res.status(404).json({ error: 'מוצר לא נמצא' });
      if (!resolvedName) resolvedName = product.name;
      supplier_id = product.supplier_id;
    }
    if (!resolvedName) return res.status(400).json({ error: 'שם פריט נדרש' });

    const initialQty = Number(qty) || 0;
    const item = await StockItem.create({
      branch_id, category_id,
      product_id: product_id || null,
      supplier_id,
      name: resolvedName,
      unit: unit || 'יח\'',
      pack_size: Number(pack_size) || 0,
      min_qty: Number(min_qty) || 0,
      warn_qty: Number(warn_qty) || 0,
      qty: initialQty,
      notes: notes || '',
    });

    if (initialQty !== 0) {
      await StockMovement.create({
        branch_id, item_id: item._id,
        delta: initialQty, reason: 'init',
        qty_before: 0, qty_after: initialQty,
        ...userInfo(req),
        notes: 'יצירת פריט עם מלאי התחלתי',
      });
    }
    res.status(201).json({ item });
  } catch (err) { next(err); }
}

async function updateItem(req, res, next) {
  try {
    const { id } = req.params;
    const { name, unit, pack_size, min_qty, warn_qty, notes, category_id } = req.body;
    const update = {};
    if (name !== undefined) update.name = name.trim();
    if (unit !== undefined) update.unit = unit;
    if (pack_size !== undefined) update.pack_size = Number(pack_size) || 0;
    if (min_qty !== undefined) update.min_qty = Number(min_qty) || 0;
    if (warn_qty !== undefined) update.warn_qty = Number(warn_qty) || 0;
    if (notes !== undefined) update.notes = notes;
    if (category_id !== undefined) update.category_id = category_id;
    const item = await StockItem.findByIdAndUpdate(id, update, { new: true })
      .populate('product_id', 'name image_url')
      .populate('supplier_id', 'name');
    if (!item) return res.status(404).json({ error: 'פריט לא נמצא' });
    res.json({ item });
  } catch (err) { next(err); }
}

async function deleteItem(req, res, next) {
  try {
    const { id } = req.params;
    await StockItem.findByIdAndUpdate(id, { is_active: false });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// Append a delta — qty adjustment from +/- buttons.
async function adjustItem(req, res, next) {
  try {
    const { id } = req.params;
    const { delta, reason, notes } = req.body;
    const num = Number(delta);
    if (!num || isNaN(num)) return res.status(400).json({ error: 'delta חייב להיות מספר שונה מאפס' });
    const item = await StockItem.findById(id);
    if (!item) return res.status(404).json({ error: 'פריט לא נמצא' });

    const before = item.qty;
    const after = before + num;
    item.qty = after;
    await item.save();

    const movement = await StockMovement.create({
      branch_id: item.branch_id, item_id: item._id,
      delta: num, reason: reason || 'correction',
      qty_before: before, qty_after: after,
      ...userInfo(req),
      notes: notes || '',
    });

    res.json({ item, movement });
  } catch (err) { next(err); }
}

// Absolute count — sets qty directly, delta = qty - current. Stamps last_counted.
async function countItem(req, res, next) {
  try {
    const { id } = req.params;
    const { qty, notes } = req.body;
    const target = Number(qty);
    if (isNaN(target) || target < 0) return res.status(400).json({ error: 'qty חייב להיות מספר חיובי' });
    const item = await StockItem.findById(id);
    if (!item) return res.status(404).json({ error: 'פריט לא נמצא' });

    const before = item.qty;
    const num = target - before;
    item.qty = target;
    item.last_counted_at = new Date();
    item.last_counted_by = req.user?.id || null;
    await item.save();

    let movement = null;
    if (num !== 0) {
      movement = await StockMovement.create({
        branch_id: item.branch_id, item_id: item._id,
        delta: num, reason: 'count',
        qty_before: before, qty_after: target,
        ...userInfo(req),
        notes: notes || '',
      });
    }
    res.json({ item, movement });
  } catch (err) { next(err); }
}

// Reverse a specific movement. Creates a new movement with opposite delta + reason='undo'.
async function undoMovement(req, res, next) {
  try {
    const { id } = req.params; // movement id
    const original = await StockMovement.findById(id);
    if (!original) return res.status(404).json({ error: 'תנועה לא נמצאה' });
    if (original.reversed_by_id) return res.status(400).json({ error: 'תנועה זו כבר בוטלה' });
    if (original.reason === 'undo') return res.status(400).json({ error: 'לא ניתן לבטל פעולת ביטול' });

    const item = await StockItem.findById(original.item_id);
    if (!item) return res.status(404).json({ error: 'פריט לא נמצא' });

    const before = item.qty;
    const after = before - original.delta;
    item.qty = after;
    await item.save();

    const reverse = await StockMovement.create({
      branch_id: item.branch_id, item_id: item._id,
      delta: -original.delta, reason: 'undo',
      qty_before: before, qty_after: after,
      reverses_id: original._id,
      ...userInfo(req),
      notes: `ביטול תנועה ${original._id}`,
    });

    original.reversed_by_id = reverse._id;
    await original.save();

    res.json({ item, movement: reverse });
  } catch (err) { next(err); }
}

async function listMovements(req, res, next) {
  try {
    const { item_id, branch_id, limit } = req.query;
    if (!item_id && !branch_id) return res.status(400).json({ error: 'item_id או branch_id נדרש' });
    const filter = {};
    if (item_id) filter.item_id = item_id;
    if (branch_id) filter.branch_id = branch_id;
    const cap = Math.min(Number(limit) || 50, 500);
    const movements = await StockMovement.find(filter)
      .sort({ created_at: -1 })
      .limit(cap);
    res.json({ movements });
  } catch (err) { next(err); }
}

// Search products across all suppliers for the autocomplete in "add item".
async function searchProducts(req, res, next) {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 1) return res.json({ products: [] });
    const products = await Product.find({
      is_active: true,
      name: { $regex: q.trim(), $options: 'i' },
    })
      .populate('supplier_id', 'name')
      .limit(50);
    res.json({ products });
  } catch (err) { next(err); }
}

// Average daily consumption from movements (reason='consumption' or reason='count' negative)
// over the last `days` days. Used for restock forecasting.
async function consumptionStats(req, res, next) {
  try {
    const { item_id, days } = req.query;
    if (!item_id) return res.status(400).json({ error: 'item_id נדרש' });
    const windowDays = Math.min(Number(days) || 30, 365);
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const movements = await StockMovement.find({
      item_id, created_at: { $gte: since },
      reason: { $in: ['consumption', 'spoilage'] },
    });
    const totalOut = movements.reduce((s, m) => s + Math.min(0, m.delta), 0);
    const avgPerDay = -totalOut / windowDays;
    res.json({ window_days: windowDays, total_out: -totalOut, avg_per_day: avgPerDay });
  } catch (err) { next(err); }
}

// Items below threshold, grouped by supplier — drives the
// "create order from shortages" workflow and the dashboard tile.
async function listShortages(req, res, next) {
  try {
    const { branch_id, level } = req.query;
    if (!branch_id) return res.status(400).json({ error: 'branch_id נדרש' });
    const items = await StockItem.find({ branch_id, is_active: true })
      .populate('product_id', 'name price_with_vat sku')
      .populate('supplier_id', 'name min_order_amount')
      .populate('category_id', 'name');

    const lvl = level || 'red';
    const filtered = items.filter(i => {
      const w = i.warn_qty > 0 ? i.warn_qty : i.min_qty;
      if (lvl === 'warn') return i.qty < w;
      return i.qty < i.min_qty;
    });

    const groups = {};
    for (const it of filtered) {
      const sid = it.supplier_id?._id?.toString() || 'none';
      if (!groups[sid]) {
        groups[sid] = {
          supplier: it.supplier_id || null,
          items: [],
        };
      }
      groups[sid].items.push(it);
    }
    res.json({ groups: Object.values(groups), total: filtered.length });
  } catch (err) { next(err); }
}

// Per-branch counts for the dashboard widget. system_admin sees every branch;
// other roles see only their own.
async function shortagesByBranch(req, res, next) {
  try {
    const { Branch } = require('../models');
    const isAdmin = req.user?.role === 'system_admin';
    const filter = isAdmin ? { is_active: true } : { _id: req.user?.branch_id };
    const branches = await Branch.find(filter).select('name').lean();

    const out = [];
    for (const b of branches) {
      const items = await StockItem.find({ branch_id: b._id, is_active: true }).select('qty min_qty warn_qty').lean();
      let red = 0, warn = 0;
      for (const i of items) {
        if (i.qty < i.min_qty) red++;
        else if (i.warn_qty > 0 && i.qty < i.warn_qty) warn++;
      }
      out.push({ branch_id: b._id, branch_name: b.name, total: items.length, red, warn });
    }
    res.json({ branches: out });
  } catch (err) { next(err); }
}

module.exports = {
  listCategories, createCategory, updateCategory, deleteCategory,
  listItems, createItem, updateItem, deleteItem,
  adjustItem, countItem, undoMovement, listMovements,
  searchProducts, consumptionStats, listShortages, shortagesByBranch,
};
