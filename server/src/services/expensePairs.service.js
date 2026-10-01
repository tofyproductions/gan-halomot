/**
 * Expenses pair engine — proposes which bank charge paid which document.
 * Ported from tofy-friends (port notes §1 scoring, §2 pairQueue and
 * alternatives). Everything here is computed on read; nothing writes.
 *
 * gan differs from tofy: withholding factor OFF (the gan is VAT-exempt), one
 * document source keyed by `_id`, and the pool keeps a partly-used charge
 * with its `remaining` — so a charge is scored on what is left of it, and a
 * document on what it still owes.
 */
const mongoose = require('mongoose');
const { ExpensePairRejection, Supplier } = require('../models');
const core = require('./expenseCore.service');

const SUGGEST_THRESHOLD = 55;
const ALTERNATIVES_LIMIT = 5;
const DAY_MS = 86400000;

const WHY_FX = 'מטבע חוץ — חסר הסכום בשקלים שהבנק חייב';
const WHY_ALMOST_PAID = 'שולם כמעט במלואו — סגור ידנית או הוסף תנועה';
const WHY_NONE = 'לא נמצאה תנועה מתאימה';

/** Whole days from `b` to `a` (a − b), both YYYY-MM-DD, at UTC midnight. */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
}

// --- name similarity (port §1.5) — crude by design ---
const STOP = ['תשלום', 'העברה', 'חיוב', 'כרטיס', 'אשראי', 'בע', 'חשבון'];
const tokens = (s) => core.vendorKey(s).split(/\s+/).filter(w => w.length >= 3 && !STOP.includes(w));

/** Fraction of the VENDOR's tokens found in the bank text. */
function nameOverlap(vendor, description) {
  const a = tokens(vendor);
  if (!a.length) return 0;
  const b = new Set(tokens(description));
  const hits = a.filter(t => b.has(t) || [...b].some(x => x.includes(t) || t.includes(x))).length;
  return hits / a.length;
}

/** The charge's name text; `transfer_note` is deliberately not part of it (port §1.2). */
const txText = (tx) => [tx.description, tx.original_description, tx.counterparty].filter(Boolean).join(' ');

/** Port §1.4: the invoice number as a whole digit run (≥ 4 digits) in the transfer note. */
function docNumberInNote(docNumber, note) {
  const want = String(docNumber || '').replace(/\D/g, '');
  if (want.length < 4 || !note) return false;
  return (String(note).match(/\d+/g) || []).some(run =>
    run === want || run.replace(/^0+/, '') === want.replace(/^0+/, ''));
}

/** What the document still owes (the pair engine scores against this, port §1.2). */
const owedOf = (doc) => Number(doc.remaining ?? doc.amount_ils ?? doc.amount_total) || 0;
/** What is left of the charge to give. */
const paidOf = (tx) => (tx.remaining != null ? Number(tx.remaining) : Math.abs(Number(tx.amount) || 0));

/** Port §1.3 exactly, withholding OFF. Amount gates, date hard-stops, name corroborates. */
function scorePair(doc, tx) {
  const owed = owedOf(doc);
  const paid = paidOf(tx);
  const diff = Math.abs(paid - owed);
  const rel = owed > 0 ? diff / owed : 1;
  let score = 0;
  const reasons = [];

  if (diff <= 1) { score += 55; reasons.push('סכום זהה'); }
  else if (rel <= 0.05) { score += 30; reasons.push(`הפרש ${Math.round(diff)} ₪`); }
  else return { score: 0, reasons: [] };

  const gap = daysBetween(tx.date, doc.doc_date);
  if (!(gap >= -3 && gap <= 90)) return { score: 0, reasons: [] };   // also rejects an unreadable date
  if (gap <= 2) { score += 25; reasons.push('אותו יום'); }
  else if (gap <= 45) { score += 20; reasons.push(`שולם ${gap} ימים אחרי`); }
  else { score += 8; reasons.push(`שולם ${gap} ימים אחרי`); }

  const overlap = nameOverlap(doc.vendor_name, txText(tx));
  if (overlap >= 0.6) { score += 20; reasons.push('שם הספק מופיע בתנועה'); }
  else if (overlap > 0) { score += 8; reasons.push('שם דומה'); }

  return { score: Math.min(100, score), reasons };
}

/** scorePair + the doc-number bonus the pair engine adds on an agreeing amount (port §1.3 notes). */
function score(doc, tx) {
  const s = scorePair(doc, tx);
  if (s.score > 0 && docNumberInNote(doc.doc_number, tx.transfer_note)) {
    return { score: Math.min(100, s.score + 25), reasons: [...s.reasons, 'מספר החשבונית כתוב בהעברה'] };
  }
  return s;
}

/**
 * Port §1.6 — per-field verdicts so the screen never recomputes them.
 * tofy's same/close/diff are named ok/near/bad here; `none` = no signal.
 */
function compareFields(doc, tx) {
  const owed = owedOf(doc);
  const paid = paidOf(tx);
  const diff = Math.abs(paid - owed);
  const rel = owed > 0 ? diff / owed : 1;
  const amount = diff <= 1 ? 'ok' : (rel <= 0.05 || (paid < owed && rel <= 0.35)) ? 'near' : 'bad';
  const gap = daysBetween(tx.date, doc.doc_date);
  const date = (gap >= -2 && gap <= 2) ? 'ok' : (gap > 2 && gap <= 45) ? 'near' : 'bad';
  const overlap = nameOverlap(doc.vendor_name, txText(tx));
  const name = overlap >= 0.6 ? 'ok' : overlap > 0 ? 'near' : 'none';
  const ref = docNumberInNote(doc.doc_number, tx.transfer_note) ? 'ok' : 'none';
  return { amount, date, name, ref };
}

const key = (x) => String(x._id);
const rejKey = (docId, txId) => `${docId}|${txId}`;

async function rejectedSet() {
  const rows = await ExpensePairRejection.find({}, 'document_id transaction_id').lean();
  return new Set(rows.map(r => rejKey(r.document_id, r.transaction_id)));
}

/**
 * Documents the pair screen anchors on: lane `open`, plus lane `review` —
 * a machine-read document nobody confirmed is still proposed (the tofy trap:
 * anchoring on the charge made a confirmed invoice vanish). A review document
 * is kept only where it would be pairable without the review flag: not
 * settled, not marked unpaid, and not a waiting receipt.
 */
async function pairableDocs({ withFx = false } = {}) {
  const all = await core.documentsWithState();
  const reviewReceipts = all.filter(d => d.lane === 'review' && d.doc_type === 'receipt'
    && d.receipt_disposition !== 'is_document');
  const supIds = [...new Set(reviewReceipts.filter(d => d.supplier_id).map(d => String(d.supplier_id)))];
  const receiptIsDoc = new Set(supIds.length
    ? (await Supplier.find({ _id: { $in: supIds }, receipt_is_document: true }, '_id').lean()).map(s => String(s._id))
    : []);
  return all.filter((d) => {
    if (d.lane === 'open') return true;
    if (withFx && d.lane === 'awaiting_fx') return true;
    if (d.lane !== 'review') return false;
    if (d.state === 'settled' || d.unpaid_marked) return false;
    if (d.doc_type === 'receipt' && d.receipt_disposition !== 'is_document'
      && !(d.supplier_id && receiptIsDoc.has(String(d.supplier_id)))) return false;
    return true;
  });
}

const byNearerDate = (a, b) => Math.abs(daysBetween(a.tx.date, a.doc.doc_date)) - Math.abs(daysBetween(b.tx.date, b.doc.doc_date));

/** Port §2.2 — greedy global assignment: one proposal per document, each charge used once. */
async function pairQueue() {
  const [docs, pool, rejected] = await Promise.all([pairableDocs(), core.chargePool(), rejectedSet()]);
  const why = new Map();
  const scorable = docs.filter((d) => {
    if (d.amount_ils == null) { why.set(key(d), WHY_FX); return false; }
    if (d.remaining <= core.COVERAGE_TOLERANCE_ILS) { why.set(key(d), WHY_ALMOST_PAID); return false; }
    return true;
  });

  const cands = [];
  for (const doc of scorable) {
    for (const tx of pool.open) {
      if (rejected.has(rejKey(key(doc), key(tx)))) continue;
      const s = score(doc, tx);
      if (s.score >= SUGGEST_THRESHOLD) cands.push({ doc, tx, ...s });
    }
  }
  cands.sort((a, b) => b.score - a.score
    || byNearerDate(a, b)
    || key(a.doc).localeCompare(key(b.doc))
    || key(a.tx).localeCompare(key(b.tx)));

  const usedDoc = new Set();
  const usedTx = new Set();
  const out = [];
  for (const c of cands) {
    if (usedDoc.has(key(c.doc)) || usedTx.has(key(c.tx))) continue;
    usedDoc.add(key(c.doc));
    usedTx.add(key(c.tx));
    out.push({ ...c, fields: compareFields(c.doc, c.tx) });
  }
  out.sort((a, b) => b.score - a.score || String(b.doc.doc_date).localeCompare(String(a.doc.doc_date)));

  return {
    pairs: out,
    unmatchedDocs: docs.filter(d => !usedDoc.has(key(d))).map(d => ({ ...d, why: why.get(key(d)) || WHY_NONE })),
    unmatchedCharges: pool.open.filter(t => !usedTx.has(key(t))),
    exemptCharges: pool.exempt,
  };
}

/** Scored (any score > 0, no threshold) best first, then filled with nearest amounts within 90 days. */
function rankWithFill(items, scoreOf, distanceOf, dateGap, limit) {
  const scored = items.map(it => ({ it, ...scoreOf(it) })).filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score).slice(0, limit);
  if (scored.length < limit) {
    const picked = new Set(scored.map(x => x.it));
    const near = items.filter(it => !picked.has(it) && Math.abs(dateGap(it)) <= 90)
      .sort((a, b) => distanceOf(a) - distanceOf(b))
      .slice(0, limit - scored.length)
      .map(it => ({ it, score: 0, reasons: ['סכום קרוב'] }));
    scored.push(...near);
  }
  return scored;
}

/**
 * Port §2.4 — other charges for a document ("✗ לא זה"). Not de-duplicated
 * against pairQueue: the person is overriding. A foreign-currency document
 * without a shekel amount is offered charges by date and name only.
 * Returns null when the document is not on the pair screen.
 */
async function alternativesForDoc(docId, limit = ALTERNATIVES_LIMIT) {
  if (!mongoose.isValidObjectId(docId)) return null;
  const [docs, pool, rejected] = await Promise.all([pairableDocs({ withFx: true }), core.chargePool(), rejectedSet()]);
  const doc = docs.find(d => key(d) === String(docId));
  if (!doc) return null;
  const open = pool.open.filter(t => !rejected.has(rejKey(key(doc), key(t))));

  if (doc.amount_ils == null) {
    return open
      .map(tx => ({ tx, gap: daysBetween(tx.date, doc.doc_date), overlap: nameOverlap(doc.vendor_name, txText(tx)) }))
      .filter(x => x.gap >= -3 && x.gap <= 45)
      .sort((a, b) => b.overlap - a.overlap || Math.abs(a.gap) - Math.abs(b.gap))
      .slice(0, limit)
      .map(({ tx, gap, overlap }) => ({
        tx,
        score: 0,
        reasons: ['מטבע חוץ — הסכום בשקלים יילקח מהחיוב', gap <= 2 ? 'אותו יום' : `${gap} ימים אחרי`,
          ...(overlap > 0 ? ['שם דומה'] : [])],
        fields: {
          amount: 'near',
          date: gap <= 2 ? 'ok' : 'near',
          name: overlap >= 0.6 ? 'ok' : overlap > 0 ? 'near' : 'none',
          ref: docNumberInNote(doc.doc_number, tx.transfer_note) ? 'ok' : 'none',
        },
      }));
  }

  return rankWithFill(open, tx => score(doc, tx), tx => Math.abs(paidOf(tx) - doc.remaining),
    tx => daysBetween(tx.date, doc.doc_date), limit)
    .map(({ it: tx, score: s, reasons }) => ({ tx, score: s, reasons, fields: compareFields(doc, tx) }));
}

/**
 * Port §2.4 — which document is this charge ("איזו חשבונית זו?"). The charge
 * must be in the pool (not exempt, not fully linked). Returns null otherwise.
 */
async function alternativesForTx(txId, limit = ALTERNATIVES_LIMIT) {
  if (!mongoose.isValidObjectId(txId)) return null;
  const [docs, pool, rejected] = await Promise.all([pairableDocs(), core.chargePool(), rejectedSet()]);
  const tx = pool.open.find(t => key(t) === String(txId));
  if (!tx) return null;
  const cands = docs.filter(d => d.amount_ils != null && !rejected.has(rejKey(key(d), key(tx))));
  return rankWithFill(cands, doc => score(doc, tx), doc => Math.abs(doc.remaining - paidOf(tx)),
    doc => daysBetween(tx.date, doc.doc_date), limit)
    .map(({ it: doc, score: s, reasons }) => ({ doc, score: s, reasons, fields: compareFields(doc, tx) }));
}

module.exports = {
  SUGGEST_THRESHOLD,
  daysBetween,
  nameOverlap,
  docNumberInNote,
  scorePair,
  compareFields,
  pairQueue,
  alternativesForDoc,
  alternativesForTx,
};
