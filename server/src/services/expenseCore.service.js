/**
 * Expenses core — the pieces every expenses screen is computed from.
 * Ported from tofy-friends (port notes §4 coverage/lanes, §6 no-invoice rules,
 * §9 identity). Design principle kept: everything displayed is computed on
 * read; only human decisions are stored (payments, decisions, unpaid marks).
 * Nothing here writes.
 *
 * gan differs from tofy: one document source (no iCount merge), no VAT split,
 * no withholding factor, and its own lane names (see `laneOf`).
 */
const mongoose = require('mongoose');
const {
  BankTransaction, ExpenseDocument, ExpensePayment, ExpenseDocDecision, ExpenseUnpaidMark, Supplier,
} = require('../models');
const noInvoiceRules = require('./noInvoiceRules.service');

// Rounding only — deliberately not wide enough to hide a withholding gap
// (port notes §4.1); a person closes that with "closed anyway".
const COVERAGE_TOLERANCE_ILS = 2;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Port notes §1.5 / §9.1 — tofy's vendorKey, verbatim. */
function vendorKey(name) {
  return String(name || '')
    .replace(/["'’״׳]/g, '')                              // quotes/geresh first, so בע"מ -> בעמ
    .replace(/(^|\s)(בעמ|ltd|inc|llc)(?=\s|$)/gi, ' ')     // legal suffixes, whitespace-anchored (Hebrew is not \w)
    .replace(/[-_.]/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

const digits = (v) => String(v || '').replace(/\D/g, '');

/**
 * The charges still waiting for a document: money out, not an internal
 * transfer (incl. a card's monthly settlement line in the bank — the card's
 * own purchases carry the invoices), settled, and not fully covered by
 * payments. Charges a no-invoice rule catches are returned in `exempt`,
 * never dropped.
 */
async function chargePool() {
  const txs = await BankTransaction.find({
    amount: { $lt: 0 },
    is_internal_transfer: { $ne: true },
    matched_card_account_id: null,
    status: 'completed',
  }).sort({ date: -1, _id: -1 }).populate('account_id', 'label type').lean();
  if (!txs.length) return { open: [], exempt: [] };

  const paidByTx = new Map();
  const links = await ExpensePayment.aggregate([
    { $match: { transaction_id: { $in: txs.map(t => t._id) } } },
    { $group: { _id: '$transaction_id', paid: { $sum: '$amount' } } },
  ]);
  for (const l of links) paidByTx.set(String(l._id), l.paid);

  const rules = await noInvoiceRules.activeRules();
  const open = [];
  const exempt = [];
  for (const t of txs) {
    const remaining = round2(Math.abs(t.amount) - (paidByTx.get(String(t._id)) || 0));
    if (remaining <= 0) continue;
    const account = t.account_id && typeof t.account_id === 'object' ? t.account_id : null;
    const out = {
      ...t,
      account_id: account ? account._id : t.account_id,
      account_label: account ? account.label : '',
      account_type: account ? account.type : null,
      remaining,
    };
    const rule = noInvoiceRules.matchRule(t.description, rules);
    if (rule) exempt.push({ tx: out, rule });
    else open.push(out);
  }
  return { open, exempt };
}

/** Shekel figure: ILS as-is; foreign only once the bank's shekel amount is confirmed (§4.2). */
function amountIls(doc) {
  if ((doc.currency || 'ILS') === 'ILS') return doc.amount_total ?? 0;
  return doc.fx_confirmed ? doc.amount_total : null;
}

/** A receipt waiting for its invoice — unless the supplier's receipt IS the document. */
function isReceiptLike(doc, supplier) {
  if (doc.doc_type !== 'receipt') return false;          // invoice_receipt is an invoice
  if (doc.receipt_disposition === 'is_document') return false;
  return !(supplier && supplier.receipt_is_document);
}

/**
 * Port notes §4.2, single source. Lanes in gan:
 *   review        machine-read fields nobody confirmed yet
 *   receipt       waiting receipt (see isReceiptLike)
 *   closed        covered within 2 ₪, or a closed_anyway / paid_outside_bank decision
 *   unpaid_marked shown in the closed tab, flagged "not paid yet"
 *   awaiting_fx   foreign currency without a confirmed shekel amount
 *   open          everything else (needs a charge, or partly paid)
 */
function computeState(doc, { payments = [], decision = null, marked = false, supplier = null } = {}) {
  const amount_ils = amountIls(doc);
  const paid = round2(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const remaining = amount_ils == null ? 0 : round2(amount_ils - paid);

  let state;
  if (amount_ils == null) state = 'awaiting_fx';           // first: no number to cover, even with money linked
  else if (decision) state = 'settled';
  else if (!payments.length) state = 'needs_match';
  else if (paid >= amount_ils - COVERAGE_TOLERANCE_ILS) state = 'settled';
  else state = 'partial';

  let lane;
  if (doc.needs_review) lane = 'review';
  else if (isReceiptLike(doc, supplier)) lane = 'receipt';
  else if (state === 'settled') lane = 'closed';
  else if (marked) lane = 'unpaid_marked';
  else if (state === 'awaiting_fx') lane = 'awaiting_fx';
  else lane = 'open';

  return {
    ...doc,
    amount_ils,
    paid,
    remaining,
    state,
    lane,
    payments,
    decision: decision ? { kind: decision.kind, note: decision.note || '' } : null,
    unpaid_marked: !!marked,
  };
}

const byDoc = (rows) => {
  const m = new Map();
  for (const r of rows) {
    const k = String(r.document_id);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};

async function withStates(docs) {
  if (!docs.length) return [];
  const ids = docs.map(d => d._id);
  const supplierIds = [...new Set(docs.filter(d => d.supplier_id).map(d => String(d.supplier_id)))];
  const [payments, decisions, marks, suppliers] = await Promise.all([
    ExpensePayment.find({ document_id: { $in: ids } }, 'document_id transaction_id amount').lean(),
    ExpenseDocDecision.find({ document_id: { $in: ids } }).lean(),
    ExpenseUnpaidMark.find({ document_id: { $in: ids } }, 'document_id').lean(),
    supplierIds.length ? Supplier.find({ _id: { $in: supplierIds } }, 'receipt_is_document').lean() : [],
  ]);
  const payMap = byDoc(payments);
  const decMap = new Map(decisions.map(d => [String(d.document_id), d]));
  const marked = new Set(marks.map(m => String(m.document_id)));
  const supMap = new Map(suppliers.map(s => [String(s._id), s]));
  return docs.map((d) => {
    const k = String(d._id);
    return computeState(d, {
      payments: (payMap.get(k) || []).map(p => ({ transaction_id: p.transaction_id, amount: p.amount })),
      decision: decMap.get(k) || null,
      marked: marked.has(k),
      supplier: d.supplier_id ? supMap.get(String(d.supplier_id)) || null : null,
    });
  });
}

/** Every active document with its computed paid / remaining / state / lane. */
async function documentsWithState() {
  const docs = await ExpenseDocument.find({ status: 'active' }).sort({ doc_date: -1, _id: -1 }).lean();
  return withStates(docs);
}

/**
 * Closed for filing purposes — the closed tab, which includes a document
 * marked "not paid yet" (that mark means "file it anyway"). Accepts a
 * document or its id.
 */
async function isClosed(docOrId) {
  const isId = typeof docOrId === 'string' || docOrId instanceof mongoose.Types.ObjectId;
  const doc = isId
    ? await ExpenseDocument.findById(docOrId).lean()
    : (docOrId && typeof docOrId.toObject === 'function' ? docOrId.toObject() : docOrId);
  if (!doc || doc.status === 'void') return false;
  const [s] = await withStates([doc]);
  return s.lane === 'closed' || s.lane === 'unpaid_marked';
}

const sameId = (a, b) => a && b && String(a) === String(b);

/**
 * An existing active document this one would duplicate: same mail-sorter
 * item, same file (sha256), or same supplier + document number — supplier
 * judged by `supplier_id` when both have one, else by vendorKey of the name.
 */
async function findDuplicate({ mail_sorter_id, attachment_sha256, supplier_id, vendor_name, doc_number } = {}, excludeId) {
  const base = { status: 'active' };
  if (excludeId && mongoose.isValidObjectId(excludeId)) base._id = { $ne: excludeId };

  if (mail_sorter_id != null && mail_sorter_id !== '') {
    const hit = await ExpenseDocument.findOne({ ...base, mail_sorter_id }).lean();
    if (hit) return hit;
  }
  const sha = String(attachment_sha256 || '').trim();
  if (sha) {
    const hit = await ExpenseDocument.findOne({ ...base, attachment_sha256: sha }).lean();
    if (hit) return hit;
  }
  const number = String(doc_number || '').trim();
  if (!number) return null;
  const key = vendorKey(vendor_name);
  const candidates = await ExpenseDocument.find({ ...base, doc_number: number }).sort({ _id: 1 }).lean();
  return candidates.find((c) => {
    if (supplier_id && c.supplier_id) return sameId(supplier_id, c.supplier_id);
    return key && vendorKey(c.vendor_name) === key;
  }) || null;
}

/** The Supplier a document belongs to: tax id (digits only) first, then normalised name. Never creates. */
async function matchSupplier({ supplier_tax_id, vendor_name } = {}) {
  const tax = digits(supplier_tax_id);
  const key = vendorKey(vendor_name);
  if (!tax && !key) return null;
  const suppliers = await Supplier.find({ is_active: { $ne: false } }, 'name tax_id receipt_is_document').sort({ _id: 1 }).lean();
  if (tax) {
    const hit = suppliers.find(s => digits(s.tax_id) === tax);
    if (hit) return hit;
  }
  return (key && suppliers.find(s => vendorKey(s.name) === key)) || null;
}

module.exports = {
  COVERAGE_TOLERANCE_ILS,
  vendorKey,
  chargePool,
  computeState,
  documentsWithState,
  isClosed,
  findDuplicate,
  matchSupplier,
};
