const { Product, Supplier } = require('../models');

async function getAll(req, res, next) {
  try {
    const { supplier } = req.query;
    const filter = { is_active: true };
    if (supplier) filter.supplier_id = supplier;
    const products = await Product.find(filter).sort({ category: 1, name: 1 }).lean();
    res.json({ products: products.map(p => ({ ...p, id: p._id })) });
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  try {
    const { supplier_id, sku, category, name, price_before_vat } = req.body;
    if (!supplier_id || !name) return res.status(400).json({ error: 'supplier_id and name are required' });

    const supplier = await Supplier.findById(supplier_id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const vatRate = supplier.vat_rate || 1.18;
    const product = await Product.create({
      supplier_id, sku: sku || '', category: category || '',
      name, price_before_vat: price_before_vat || 0,
      price_with_vat: Number(((price_before_vat || 0) * vatRate).toFixed(2)),
    });
    res.status(201).json({ product: { ...product.toObject(), id: product._id } });
  } catch (error) { next(error); }
}

async function update(req, res, next) {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const fields = ['sku', 'category', 'name', 'price_before_vat'];
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
    const docs = products.map(p => ({
      supplier_id,
      sku: p.sku || '',
      category: p.category || '',
      name: p.name,
      price_before_vat: p.price_before_vat || 0,
      price_with_vat: Number(((p.price_before_vat || 0) * vatRate).toFixed(2)),
    }));

    const inserted = await Product.insertMany(docs);
    res.status(201).json({ message: `${inserted.length} מוצרים נוספו`, count: inserted.length });
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

module.exports = { getAll, create, update, bulkImport, remove };
