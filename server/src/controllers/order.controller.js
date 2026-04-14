const { Order, Supplier, Branch } = require('../models');
const { getBranchFilter } = require('../utils/branch-filter');
const { sendOrderEmail } = require('../services/email.service');
const env = require('../config/env');

async function getAll(req, res, next) {
  try {
    const { status, supplier } = req.query;
    const filter = { ...getBranchFilter(req) };
    if (status) filter.status = status;
    if (supplier) filter.supplier_id = supplier;

    const orders = await Order.find(filter)
      .populate('branch_id', 'name')
      .populate('supplier_id', 'name')
      .sort({ created_at: -1 })
      .lean();

    res.json({
      orders: orders.map(o => ({
        ...o, id: o._id,
        branch_name: o.branch_id?.name || '',
        supplier_name: o.supplier_id?.name || '',
      })),
    });
  } catch (error) { next(error); }
}

async function getById(req, res, next) {
  try {
    const order = await Order.findById(req.params.id)
      .populate('branch_id', 'name address')
      .populate('supplier_id')
      .lean();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order: { ...order, id: order._id } });
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  try {
    const { branch_id, supplier_id, items, notes, created_by } = req.body;
    if (!branch_id || !supplier_id || !items?.length) {
      return res.status(400).json({ error: 'branch_id, supplier_id, and items are required' });
    }

    const supplier = await Supplier.findById(supplier_id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    // Calculate totals
    const processedItems = items.map(item => ({
      product_id: item.product_id || null,
      sku: item.sku || '',
      name: item.name,
      qty: item.qty,
      unit_price: item.unit_price || 0,
      total: Number(((item.qty || 0) * (item.unit_price || 0)).toFixed(2)),
    }));

    const total_amount = processedItems.reduce((sum, i) => sum + i.total, 0);

    // Check minimum
    if (supplier.min_order_amount > 0 && total_amount < supplier.min_order_amount) {
      return res.status(400).json({
        error: `מינימום הזמנה: ${supplier.min_order_amount} ₪. סכום נוכחי: ${total_amount.toFixed(2)} ₪`,
      });
    }

    const order_number = 'ORD-' + Date.now();

    const order = await Order.create({
      order_number, branch_id, supplier_id,
      items: processedItems, total_amount,
      notes: notes || '', created_by: created_by || '',
      status: 'pending',
    });

    res.status(201).json({ order: { ...order.toObject(), id: order._id } });
  } catch (error) { next(error); }
}

async function update(req, res, next) {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending' && order.status !== 'draft') {
      return res.status(400).json({ error: 'ניתן לערוך רק הזמנות ממתינות' });
    }

    const { items, notes } = req.body;
    if (items) {
      order.items = items.map(item => ({
        product_id: item.product_id || null,
        sku: item.sku || '',
        name: item.name,
        qty: item.qty,
        unit_price: item.unit_price || 0,
        total: Number(((item.qty || 0) * (item.unit_price || 0)).toFixed(2)),
      }));
      order.total_amount = order.items.reduce((sum, i) => sum + i.total, 0);
    }
    if (notes !== undefined) order.notes = notes;

    await order.save();
    res.json({ order: { ...order.toObject(), id: order._id } });
  } catch (error) { next(error); }
}

async function approve(req, res, next) {
  try {
    const order = await Order.findById(req.params.id)
      .populate('branch_id', 'name address')
      .populate('supplier_id');
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') {
      return res.status(400).json({ error: 'הזמנה זו כבר אושרה' });
    }

    order.status = 'approved';
    order.approved_by = req.body.approved_by || '';
    order.approved_at = new Date();
    await order.save();

    // Try to send email notification (don't fail if email not configured)
    try {
      if (env.SMTP_USER) {
        // Email would be sent here when SMTP is configured
        console.log('Order approved:', order.order_number);
      }
    } catch (emailErr) {
      console.error('Email failed:', emailErr.message);
    }

    res.json({ message: 'ההזמנה אושרה', order: { ...order.toObject(), id: order._id } });
  } catch (error) { next(error); }
}

async function remove(req, res, next) {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'approved' || order.status === 'sent') {
      return res.status(400).json({ error: 'לא ניתן לבטל הזמנה שאושרה' });
    }

    order.status = 'cancelled';
    await order.save();
    res.json({ message: 'ההזמנה בוטלה', id: req.params.id });
  } catch (error) { next(error); }
}

module.exports = { getAll, getById, create, update, approve, remove };
