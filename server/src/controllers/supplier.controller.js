const { Supplier } = require('../models');

async function getAll(req, res, next) {
  try {
    const suppliers = await Supplier.find({ is_active: true }).sort({ name: 1 }).lean();
    res.json({ suppliers: suppliers.map(s => ({ ...s, id: s._id })) });
  } catch (error) { next(error); }
}

async function getById(req, res, next) {
  try {
    const supplier = await Supplier.findById(req.params.id).lean();
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    res.json({ supplier: { ...supplier, id: supplier._id } });
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  try {
    const { name, contact_name, contact_phone, contact_email, customer_name, customer_id, min_order_amount, vat_rate } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const supplier = await Supplier.create({
      name, contact_name, contact_phone, contact_email,
      customer_name: customer_name || 'גן החלומות',
      customer_id: customer_id || '',
      min_order_amount: min_order_amount || 0,
      vat_rate: vat_rate || 1.18,
    });
    res.status(201).json({ supplier: { ...supplier.toObject(), id: supplier._id } });
  } catch (error) { next(error); }
}

async function update(req, res, next) {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    const fields = ['name', 'contact_name', 'contact_phone', 'contact_email', 'customer_name', 'customer_id', 'min_order_amount', 'vat_rate'];
    fields.forEach(f => { if (req.body[f] !== undefined) supplier[f] = req.body[f]; });
    await supplier.save();
    res.json({ supplier: { ...supplier.toObject(), id: supplier._id } });
  } catch (error) { next(error); }
}

async function remove(req, res, next) {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    supplier.is_active = false;
    await supplier.save();
    res.json({ message: 'ספק הוסר', id: req.params.id });
  } catch (error) { next(error); }
}

module.exports = { getAll, getById, create, update, remove };
