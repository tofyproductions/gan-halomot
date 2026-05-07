const { Order, Supplier, Branch, StockCategory, StockItem, StockBatch, StockMovement, Product } = require('../models');
const { getBranchFilter } = require('../utils/branch-filter');
const { sendOrderEmail } = require('../services/email.service');
const env = require('../config/env');

async function findOrCreateStockItem({ branch_id, product_id, name, supplier_id }) {
  if (product_id) {
    const existing = await StockItem.findOne({ branch_id, product_id, is_active: true });
    if (existing) return existing;
  }
  // Pick a category — prefer "מלאי מזון", else first active.
  let category = await StockCategory.findOne({ branch_id, name: 'מלאי מזון', is_active: true });
  if (!category) category = await StockCategory.findOne({ branch_id, is_active: true }).sort({ sort_order: 1 });
  if (!category) {
    category = await StockCategory.create({ branch_id, name: 'מלאי מזון', sort_order: 10 });
  }
  let resolvedSupplierId = supplier_id;
  if (product_id && !resolvedSupplierId) {
    const product = await Product.findById(product_id);
    if (product) resolvedSupplierId = product.supplier_id;
  }
  return StockItem.create({
    branch_id,
    category_id: category._id,
    product_id: product_id || null,
    supplier_id: resolvedSupplierId || null,
    name,
    qty: 0,
  });
}

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
      notes: notes || '', created_by: created_by || req.user?.full_name || '',
      status: 'pending',
    });

    // Send the order to the supplier and CC the creator. Wrapped in a
    // try/catch so a flaky SMTP server can't break the create itself —
    // the order is in the DB regardless.
    try {
      const branch = await Branch.findById(branch_id).select('name address').lean();
      const creatorEmail = req.user?.email && !String(req.user.email).endsWith('@gan-halomot.local') ? req.user.email : null;
      await sendOrderEmail({
        order: order.toObject(),
        supplier: supplier.toObject(),
        branch,
        creatorEmail,
        creatorName: req.user?.full_name || created_by || '',
      });
    } catch (mailErr) {
      console.error('Order email failed:', mailErr.message);
    }

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

async function resendEmail(req, res, next) {
  try {
    const order = await Order.findById(req.params.id)
      .populate('branch_id', 'name address')
      .populate('supplier_id');
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });

    const creatorEmail = req.user?.email && !String(req.user.email).endsWith('@gan-halomot.local') ? req.user.email : null;

    let result;
    try {
      result = await sendOrderEmail({
        order: order.toObject(),
        supplier: order.supplier_id?.toObject ? order.supplier_id.toObject() : order.supplier_id,
        branch: order.branch_id?.toObject ? order.branch_id.toObject() : order.branch_id,
        creatorEmail,
        creatorName: req.user?.full_name || order.created_by || '',
      });
    } catch (smtpErr) {
      console.error('Order email SMTP error:', smtpErr);
      // Surface the real SMTP error code + message so the user can fix the
      // env vars / app password without needing access to the server logs.
      const detail = smtpErr.code || smtpErr.responseCode || '';
      const msg = smtpErr.message || 'שגיאה לא ידועה';
      return res.status(500).json({
        error: `שגיאת SMTP${detail ? ` (${detail})` : ''}: ${msg}`,
        smtp_host: process.env.SMTP_HOST || '(ברירת מחדל smtp.gmail.com)',
        smtp_user: process.env.SMTP_USER || '(לא מוגדר)',
        has_pass: !!process.env.SMTP_PASS,
      });
    }

    if (result?.skipped) {
      return res.status(400).json({
        error: result.reason === 'no-recipients' ? 'אין נמענים — לספק לא הוגדר אימייל' : 'מערכת המייל לא מוגדרת (SMTP_USER חסר)',
      });
    }

    res.json({ ok: true, recipients: result.recipients });
  } catch (err) {
    next(err);
  }
}

async function markArrived(req, res, next) {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    if (!['approved', 'sent'].includes(order.status)) {
      return res.status(400).json({ error: 'ניתן לסמן הגעה רק להזמנה מאושרת או שנשלחה' });
    }
    order.status = 'pending_receive';
    order.pending_receive_at = new Date();
    await order.save();
    res.json({ order: { ...order.toObject(), id: order._id } });
  } catch (err) { next(err); }
}

async function receive(req, res, next) {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    if (!['pending_receive', 'sent', 'approved'].includes(order.status)) {
      return res.status(400).json({ error: 'הזמנה לא במצב שמאפשר אישור קבלה' });
    }

    // Body: { items: [{ index, qty_received, expiry_date, shelf_number, notes }] }
    const incoming = req.body.items || [];
    const incomingByIndex = new Map();
    incoming.forEach(r => incomingByIndex.set(r.index, r));

    let anyShortage = false;
    const userId = req.user?.id || null;
    const userName = req.user?.full_name || req.user?.email || '';

    for (let i = 0; i < order.items.length; i++) {
      const orderItem = order.items[i];
      const recv = incomingByIndex.get(i);
      const qtyReceived = recv ? Number(recv.qty_received) : orderItem.qty;
      if (isNaN(qtyReceived) || qtyReceived < 0) continue;

      // Find or create the stock item for this branch
      const stockItem = await findOrCreateStockItem({
        branch_id: order.branch_id,
        product_id: orderItem.product_id,
        name: orderItem.name,
      });

      let batch = null;
      if (qtyReceived > 0) {
        batch = await StockBatch.create({
          branch_id: order.branch_id,
          item_id: stockItem._id,
          qty: qtyReceived,
          expiry_date: recv?.expiry_date ? new Date(recv.expiry_date) : null,
          shelf_number: recv?.shelf_number || '',
          source_order_id: order._id,
          received_at: new Date(),
        });

        const before = stockItem.qty;
        const after = before + qtyReceived;
        stockItem.qty = after;
        await stockItem.save();

        await StockMovement.create({
          branch_id: order.branch_id,
          item_id: stockItem._id,
          delta: qtyReceived,
          reason: 'delivery',
          qty_before: before,
          qty_after: after,
          source_order_id: order._id,
          batch_id: batch._id,
          by_user_id: userId,
          by_user_name: userName,
          notes: recv?.notes || `קבלת הזמנה ${order.order_number}`,
        });
      }

      orderItem.qty_received = qtyReceived;
      orderItem.expiry_date = recv?.expiry_date ? new Date(recv.expiry_date) : null;
      orderItem.shelf_number = recv?.shelf_number || '';
      orderItem.stock_item_id = stockItem._id;
      orderItem.batch_id = batch?._id || null;
      if (qtyReceived < orderItem.qty) anyShortage = true;
    }

    order.status = anyShortage ? 'received_partial' : 'received';
    order.received_at = new Date();
    order.received_by_id = userId;
    order.received_by_name = userName;
    await order.save();

    res.json({ order: { ...order.toObject(), id: order._id } });
  } catch (err) { next(err); }
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

module.exports = { getAll, getById, create, update, approve, markArrived, receive, resendEmail, remove };
