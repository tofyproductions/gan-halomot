/**
 * Expenses receipts — the lane of receipts waiting for their invoice, manual
 * attach, and the "this supplier's receipt IS the document" exemption
 * (port notes §5.5–§5.8, adapted: gan extracts no referenced invoice number
 * and never links automatically).
 *
 * `receiptsLane` and `invoiceCandidates` are pure reads. Every write here is
 * a person's click. Errors are `Error` with a Hebrew message and `status`.
 */
const mongoose = require('mongoose');
const { BankTransaction, ExpenseDocument, ExpensePayment, Supplier } = require('../models');
const core = require('./expenseCore.service');
const { withLocks, atomically } = require('./expenseWrites.service');

const GRACE_DAYS = 14;
const LINKED_WINDOW_DAYS = 60;
const LOOKBACK_DAYS = 540;
const CANDIDATE_WINDOW_DAYS = 120;
const DAY = 86400000;

const fail = (status, message) => Object.assign(new Error(message), { status });
const oid = (v, what) => {
  if (!mongoose.isValidObjectId(v)) throw fail(400, `${what} לא תקין`);
  return String(v);
};

const ymdToDay = (ymd) => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / DAY);
const todayYmd = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
const shiftYmd = (ymd, days) => new Date((ymdToDay(ymd) + days) * DAY).toISOString().slice(0, 10);

// ── lane (pure read) ───────────────────────────────────────────────────────
async function receiptsLane(now = new Date()) {
  const today = todayYmd(now);
  const lookback = shiftYmd(today, -LOOKBACK_DAYS);
  const start = await core.getStartDate(); // nothing before the screen's start date is shown
  const docs = await ExpenseDocument.find({
    doc_type: 'receipt', status: 'active', doc_date: { $gte: start > lookback ? start : lookback },
  }).sort({ doc_date: 1, _id: 1 }).lean();
  if (!docs.length) return { waiting: [], overdue: [], linkedRecently: [], grace_days: GRACE_DAYS };

  const supplierIds = [...new Set(docs.filter(d => d.supplier_id).map(d => String(d.supplier_id)))];
  const linkedIds = [...new Set(docs.filter(d => d.linked_invoice_id).map(d => String(d.linked_invoice_id)))];
  const [suppliers, invoices, payments] = await Promise.all([
    supplierIds.length ? Supplier.find({ _id: { $in: supplierIds } }, 'receipt_is_document').lean() : [],
    linkedIds.length ? ExpenseDocument.find({ _id: { $in: linkedIds } }, 'vendor_name doc_number doc_date amount_total').lean() : [],
    ExpensePayment.find({ document_id: { $in: docs.map(d => d._id) } }).lean(),
  ]);
  const txs = payments.length
    ? await BankTransaction.find({ _id: { $in: payments.map(p => p.transaction_id) } }, 'date description').lean() : [];
  const supMap = new Map(suppliers.map(s => [String(s._id), s]));
  const invMap = new Map(invoices.map(i => [String(i._id), i]));
  const txMap = new Map(txs.map(t => [String(t._id), t]));

  const rows = docs
    .filter(d => core.isReceiptLike(d, d.supplier_id ? supMap.get(String(d.supplier_id)) : null))
    .map((d) => {
      const inv = d.linked_invoice_id ? invMap.get(String(d.linked_invoice_id)) : null;
      return {
        id: d._id, vendor_name: d.vendor_name, supplier_tax_id: d.supplier_tax_id, doc_number: d.doc_number,
        doc_date: d.doc_date, amount_total: d.amount_total, currency: d.currency,
        linked_invoice_id: d.linked_invoice_id || null,
        linked_invoice: inv ? { id: inv._id, vendor_name: inv.vendor_name, doc_number: inv.doc_number, doc_date: inv.doc_date, amount_total: inv.amount_total } : null,
        days_waiting: Math.max(0, ymdToDay(today) - ymdToDay(d.doc_date)),
        has_file: !!d.file_id || d.mail_sorter_id != null,
        payments: payments.filter(p => String(p.document_id) === String(d._id)).map((p) => {
          const t = txMap.get(String(p.transaction_id)) || {};
          return { transaction_id: p.transaction_id, amount: p.amount, date: t.date || '', description: t.description || '' };
        }),
      };
    });

  const waiting = rows.filter(r => !r.linked_invoice_id);
  return {
    waiting,
    overdue: waiting.filter(r => r.days_waiting >= GRACE_DAYS),
    linkedRecently: rows.filter(r => r.linked_invoice_id && r.doc_date >= shiftYmd(today, -LINKED_WINDOW_DAYS)),
    grace_days: GRACE_DAYS,
  };
}

// ── candidates (pure read) ─────────────────────────────────────────────────
async function loadReceipt(id, session) {
  oid(id, 'מזהה קבלה');
  const r = await ExpenseDocument.findById(id).session(session || null);
  if (!r || r.status === 'void') throw fail(404, 'הקבלה לא נמצאה');
  if (r.doc_type !== 'receipt') throw fail(400, 'המסמך אינו קבלה');
  return r;
}

async function invoiceCandidates(receiptId, limit = 8) {
  const r = (await loadReceipt(receiptId)).toObject();
  const rows = await ExpenseDocument.find({
    _id: { $ne: r._id }, status: 'active', doc_type: { $nin: ['receipt', 'credit_note'] },
    doc_date: { $gte: shiftYmd(r.doc_date, -CANDIDATE_WINDOW_DAYS), $lte: shiftYmd(r.doc_date, CANDIDATE_WINDOW_DAYS) },
  }).lean();
  const rKey = core.vendorKey(r.vendor_name);
  const tax = String(r.supplier_tax_id || '').trim();
  const out = [];
  for (const inv of rows) {
    const sameSupplier = (r.supplier_id && inv.supplier_id && String(r.supplier_id) === String(inv.supplier_id))
      || (tax && String(inv.supplier_tax_id || '').trim() === tax)
      || (rKey && core.vendorKey(inv.vendor_name) === rKey);
    const sameAmount = Math.abs((inv.amount_total || 0) - (r.amount_total || 0)) <= 1;
    const rank = (sameSupplier ? 2 : 0) + (sameAmount ? 1 : 0);
    if (!rank) continue;
    out.push({
      id: inv._id, vendor_name: inv.vendor_name, doc_number: inv.doc_number, doc_date: inv.doc_date,
      amount_total: inv.amount_total, doc_type: inv.doc_type, rank,
      gap_days: Math.abs(ymdToDay(inv.doc_date) - ymdToDay(r.doc_date)),
      why: [sameSupplier && 'אותו ספק', sameAmount && 'אותו סכום'].filter(Boolean).join(' · '),
    });
  }
  out.sort((a, b) => b.rank - a.rank || a.gap_days - b.gap_days || String(a.id).localeCompare(String(b.id)));
  return out.slice(0, limit);
}

// ── moving payments (port §5.7) ────────────────────────────────────────────
/** Inside an atomic scope. Both documents are locked by the caller. */
async function movePaymentsInScope(receiptId, invoiceId, by, { session, undo }) {
  const pays = await ExpensePayment.find({ document_id: receiptId }).session(session || null).lean();
  let moved = 0; let kept = 0;
  for (const p of pays) {
    const onInvoice = await ExpensePayment.exists({ document_id: invoiceId, transaction_id: p.transaction_id }).session(session || null);
    if (onInvoice) { kept++; continue; } // keep both — which one was right is a person's question
    await ExpensePayment.deleteOne({ _id: p._id }, { session });
    undo(() => ExpensePayment.create(p));
    const [created] = await ExpensePayment.create([{
      document_id: invoiceId, transaction_id: p.transaction_id, amount: p.amount, created_by: p.created_by || by || null,
    }], { session });
    undo(() => ExpensePayment.deleteOne({ _id: created._id }));
    moved++;
  }
  return { moved, kept };
}

async function lockKeysFor(receiptId, invoiceId) {
  const pays = await ExpensePayment.find({ document_id: receiptId }, 'transaction_id').lean();
  return [`doc:${receiptId}`, `doc:${invoiceId}`, ...pays.map(p => `tx:${p.transaction_id}`)];
}

async function linkReceipt(receiptId, invoiceId, by) {
  oid(receiptId, 'מזהה קבלה'); oid(invoiceId, 'מזהה חשבונית');
  if (String(receiptId) === String(invoiceId)) throw fail(400, 'אי אפשר לקשר קבלה לעצמה');
  const keys = await lockKeysFor(receiptId, invoiceId);
  return withLocks(keys, () => atomically(async (ctx) => {
    const { session, undo } = ctx;
    const receipt = await loadReceipt(receiptId, session);
    const invoice = await ExpenseDocument.findById(invoiceId).session(session || null);
    if (!invoice || invoice.status === 'void') throw fail(404, 'החשבונית לא נמצאה');
    if (invoice.doc_type === 'receipt') throw fail(400, 'אי אפשר לקשר קבלה לקבלה');
    if (invoice.doc_type === 'credit_note') throw fail(400, 'אי אפשר לקשר קבלה לזיכוי');

    const before = {
      linked_invoice_id: receipt.linked_invoice_id, receipt_disposition: receipt.receipt_disposition,
      receipt_disposition_at: receipt.receipt_disposition_at,
    };
    await ExpenseDocument.updateOne({ _id: receipt._id }, {
      $set: { linked_invoice_id: invoice._id, receipt_disposition: 'has_invoice', receipt_disposition_at: receipt.receipt_disposition_at || new Date() },
    }, { session });
    undo(() => ExpenseDocument.updateOne({ _id: receipt._id }, { $set: before }));
    const res = await movePaymentsInScope(receipt._id, invoice._id, by, ctx);
    return { ok: true, ...res };
  }, { document_id: receiptId }));
}

async function unlinkReceipt(receiptId) {
  oid(receiptId, 'מזהה קבלה');
  const r = await loadReceipt(receiptId);
  if (!r.linked_invoice_id) throw fail(409, 'הקבלה אינה מקושרת לחשבונית');
  // Payments already moved to the invoice stay there; "move back" is a person's call.
  await ExpenseDocument.updateOne({ _id: r._id }, { $set: { linked_invoice_id: null, receipt_disposition: null, receipt_disposition_at: null } });
  return { ok: true };
}

/** Receipts already linked whose payments still sit on the receipt (read-only). */
async function movePaymentsPlan() {
  const receipts = await ExpenseDocument.find({ doc_type: 'receipt', status: 'active', linked_invoice_id: { $ne: null } }, 'linked_invoice_id').lean();
  const plan = [];
  for (const r of receipts) {
    const pays = await ExpensePayment.find({ document_id: r._id }).lean();
    for (const p of pays) {
      const dup = await ExpensePayment.exists({ document_id: r.linked_invoice_id, transaction_id: p.transaction_id });
      plan.push({ receipt_id: r._id, invoice_id: r.linked_invoice_id, transaction_id: p.transaction_id, amount: p.amount, action: dup ? 'keep_both' : 'move' });
    }
  }
  return plan;
}

/** Moves every plan row; each receipt/invoice pair is its own locked atomic unit. */
async function applyMovePayments(by) {
  const receipts = await ExpenseDocument.find({ doc_type: 'receipt', status: 'active', linked_invoice_id: { $ne: null } }, 'linked_invoice_id').lean();
  let moved = 0; let kept = 0;
  for (const r of receipts) {
    const keys = await lockKeysFor(r._id, r.linked_invoice_id);
    const res = await withLocks(keys, () => atomically(async (ctx) => {
      const inv = await ExpenseDocument.findById(r.linked_invoice_id, 'status').session(ctx.session || null).lean();
      if (!inv || inv.status === 'void') return { moved: 0, kept: 0 };
      return movePaymentsInScope(r._id, r.linked_invoice_id, by, ctx);
    }, { document_id: r._id }));
    moved += res.moved; kept += res.kept;
  }
  return { moved, kept };
}

// ── exempt supplier / single receipt ───────────────────────────────────────
/** The supplier's receipt IS the document: its receipts leave the lane and become ordinary documents. */
async function setSupplierReceiptIsDocument(supplierId, value, by) { // eslint-disable-line no-unused-vars
  oid(supplierId, 'מזהה ספק');
  const s = await Supplier.findByIdAndUpdate(supplierId, { $set: { receipt_is_document: !!value } }, { new: true }).lean();
  if (!s) throw fail(404, 'הספק לא נמצא');
  return { ok: true, receipt_is_document: s.receipt_is_document };
}

async function markReceiptIsDocument(receiptId, by) { // eslint-disable-line no-unused-vars
  const r = await loadReceipt(receiptId);
  await ExpenseDocument.updateOne({ _id: r._id }, {
    $set: { receipt_disposition: 'is_document', receipt_disposition_at: new Date(), linked_invoice_id: null },
  });
  return { ok: true };
}

module.exports = {
  GRACE_DAYS, receiptsLane, invoiceCandidates, linkReceipt, unlinkReceipt,
  movePaymentsPlan, applyMovePayments, setSupplierReceiptIsDocument, markReceiptIsDocument,
};
