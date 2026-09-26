/**
 * Sending an order to the supplier — one place, whether the order goes out the
 * moment it is created, is sent later from a draft, or goes out together with
 * the drafts of other branches.
 *
 * Before this, the send lived inside the create handler: email the supplier,
 * then write what happened onto the order. A draft that is sent later needs
 * exactly the same thing, and a group needs it for N orders at once with one
 * email. So it is one function, and a single order is a group of one.
 *
 * The claim comes first. `status: 'draft'` → `'pending'` is written with a
 * condition on the current status, so two managers clicking "send" on the
 * same group at the same moment cannot both win: the second finds nothing to
 * claim and is told so. Only the orders actually claimed are emailed.
 */
const { Order, Branch } = require('../models');
const { sendOrderEmail, sendGroupOrderEmail } = require('./email.service');
const { deliveryFromResult, deliveryFromError } = require('./order-delivery.service');

function creatorEmailOf(user) {
  const email = user?.email;
  if (!email) return null;
  return String(email).endsWith('@gan-halomot.local') ? null : email;
}

/**
 * @param {Array<string|import('mongoose').Types.ObjectId>} orderIds  drafts to send, all for `supplier`
 * @param {{ supplier: object, user: object }} ctx
 * @returns {Promise<object[]>} the sent orders, fresh from the database (plain objects with `id`)
 */
async function dispatchOrders(orderIds, { supplier, user }) {
  const ids = orderIds.map(String);
  const now = new Date();
  const sentBy = user?.full_name || '';

  // Claim. Whoever's update matches is the one who sends.
  const claim = await Order.updateMany(
    { _id: { $in: ids }, status: 'draft' },
    { $set: { status: 'pending', sent_at: now, sent_by: sentBy } }
  );
  if (!claim.modifiedCount) {
    const err = new Error('ההזמנה כבר נשלחה');
    err.status = 400;
    throw err;
  }
  // ALL OR NOTHING. Per-document claims are atomic, but a GROUP send that
  // wins only part of its list means a concurrent send owns the rest — and
  // the supplier would receive two partial emails instead of one combined
  // order. A partial claim releases what it took and refuses; whoever won
  // the other half sends everything they claimed, and a refresh shows the
  // truth. (One combined email is the entire point of a group.)
  if (claim.modifiedCount < ids.length) {
    await Order.updateMany(
      { _id: { $in: ids }, status: 'pending', sent_at: now, sent_by: sentBy },
      { $set: { status: 'draft', sent_at: null, sent_by: '' } },
    ).catch(() => {});
    const err = new Error('חלק מהזמנות הקבוצה כבר נשלחו — רעננו את המסך ונסו שוב');
    err.status = 409;
    throw err;
  }

  const orders = await Order.find({ _id: { $in: ids }, sent_at: now }).lean();
  const branchIds = [...new Set(orders.map(o => String(o.branch_id)))];
  const branches = await Branch.find({ _id: { $in: branchIds } })
    .select('name address delivery_contact_name delivery_contact_phone').lean();
  const branchById = new Map(branches.map(b => [String(b._id), b]));

  const creatorEmail = creatorEmailOf(user);
  // Whoever clicked, and if the session carries no name, whoever wrote the
  // order — the supplier's copy should never say "הזמין:" with nothing after.
  const creatorName = sentBy || orders[0]?.created_by || '';
  const supplierObj = supplier?.toObject ? supplier.toObject() : supplier;

  let delivery;
  try {
    let result;
    if (orders.length === 1) {
      result = await sendOrderEmail({
        order: orders[0], supplier: supplierObj, branch: branchById.get(String(orders[0].branch_id)) || null,
        creatorEmail, creatorName,
      });
    } else {
      result = await sendGroupOrderEmail({
        orders: orders.map(o => ({ order: o, branch: branchById.get(String(o.branch_id)) || null })),
        supplier: supplierObj, creatorEmail, creatorName,
      });
    }
    delivery = deliveryFromResult(result);
  } catch (mailErr) {
    console.error('Order email failed:', mailErr.message);
    delivery = deliveryFromError(mailErr);
  }

  // Recording the outcome must not be able to undo the send.
  try {
    await Order.updateMany({ _id: { $in: orders.map(o => o._id) } }, { $set: delivery });
  } catch (writeErr) {
    console.error('Order email status write failed:', writeErr.message);
  }

  const fresh = await Order.find({ _id: { $in: orders.map(o => o._id) } }).lean();
  return fresh.map(o => ({ ...o, id: o._id }));
}

module.exports = { dispatchOrders };
