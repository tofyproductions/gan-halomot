const mongoose = require('mongoose');
const { Order, Supplier, Branch, StockCategory, StockItem, StockBatch, StockMovement, Product } = require('../models');
const { getBranchFilter } = require('../utils/branch-filter');
const { sendOrderEmail } = require('../services/email.service');
const { deliveryFromResult, deliveryFromError } = require('../services/order-delivery.service');
const { dispatchOrders } = require('../services/order-dispatch.service');
const { createEvent, resolveEvents, branchManagerIds } = require('../services/notification.service');
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

    // How many branches each joint order on this page holds — one aggregation
    // over the page's group ids, not a query per row. Cancelled members (a
    // branch that never added anything) are not counted.
    const groupIds = [...new Set(orders.filter(o => o.group_id).map(o => String(o.group_id)))];
    const sizes = groupIds.length
      ? await Order.aggregate([
        { $match: { group_id: { $in: groupIds.map(g => new mongoose.Types.ObjectId(g)) }, status: { $ne: 'cancelled' } } },
        { $group: { _id: '$group_id', n: { $sum: 1 } } },
      ])
      : [];
    const sizeByGroup = new Map(sizes.map(g => [String(g._id), g.n]));

    res.json({
      orders: orders.map(o => ({
        ...o, id: o._id,
        branch_name: o.branch_id?.name || '',
        supplier_name: o.supplier_id?.name || '',
        ...(o.group_id ? { group_size: sizeByGroup.get(String(o.group_id)) || 0 } : {}),
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

/** Which of these branch ids the caller may see. null scope = all of them. */
function branchesInScope(req, branchIds) {
  const scope = req.branchScope;
  if (scope === null || (scope === undefined && ['system_admin', 'accountant'].includes(req.user?.role))) return branchIds.map(String);
  const allowed = new Set((Array.isArray(scope) ? scope : []).map(String));
  return branchIds.map(String).filter(id => allowed.has(id));
}

/**
 * Whether the caller may act on an order that belongs to any of these
 * branches. `canOrder` on the route is a ROLE check only — without this a
 * manager of one branch could send, share or edit another branch's draft by
 * its id, and the /group response hands every member's id to every member.
 */
function orderInScope(req, branchIds) { return branchesInScope(req, branchIds).length > 0; }

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

    // The minimum applies whenever the order is actually going to be sent —
    // which a hold, by definition, is not (yet). A hold needs to get past
    // exactly this: the point of saving a draft under the minimum is to reach
    // it later, together with another branch's draft, and `send` checks it
    // again — unconditionally, since a single draft there is a group of one.
    if (!req.body.hold && supplier.min_order_amount > 0 && total_amount < supplier.min_order_amount) {
      return res.status(400).json({
        error: `מינימום הזמנה: ${supplier.min_order_amount} ₪. סכום נוכחי: ${total_amount.toFixed(2)} ₪`,
      });
    }

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
    // Each branch edits only its own order, even inside a joint one.
    if (!orderInScope(req, [String(order.branch_id)])) return res.status(403).json({ error: 'אין הרשאה להזמנה זו' });
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

    // An invited branch that has now added items has answered the invitation.
    if (order.status === 'draft' && order.group_invited_by && (order.items || []).length) {
      await resolveEvents({ ref_collection: 'Order', ref_id: order._id });
    }

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
    if (order.status === 'cancelled') return res.status(400).json({ error: 'ההזמנה בוטלה' });
    if (order.status !== 'draft') return res.status(400).json({ error: 'ההזמנה כבר נשלחה' });

    const members = order.group_id
      ? await Order.find({ group_id: order.group_id, status: 'draft' })
      : [order];
    // Any branch in the group may send it — the same rule group() reads by.
    if (!orderInScope(req, members.map(m => String(m.branch_id)))) {
      return res.status(403).json({ error: 'אין הרשאה להזמנה זו' });
    }

    const supplier = await Supplier.findById(order.supplier_id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    const withItems = members.filter(m => (m.items || []).length > 0);
    const empty = members.filter(m => !(m.items || []).length);

    if (!withItems.length) return res.status(400).json({ error: 'אין פריטים לשליחה' });

    // The minimum applies here unconditionally — a single draft with no
    // group is a group of one, and it is being sent right now, which is
    // exactly the moment the minimum is checked at.
    const groupTotal = withItems.reduce((s, m) => s + (m.total_amount || 0), 0);
    const minOrder = supplier.min_order_amount || 0;
    if (minOrder > 0 && groupTotal < minOrder) {
      return res.status(400).json({
        error: `מינימום הזמנה ${minOrder} ₪ — חסרים ${Number((minOrder - groupTotal).toFixed(2))} ₪`,
        group_total: groupTotal, min_order_amount: minOrder,
      });
    }

    let sent;
    try {
      sent = await dispatchOrders(withItems.map(m => m._id), { supplier, user: req.user });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }

    // Only once the send went through: a send that failed leaves every member
    // exactly as it was, the empty ones included.
    if (empty.length) {
      await Order.updateMany(
        { _id: { $in: empty.map(m => m._id) }, status: 'draft' },
        { $set: { status: 'cancelled', notes: 'לא הוסיף פריטים — בוטל בשליחת ההזמנה המשותפת' } }
      );
    }

    await Promise.all(members.map(m => resolveEvents({ ref_collection: 'Order', ref_id: m._id })));

    // The caller's own order may not be among `sent` — it could have been the
    // one with no items, cancelled rather than dispatched. Falling back to
    // `sent[0]` in that case would hand the caller ANOTHER branch's order.
    let mine = sent.find(o => String(o._id) === String(order._id));
    if (!mine) {
      const refetched = await Order.findById(order._id).lean();
      mine = { ...refetched, id: refetched._id };
    }
    res.json({ order: mine, sent_count: sent.length });
  } catch (error) { next(error); }
}

/**
 * Invite another branch into this draft. The branch gets an empty draft of its
 * own with the same supplier, both drafts share a group_id, and the branch's
 * managers are told.
 */
async function invite(req, res, next) {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    if (!orderInScope(req, [String(order.branch_id)])) return res.status(403).json({ error: 'אין הרשאה להזמנה זו' });
    if (order.status !== 'draft') return res.status(400).json({ error: 'אפשר להזמין סניף רק להזמנה בהמתנה' });

    const { branch_id } = req.body;
    if (!branch_id) return res.status(400).json({ error: 'branch_id is required' });
    if (String(branch_id) === String(order.branch_id)) return res.status(400).json({ error: 'הסניף כבר בהזמנה' });

    const branch = await Branch.findOne({ _id: branch_id, is_active: true }).select('name').lean();
    if (!branch) return res.status(400).json({ error: 'סניף לא פעיל או לא קיים' });

    // The group id is written atomically: two invitations sent from the same
    // fresh draft at the same moment would otherwise each mint an id, and the
    // draft would end up in one group while one invited branch sat alone in
    // another. Whoever loses the claim reads the id the winner wrote.
    let groupId = order.group_id;
    if (!groupId) {
      const claimed = await Order.findOneAndUpdate(
        { _id: order._id, group_id: null },
        { $set: { group_id: new mongoose.Types.ObjectId() } },
        { new: true }
      );
      groupId = claimed
        ? claimed.group_id
        : (await Order.findById(order._id).select('group_id').lean()).group_id;
    }
    const already = await Order.exists({ group_id: groupId, branch_id, status: { $ne: 'cancelled' } });
    if (already) return res.status(400).json({ error: 'הסניף כבר בהזמנה המשותפת' });

    const supplier = await Supplier.findById(order.supplier_id).select('name').lean();
    const inviterBranch = await Branch.findById(order.branch_id).select('name').lean();
    const inviterName = req.user?.full_name || '';

    const created = await Order.create({
      order_number: 'ORD-' + Date.now(),
      branch_id, supplier_id: order.supplier_id,
      items: [], total_amount: 0, notes: '',
      created_by: '', status: 'draft',
      group_id: groupId, group_invited_by: inviterName,
      group_invited_from: inviterBranch?.name || '',
    });

    const recipients = await branchManagerIds(branch_id);
    await Promise.all(recipients.map(recipient_id => createEvent({
      type: 'order_shared', ref_collection: 'Order', ref_id: created._id, recipient_id,
      title: `הזמנה משותפת מ${supplier?.name || 'ספק'}`,
      body: `${inviterName || 'מנהל/ת'} מסניף ${inviterBranch?.name || ''} מזמין/ה אתכם להצטרף להזמנה. הוסיפו פריטים ושלחו יחד.`,
      url: `/orders/${created._id}/edit`,
    })));

    res.status(201).json({ order: { ...created.toObject(), id: created._id } });
  } catch (error) { next(error); }
}

/** Every member of the group, as numbers — never as items. */
async function group(req, res, next) {
  try {
    const order = await Order.findById(req.params.id).select('group_id supplier_id branch_id').lean();
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });

    const members = order.group_id
      ? await Order.find({ group_id: order.group_id }).populate('branch_id', 'name').sort({ created_at: 1 }).lean()
      : await Order.find({ _id: order._id }).populate('branch_id', 'name').lean();

    const memberBranchIds = members.map(m => String(m.branch_id?._id || m.branch_id));
    const mine = new Set(branchesInScope(req, memberBranchIds));
    if (!mine.size) return res.status(403).json({ error: 'אין הרשאה להזמנה זו' });

    const supplier = await Supplier.findById(order.supplier_id).select('name min_order_amount').lean();
    const rows = members.map(m => ({
      id: m._id,
      branch_id: m.branch_id?._id || m.branch_id,
      branch_name: m.branch_id?.name || '',
      items_count: (m.items || []).length,
      total_amount: m.total_amount || 0,
      status: m.status,
      invited_by: m.group_invited_by || '',
      is_mine: mine.has(String(m.branch_id?._id || m.branch_id)),
      // The order this request asked about. `is_mine` is true for EVERY row
      // when the caller sees all branches (the office, a multi-branch
      // manager), so it cannot tell the form which row is the cart on screen.
      is_this: String(m._id) === String(order._id),
    }));
    const total_with_items = rows
      .filter(r => r.items_count > 0 && r.status !== 'cancelled')
      .reduce((s, r) => s + r.total_amount, 0);

    res.json({
      group_id: order.group_id || null,
      supplier: { name: supplier?.name || '', min_order_amount: supplier?.min_order_amount || 0 },
      members: rows,
      total_with_items,
    });
  } catch (error) { next(error); }
}

/** Active branches not yet in this order's group — what the invite dialog lists. */
async function invitableBranches(req, res, next) {
  try {
    const order = await Order.findById(req.params.id).select('group_id branch_id').lean();
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    if (!orderInScope(req, [String(order.branch_id)])) return res.status(403).json({ error: 'אין הרשאה להזמנה זו' });
    const taken = new Set([String(order.branch_id)]);
    if (order.group_id) {
      const members = await Order.find({ group_id: order.group_id, status: { $ne: 'cancelled' } }).select('branch_id').lean();
      members.forEach(m => taken.add(String(m.branch_id)));
    }
    const branches = await Branch.find({ is_active: true }).select('name').sort({ name: 1 }).lean();
    res.json({ branches: branches.filter(b => !taken.has(String(b._id))).map(b => ({ id: b._id, name: b.name })) });
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
  // CLAIM FIRST. The old guard was a status read at the top and a status
  // write at the very end — two concurrent receives (a double-click on gan
  // Wi-Fi) both passed the read, and every quantity was booked into stock
  // twice: duplicate batches, duplicate delivery movements, doubled qty.
  // Whoever's conditional update lands owns the receive; the loser gets the
  // same "not receivable" message a stale screen always got. On a thrown
  // error the claim is released back to the prior status so a retry works.
  const prior = await Order.findOneAndUpdate(
    { _id: req.params.id, status: { $in: ['pending_receive', 'sent', 'approved'] } },
    { $set: { status: 'receiving' } },
    { new: false },
  );
  if (!prior) {
    const exists = await Order.exists({ _id: req.params.id });
    if (!exists) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    return res.status(400).json({ error: 'הזמנה לא במצב שמאפשר אישור קבלה' });
  }
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });

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

        // Atomic increment — a concurrent adjustment on the same item must
        // not be swallowed (same lost-update fix as stock.controller).
        const bumped = await StockItem.findOneAndUpdate(
          { _id: stockItem._id },
          { $inc: { qty: qtyReceived } },
          { new: true },
        );
        const after = bumped.qty;
        const before = after - qtyReceived;

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
  } catch (err) {
    // Release the claim so a retry is possible — but only if we still hold it
    // (never clobber the final status a finished run already wrote).
    await Order.updateOne(
      { _id: req.params.id, status: 'receiving' },
      { $set: { status: prior.status } },
    ).catch(() => {});
    next(err);
  }
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
    await resolveEvents({ ref_collection: 'Order', ref_id: order._id });

    // A joint order whose last items just left is over: the branches still
    // invited into it have nothing to join, so their empty drafts go too and
    // their invitations close.
    if (order.group_id) {
      const rest = await Order.find({ group_id: order.group_id, status: { $ne: 'cancelled' } })
        .select('items status').lean();
      const anyItems = rest.some(m => (m.items || []).length > 0);
      if (!anyItems) {
        const emptyDrafts = rest.filter(m => m.status === 'draft');
        if (emptyDrafts.length) {
          await Order.updateMany(
            { _id: { $in: emptyDrafts.map(m => m._id) }, status: 'draft' },
            { $set: { status: 'cancelled', notes: 'ההזמנה המשותפת נמחקה' } }
          );
          await Promise.all(emptyDrafts.map(m => resolveEvents({ ref_collection: 'Order', ref_id: m._id })));
        }
      }
    }

    res.json({ message: 'ההזמנה בוטלה', id: req.params.id });
  } catch (error) { next(error); }
}

module.exports = { getAll, getById, create, update, send, invite, group, invitableBranches, approve, markArrived, receive, resendEmail, remove };
