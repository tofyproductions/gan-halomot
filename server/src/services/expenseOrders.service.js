/**
 * Expenses ↔ orders link (spec §9). A supplier invoice can point at the order
 * it bills. Candidates are a pure read; link / unlink are a person's click.
 *
 * VAT rule: an Order item's `unit_price` is the product's `price_with_vat`
 * (OrderForm sends `c.product.price_with_vat`; `price_before_vat` is derived
 * by dividing by the supplier's vat_rate). So Σ qty_received × unit_price is
 * ALREADY VAT-inclusive, like `ExpenseDocument.amount_total`, and must NOT be
 * multiplied by `vat_rate` again. `total_amount` is likewise inclusive.
 *
 * Errors are `Error` with a Hebrew message and `status`.
 */
const mongoose = require('mongoose');
const { ExpenseDocument, Order } = require('../models');
const { withLocks } = require('./expenseWrites.service');

const LINKABLE_STATUSES = ['sent', 'pending_receive', 'receiving', 'received', 'received_partial'];
const INVOICE_TYPES = ['tax_invoice', 'invoice_receipt'];
const WINDOW_BEFORE_DAYS = 30; // document up to 30 days before the order date
const WINDOW_AFTER_DAYS = 60;  // ... and up to 60 days after it
const MISMATCH_TOLERANCE_ILS = 2;
const DAY = 86400000;

const fail = (status, message) => Object.assign(new Error(message), { status });
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const oid = (v, what) => {
  if (!mongoose.isValidObjectId(v)) throw fail(400, `${what} לא תקין`);
  return String(v);
};
const ymd = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(date);
const dayOf = (s) => Math.floor(Date.parse(`${s}T00:00:00Z`) / DAY);

/** received_at, else created_at — as an Israel calendar date. */
const orderDate = (order) => ymd(new Date(order.received_at || order.created_at));

/** What the order is worth to compare against an invoice (VAT-inclusive, see header). */
function compareAmount(order) {
  const items = order.items || [];
  const hasReceipt = items.some(i => Number(i.qty_received) > 0);
  if (!hasReceipt) return round2(order.total_amount);
  return round2(items.reduce((s, i) => s + (Number(i.qty_received) || 0) * (Number(i.unit_price) || 0), 0));
}

/** `{ diff, warning }` — diff = document − order, warning only past 2 ₪. */
function orderMismatch(doc, order) {
  const diff = round2((Number(doc.amount_total) || 0) - compareAmount(order));
  let warning = null;
  if (Math.abs(diff) > MISMATCH_TOLERANCE_ILS) {
    const x = Math.abs(diff).toLocaleString('he-IL', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    warning = diff > 0 ? `החשבונית גבוהה ב-${x} ₪ ממה שהתקבל` : `החשבונית נמוכה ב-${x} ₪ ממה שהתקבל`;
  }
  return { diff, warning };
}

async function loadDoc(docId) {
  oid(docId, 'מזהה מסמך');
  const doc = await ExpenseDocument.findById(docId);
  if (!doc) throw fail(404, 'המסמך לא נמצא');
  if (doc.status === 'void') throw fail(409, 'המסמך מבוטל — אי אפשר לשנות אותו');
  return doc;
}

const linkedElsewhere = (orderId, docId) => ExpenseDocument.exists({
  _id: { $ne: docId }, order_id: orderId, status: 'active', doc_type: { $in: INVOICE_TYPES },
});

function inWindow(doc, order) {
  const gap = dayOf(doc.doc_date) - dayOf(orderDate(order));
  return gap >= -WINDOW_BEFORE_DAYS && gap <= WINDOW_AFTER_DAYS;
}

/** Orders this document may bill, smallest amount difference first. Pure read. */
async function orderCandidates(docId) {
  const doc = await loadDoc(docId);
  if (!doc.supplier_id || !doc.doc_date) return [];
  const orders = await Order.find({ supplier_id: doc.supplier_id, status: { $in: LINKABLE_STATUSES } }).lean();
  const taken = new Set((await ExpenseDocument.find({
    _id: { $ne: doc._id }, order_id: { $in: orders.map(o => o._id) }, status: 'active', doc_type: { $in: INVOICE_TYPES },
  }, 'order_id').lean()).map(d => String(d.order_id)));
  return orders
    .filter(o => inWindow(doc, o) && !taken.has(String(o._id)))
    .map(order => ({ order, compare_amount: compareAmount(order), diff: orderMismatch(doc, order).diff }))
    .sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff) || String(a.order._id).localeCompare(String(b.order._id)));
}

async function linkOrder(docId, orderId, by) {
  oid(docId, 'מזהה מסמך'); oid(orderId, 'מזהה הזמנה');
  return withLocks([`order:${orderId}`, `doc:${docId}`], async () => {
    const doc = await loadDoc(docId);
    const order = await Order.findById(orderId).lean();
    if (!order) throw fail(404, 'ההזמנה לא נמצאה');
    if (!doc.supplier_id || String(doc.supplier_id) !== String(order.supplier_id)) throw fail(409, 'ההזמנה היא של ספק אחר');
    if (!LINKABLE_STATUSES.includes(order.status)) throw fail(409, 'אי אפשר לקשר להזמנה שלא נשלחה לספק');
    if (INVOICE_TYPES.includes(doc.doc_type) && await linkedElsewhere(order._id, doc._id)) {
      throw fail(409, 'ההזמנה כבר מקושרת לחשבונית אחרת');
    }
    doc.order_id = order._id;
    if (!doc.branch_id && !doc.is_general) doc.branch_id = order.branch_id;
    await doc.save();
    return { document: doc.toObject(), ...orderMismatch(doc, order), by: by || null };
  });
}

async function unlinkOrder(docId) {
  oid(docId, 'מזהה מסמך');
  return withLocks([`doc:${docId}`], async () => {
    const doc = await loadDoc(docId);
    if (!doc.order_id) throw fail(409, 'המסמך לא מקושר להזמנה');
    doc.order_id = null;
    await doc.save();
    return doc.toObject();
  });
}

module.exports = { LINKABLE_STATUSES, compareAmount, orderMismatch, orderCandidates, linkOrder, unlinkOrder };
