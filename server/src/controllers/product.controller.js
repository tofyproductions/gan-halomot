const { Product, Supplier } = require('../models');

async function getAll(req, res, next) {
  try {
    const { supplier } = req.query;
    const filter = { is_active: true };
    if (supplier) filter.supplier_id = supplier;
    // image_data is select:false, so it is absent here by design. What the
    // screen needs is only whether there is a picture to ask for.
    const products = await Product.find(filter)
      .select('+image_data')
      .sort({ category: 1, name: 1 })
      .lean();
    res.json({
      products: products.map(({ image_data, ...p }) => ({
        ...p, id: p._id, has_image: !!image_data,
      })),
    });
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  try {
    const { supplier_id, sku, category, name, price_before_vat, standing_note, unit } = req.body;
    if (!supplier_id || !name) return res.status(400).json({ error: 'supplier_id and name are required' });

    const supplier = await Supplier.findById(supplier_id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const vatRate = supplier.vat_rate || 1.18;
    const product = await Product.create({
      supplier_id, sku: sku || '', category: category || '', unit: unit || '',
      name, standing_note: standing_note || '', price_before_vat: price_before_vat || 0,
      price_with_vat: Number(((price_before_vat || 0) * vatRate).toFixed(2)),
    });
    res.status(201).json({ product: { ...product.toObject(), id: product._id } });
  } catch (error) { next(error); }
}

async function update(req, res, next) {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const fields = ['sku', 'category', 'name', 'price_before_vat', 'image_url', 'standing_note', 'unit'];
    fields.forEach(f => { if (req.body[f] !== undefined) product[f] = req.body[f]; });

    if (req.body.price_before_vat !== undefined) {
      const supplier = await Supplier.findById(product.supplier_id);
      const vatRate = supplier?.vat_rate || 1.18;
      product.price_with_vat = Number((req.body.price_before_vat * vatRate).toFixed(2));
    }

    await product.save();
    res.json({ product: { ...product.toObject(), id: product._id } });
  } catch (error) { next(error); }
}

async function bulkImport(req, res, next) {
  try {
    const { supplier_id, products } = req.body;
    if (!supplier_id || !products?.length) return res.status(400).json({ error: 'supplier_id and products array required' });

    const supplier = await Supplier.findById(supplier_id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const vatRate = supplier.vat_rate || 1.18;
    /**
     * An import that runs twice must not leave two of everything.
     *
     * A price list is re-sent — that is the normal life of one — and the paste
     * box this endpoint was written for made a fresh row every time, so a
     * second import of the same list left the order form showing every product
     * twice at two different prices with no way to tell which was current. So
     * the item code decides: a code already on this supplier is UPDATED, and
     * only a code never seen is inserted. A product with no code (the paste
     * box allows it) has nothing to match on and is always inserted, as before.
     */
    const withSku = products.filter(p => p.sku);
    const existing = withSku.length
      ? await Product.find({ supplier_id, sku: { $in: withSku.map(p => String(p.sku)) } }).select('sku')
      : [];
    const bySku = new Map(existing.map(d => [d.sku, d]));

    const shape = (p) => {
      const price = Number(p.price_before_vat) || 0;
      const doc = {
        supplier_id,
        sku: p.sku ? String(p.sku) : '',
        category: p.category || '',
        name: p.name,
        unit: p.unit || '',
        price_before_vat: price,
        price_with_vat: Number((price * vatRate).toFixed(2)),
      };
      // Only when one was sent. An import carrying no pictures must not wipe
      // the pictures a previous one brought.
      if (p.image_data) doc.image_data = p.image_data;
      if (p.image_url) doc.image_url = p.image_url;
      return doc;
    };

    const toInsert = [];
    const updates = [];
    for (const p of products) {
      if (!p?.name) continue;
      const hit = p.sku ? bySku.get(String(p.sku)) : null;
      if (hit) updates.push({ updateOne: { filter: { _id: hit._id }, update: { $set: shape(p) } } });
      else toInsert.push(shape(p));
    }

    if (updates.length) await Product.bulkWrite(updates);
    const inserted = toInsert.length ? await Product.insertMany(toInsert) : [];

    const parts = [];
    if (inserted.length) parts.push(`${inserted.length} מוצרים נוספו`);
    if (updates.length) parts.push(`${updates.length} עודכנו`);
    res.status(201).json({
      message: parts.join(' · ') || 'לא היה מה לייבא',
      count: inserted.length, updated: updates.length,
    });
  } catch (error) { next(error); }
}

async function remove(req, res, next) {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    product.is_active = false;
    await product.save();
    res.json({ message: 'מוצר הוסר', id: req.params.id });
  } catch (error) { next(error); }
}

/**
 * GET /api/products/:id/image — the stored picture, as an image.
 *
 * Served one at a time rather than inlined in the list (see the model), and
 * with a long cache header: the bytes for a given product id never change
 * without the product being re-imported, and a screen with forty products on
 * it should ask the server once, not on every visit.
 */
async function image(req, res, next) {
  try {
    const product = await Product.findById(req.params.id).select('+image_data').lean();
    const data = product?.image_data;
    if (!data) return res.status(404).json({ error: 'אין תמונה למוצר זה' });

    const m = /^data:([^;]+);base64,(.*)$/s.exec(data);
    if (!m) return res.status(404).json({ error: 'אין תמונה למוצר זה' });

    const buf = Buffer.from(m[2], 'base64');
    res.set('Content-Type', m[1]);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  } catch (error) { next(error); }
}

module.exports = { getAll, create, update, bulkImport, remove, image };
