const { Order, Supplier, StockCategory, StockItem, StockBatch, StockMovement, Product } = require('../models');
const { getBranchFilter } = require('../utils/branch-filter');
const { sendOrderEmail } = require('../services/email.service');
const { deliveryFromResult, deliveryFromError } = require('../services/order-delivery.service');
const { dispatchOrders } = require('../services/order-dispatch.service');
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

/**
 * Item mapping, with each product's הערה קבועה snapshotted onto the line.
 *
 * Read from the DATABASE, not from whatever the client sent — the note is the
 * gan's rule ("תבלינים של טעם וריח בלבד — אלרגיה לשומשום"), and a rule the
 * browser can drop is not a rule. Snapshotted so the order forever shows what
 * the supplier was actually told, even if the product is edited later.
 */
async function withStandingNotes(items) {
  const ids = items.map(i => i.product_id).filter(Boolean);
  const products = ids.length
    ? await Product.find({ _id: { $in: ids } }).select('standing_note unit').lean()
    : [];
  const byId = new Map(products.map(p => [String(p._id), p]));
  return items.map(item => ({
    product_id: item.product_id || null,
    sku: item.sku || '',
    name: item.name,
    qty: item.qty,
    // Read off the product here rather than trusting what the browser sent, for
    // the same reason the note is: it is the catalogue that says what a unit of
    // this item is, and the order should record what the catalogue said.
    unit: byId.get(String(item.product_id))?.unit || item.unit || '',
    unit_price: item.unit_price || 0,
    total: Number(((item.qty || 0) * (item.unit_price || 0)).toFixed(2)),
    note: byId.get(String(item.product_id))?.standing_note || '',
  }));
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
    const processedItems = await withStandingNotes(items);

    const total_amount = processedItems.reduce((sum, i) => sum + i.total, 0);

    // The minimum used to be enforced right here, before the order could even
    // be saved — which is exactly what a hold needs to get past: the point of
    // saving a draft under the minimum is to reach it later, together with
    // another branch's draft. The check still happens, on the amount that
    // will actually be mailed, in `send` (and, for a group, on the combined
    // total there).
    const order_number = 'ORD-' + Date.now();

    const order = await Order.create({
      order_number, branch_id, supplier_id,
      items: processedItems, total_amount,
      notes: notes || '', created_by: created_by || req.user?.full_name || '',
      // Every order is born a draft. Without `hold` it is sent in the same
      // breath — which is what "create" always did, now through the one
      // function that sending later and sending together also use.
      status: 'draft',
    });

    if (req.body.hold) {
      return res.status(201).json({ order: { ...order.toObject(), id: order._id } });
    }

    const [sent] = await dispatchOrders([order._id], { supplier, user: req.user });
    res.status(201).json({ order: sent });
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
      order.items = await withStandingNotes(items);
      order.total_amount = order.items.reduce((sum, i) => sum + i.total, 0);
    }
    if (notes !== undefined) order.notes = notes;

    await order.save();
    res.json({ order: { ...order.toObject(), id: order._id } });
  } catch (error) { next(error); }
}

/**
 * Send a draft to the supplier. If the draft belongs to a group, every draft
 * in the group with items goes out in one email; a member that never added
 * anything is cancelled rather than sent empty.
 */
async function send(req, res, next) {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    if (order.status !== 'draft') return res.status(400).json({ error: 'ההזמנה כבר נשלחה' });

    const supplier = await Supplier.findById(order.supplier_id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const members = order.group_id
      ? await Order.find({ group_id: order.group_id, status: 'draft' })
      : [order];
    const withItems = members.filter(m => (m.items || []).length > 0);
    const empty = members.filter(m => !(m.items || []).length);

    if (!withItems.length) return res.status(400).json({ error: 'אין פריטים לשליחה' });

    // The minimum is checked here as a group concept — several branches
    // reaching it together — so it only applies when this draft actually
    // belongs to one. A lone draft has no one to combine with; the minimum
    // simply doesn't apply to it once sending has moved out of `create`.
    if (order.group_id) {
      const groupTotal = withItems.reduce((s, m) => s + (m.total_amount || 0), 0);
      const minOrder = supplier.min_order_amount || 0;
      if (minOrder > 0 && groupTotal < minOrder) {
        return res.status(400).json({
          error: `מינימום הזמנה ${minOrder} ₪ — חסרים ${Number((minOrder - groupTotal).toFixed(2))} ₪`,
          group_total: groupTotal, min_order_amount: minOrder,
        });
      }
    }

    if (empty.length) {
      await Order.updateMany(
        { _id: { $in: empty.map(m => m._id) }, status: 'draft' },
        { $set: { status: 'cancelled', notes: 'לא הוסיף פריטים — בוטל בשליחת ההזמנה המשותפת' } }
      );
    }

    let sent;
    try {
      sent = await dispatchOrders(withItems.map(m => m._id), { supplier, user: req.user });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }

    const mine = sent.find(o => String(o._id) === String(order._id)) || sent[0];
    res.json({ order: mine, sent_count: sent.length });
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
      // The order remembers the failure even though the caller is told about
      // it too — the person who clicked sees the toast, and the next person
      // to open the order in a week sees the same fact.
      await Order.updateOne({ _id: order._id }, { $set: deliveryFromError(smtpErr) })
        .catch(e => console.error('Order email status write failed:', e.message));
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

    await Order.updateOne({ _id: order._id }, { $set: deliveryFromResult(result) })
      .catch(e => console.error('Order email status write failed:', e.message));

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

module.exports = { getAll, getById, create, update, send, approve, markArrived, receive, resendEmail, remove };
