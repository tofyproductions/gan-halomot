/**
 * Expenses search and tab counts (port notes §7, adapted to gan). Pure reads —
 * nothing here writes. Counts are derived from the same functions the tabs
 * use, so a badge can never disagree with its tab.
 *
 * Deviations from tofy: no date / kind / lane filters (the brief asks for
 * q, amount range and branch); a branch filter applies to documents only —
 * a bank charge has no branch, so with a branch selected `charges` is empty.
 */
const mongoose = require('mongoose');
const { BankTransaction, ExpensePayment } = require('../models');
const core = require('./expenseCore.service');
const pairs = require('./expensePairs.service');
const receipts = require('./expenseReceipts.service');
const noInvoiceRules = require('./noInvoiceRules.service');

const LIMIT = 200;
const fail = (status, message) => Object.assign(new Error(message), { status });

// Same normalisation as the matcher (בע"מ == בעמ). Falls back to the raw text
// when normalising erases it (e.g. q is only punctuation), so '.' never matches everything.
const norm = (s) => core.vendorKey(s) || String(s || '').trim().toLowerCase();
const haystack = (parts) => core.vendorKey(parts.filter(Boolean).join(' '));

function num(v, what) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw fail(400, `${what} חייב להיות מספר`);
  return n;
}

const refLabel = (ref) => {
  const m = /^inst:(\d+)\/(\d+)$/.exec(ref || '');
  if (m) return `תשלום ${m[1]} מתוך ${m[2]}`;
  return ref ? `אסמכתא ${ref}` : '';
};

/** `{ documents, charges }` — each capped at 200, newest first. */
async function search({ q, min, max, branch } = {}) {
  const lo = num(min, 'סכום מינימום');
  const hi = num(max, 'סכום מקסימום');
  if (branch && !mongoose.isValidObjectId(branch)) throw fail(400, 'מזהה סניף לא תקין');
  const needle = String(q || '').trim() ? norm(q) : '';
  const inAmount = (a) => (lo == null || a >= lo) && (hi == null || a <= hi); // inclusive, on |amount|

  const docs = (await core.documentsWithState()).filter((d) => {
    if (branch && String(d.branch_id || '') !== String(branch)) return false;
    if (!inAmount(Math.abs(d.amount_ils ?? d.amount_total ?? 0))) return false;
    return !needle || haystack([d.vendor_name, d.doc_number, d.supplier_tax_id]).includes(needle);
  });
  const documents = docs.slice(0, LIMIT).map(d => ({
    kind: d.doc_type === 'receipt' ? 'receipt' : 'invoice',
    key: String(d._id),
    title: d.vendor_name,
    subtitle: [d.doc_type === 'receipt' ? 'קבלה' : 'חשבונית', d.doc_number && `מס׳ ${d.doc_number}`,
      d.supplier_tax_id && `ח.פ ${d.supplier_tax_id}`].filter(Boolean).join(' · '),
    date: d.doc_date,
    amount: Math.abs(d.amount_ils ?? d.amount_total ?? 0),
    currency: d.amount_ils == null ? d.currency : 'ILS',
    lane: d.lane,
  }));

  let charges = [];
  if (!branch) {
    const txs = (await BankTransaction.find({ amount: { $lt: 0 } }).sort({ date: -1, _id: -1 })
      .populate('account_id', 'label type').lean())
      .filter((t) => {
        if (!inAmount(Math.abs(t.amount))) return false;
        return !needle || haystack([t.description, t.original_description, t.counterparty, t.transfer_note,
          t.provider_category, t.bank_ref]).includes(needle);
      })
      .slice(0, LIMIT);
    const linked = new Set(txs.length
      ? (await ExpensePayment.distinct('transaction_id', { transaction_id: { $in: txs.map(t => t._id) } })).map(String)
      : []);
    const rules = txs.length ? await noInvoiceRules.activeRules() : [];
    charges = txs.map((t) => {
      const acc = t.account_id && typeof t.account_id === 'object' ? t.account_id : {};
      let lane;
      if (linked.has(String(t._id))) lane = 'closed';
      else if (t.is_internal_transfer || t.matched_card_account_id) lane = null;
      else lane = noInvoiceRules.matchRule(t.description, rules) ? 'no_invoice' : 'pair';
      return {
        kind: acc.type === 'card' ? 'card' : 'bank',
        transaction_id: String(t._id),
        title: t.counterparty ? `אל: ${t.counterparty}` : t.description,
        subtitle: [acc.label, refLabel(t.bank_ref), t.transfer_note && `הערה: ${t.transfer_note}`,
          t.counterparty && t.description].filter(Boolean).join(' · '),
        date: t.date,
        amount: Math.abs(t.amount),
        currency: 'ILS',
        lane,
      };
    });
  }
  return { documents, charges };
}

/** Tab badges, one derivation each: pair = proposed pairs; the rest count documents by lane. */
async function counts(now = new Date()) {
  const [queue, docs, lane] = await Promise.all([pairs.pairQueue(), core.documentsWithState(), receipts.receiptsLane(now)]);
  const inLane = (l) => docs.filter(d => d.lane === l).length;
  return {
    pair: queue.pairs.length,
    review: inLane('review'),
    receipts: lane.waiting.length,
    overdue: lane.overdue.length,
    closed: inLane('closed'),
    unpaid_marked: inLane('unpaid_marked'),
  };
}

module.exports = { LIMIT, search, counts };
