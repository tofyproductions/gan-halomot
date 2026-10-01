/**
 * iCount bridge — joins the read-only mirror (IcountExpense) to our expense
 * documents, so the 2א engine sees every iCount expense as an ordinary
 * document (spec §3, port notes §5 + §6).
 *
 *   same_document (same supplier + same printed number) → our document gets
 *                 the icount_id. The ONLY certainty.
 *   probable      (same supplier, amount ±0.5, ≤3 days) → never merged by
 *                 itself: a monthly retainer is the same supplier and amount
 *                 every month. It is a question for a person
 *                 (`pendingIdentityQuestions` / `decideIdentity`).
 *   nothing       → an ExpenseDocument{source:'icount'} is created and pairs
 *                 like any other document (the bookkeeper typed it by hand).
 *
 * Rows that vanished from iCount (`gone_at`) or were cancelled there
 * (`is_storno`) never become documents; an iCount document already created
 * from one is voided when no money is linked, else kept and flagged
 * `icount_gone_at` (dropping it would silently reopen an answered charge).
 *
 * Writes that move money run under the same locks and atomic runner as
 * the person's clicks (expenseWrites).
 */
const mongoose = require('mongoose');
const {
  IcountExpense, ExpenseDocument, ExpensePayment, ExpenseIdentityDecision, ExpenseDocDecision, ExpenseUnpaidMark, IcountPaidReport,
} = require('../models');
const core = require('./expenseCore.service');
const { withLocks, atomically, voidDocument } = require('./expenseWrites.service');
const { trustedTaxId } = require('./icountSuppliers.service');
const { pullMirror } = require('./icountMirror.service');
const { getClient } = require('./ganIcount.client');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fail = (status, message) => Object.assign(new Error(message), { status });
const oid = (v, what) => { if (!mongoose.isValidObjectId(v)) throw fail(400, `${what} לא תקין`); return String(v); };

const WHY_SAME = 'אותו ספק ואותו מספר מסמך';
const WHY_PERSON = 'אושר ידנית: אותו מסמך';
const WHY_PROBABLE = 'אותו ספק, סכום ותאריך קרובים';
const WHY_HELD = 'מסמך פעיל אחר כבר מחזיק את המסמך הזה (מספר אייקאונט אחר) — לא נוצר מסמך כפול, בדקו ידנית';

// ── identity (port notes §6, exact) ────────────────────────────────────────
const docKey = (v) => String(v ?? '').replace(/[^0-9a-zA-Z]/g, '').replace(/^0+/, '').toLowerCase();
const nameOf = (v) => v.supplier_name || v.vendor_name || '';
const utcDay = (ymd) => {
  const t = Date.parse(`${String(ymd || '').slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? null : t / 86400000;
};

/**
 * ours/theirs: { supplier_tax_id, supplier_name|vendor_name, doc_number, amount_total, doc_date }
 * → 'same_document' | 'probable' | 'different'
 */
function compareToIcount(ours, theirs) {
  const ourTax = trustedTaxId(ours.supplier_tax_id);
  const theirTax = trustedTaxId(theirs.supplier_tax_id);
  const sameByTax = !!ourTax && ourTax === theirTax;
  // The name counts only when one side lacks a trusted ח.פ; two different ones are two companies.
  const ourName = core.vendorKey(nameOf(ours));
  const sameByName = !(ourTax && theirTax) && !!ourName && ourName === core.vendorKey(nameOf(theirs));
  const sameSupplier = sameByTax || sameByName;

  const ourDoc = docKey(ours.doc_number);
  if (sameSupplier && ourDoc && ourDoc === docKey(theirs.doc_number)) return 'same_document';
  if (!sameSupplier) return 'different'; // a bare doc number collides across suppliers

  const closeAmount = Math.abs((Number(ours.amount_total) || 0) - (Number(theirs.amount_total) || 0)) < 0.5;
  const a = utcDay(ours.doc_date);
  const b = utcDay(theirs.doc_date);
  return closeAmount && a !== null && b !== null && Math.abs(a - b) <= 3 ? 'probable' : 'different';
}

// Reverse of the filing map (Global Constraints). Empty or unknown → an invoice, the common case
// (ruling: `expense_doctype` is unverified on the real account — check on the first real pull).
// An import (customs) document is an invoice. Orders, delivery certificates and
// pay cheques are not expenses at all: null — they never become documents.
const DOC_TYPE_BY_ICOUNT = {
  invoice: 'tax_invoice', invrec: 'invoice_receipt', receipt: 'receipt', refund: 'credit_note', other: 'other', import: 'tax_invoice',
};
const NOT_A_DOCUMENT = new Set(['order', 'delcert', 'paycheck']);
const docTypeFor = (t) => {
  const k = String(t || '').trim().toLowerCase();
  if (NOT_A_DOCUMENT.has(k)) return null;
  return DOC_TYPE_BY_ICOUNT[k] || 'tax_invoice';
};

// An invoice, a receipt and a credit note with the same number are three documents
// (a mail receipt never becomes an iCount invoice's file, nor the reverse).
const kindOf = (t) => (t === 'receipt' || t === 'credit_note' ? t : 'invoice');
const kindsAgree = (a, b) => kindOf(a) === kindOf(b);

/** compareToIcount for one of our documents against a mirror row: a different kind is 'different'. */
function compareToRow(ours, row) {
  const theirType = docTypeFor(row.doctype);
  if (!theirType || !kindsAgree(ours.doc_type, theirType)) return 'different';
  return compareToIcount(ours, row);
}

// ── shared context ─────────────────────────────────────────────────────────
const pairKey = (docId, rowId) => `${docId}|${rowId}`;
const isDead = (r) => !!r.gone_at || !!r.is_storno;

/**
 * rows      mirror rows from the start date on
 * holders   icount_id → the ExpenseDocument carrying it (any status)
 * pool      our active, non-iCount documents not yet linked to any iCount row
 * verdict   (docId, rowId) → 'same' | 'different' | undefined
 */
async function loadContext() {
  const start = await core.getStartDate();
  const [rows, holders, pool, decisions] = await Promise.all([
    IcountExpense.find({ doc_date: { $gte: start } }).sort({ doc_date: 1, icount_id: 1 }).lean(),
    ExpenseDocument.find({ icount_id: { $type: 'string' } }).lean(),
    ExpenseDocument.find({
      status: 'active', source: { $ne: 'icount' }, icount_id: null,
      $or: [{ doc_date: { $gte: start } }, { doc_date: '' }, { doc_date: null }],
    }).sort({ _id: 1 }).lean(),
    ExpenseIdentityDecision.find({}, 'expense_id icount_expense_id verdict').lean(),
  ]);
  const verdicts = new Map(decisions.map(d => [pairKey(d.expense_id, d.icount_expense_id), d.verdict]));
  return {
    rows,
    holders: new Map(holders.map(d => [d.icount_id, d])),
    pool,
    verdict: (doc, row) => verdicts.get(pairKey(doc._id, row._id)),
  };
}

const rememberMatch = (row, docId, kind, why) => IcountExpense.updateOne({ _id: row._id },
  { $set: { matched_expense_id: docId, match_kind: kind, match_why: why } });

/**
 * Filing created this very row but its local save failed (icount_pending_id):
 * now that the document holds it, it is ours, filed — by the first filer, then.
 */
const claimPending = (docId, icountId) => ExpenseDocument.updateOne(
  { _id: docId, icount_id: icountId, icount_pending_id: icountId },
  [{ $set: {
    icount_filed_at: { $ifNull: ['$icount_filed_at', { $ifNull: ['$icount_pending_at', '$$NOW'] }] },
    icount_filed_by: { $ifNull: ['$icount_filed_by', '$icount_pending_by'] },
    icount_pending_id: null, icount_pending_by: null, icount_pending_at: null,
  } }],
);

/** Our document takes the row's icount_id when nothing else holds it. → true when linked. */
async function linkPlain(row, docId, why) {
  try {
    const res = await ExpenseDocument.updateOne({ _id: docId, status: 'active', icount_id: null },
      { $set: { icount_id: row.icount_id, icount_gone_at: null } });
    if (!res.modifiedCount) return false;
  } catch (e) {
    if (e.code === 11000) return false; // another document took this icount_id meanwhile
    throw e;
  }
  await claimPending(docId, row.icount_id);
  await rememberMatch(row, docId, 'same_document', why);
  return true;
}

/**
 * Our document becomes the row's document; the iCount-sourced twin created
 * earlier is voided and its payments move over. A charge already paying our
 * document too is not duplicated: our payment grows by the twin's amount
 * (both coexisted on that charge, so the sum fits within it) and the twin's
 * row goes — a void document holds no money. Receipts linked to the twin
 * follow, and so does the twin's file when ours has none.
 */
async function mergeIntoTwin(row, docId, twinId, by, why) {
  const twinPays = await ExpensePayment.find({ document_id: twinId }, 'transaction_id').lean();
  const keys = [`doc:${docId}`, `doc:${twinId}`, ...twinPays.map(p => `tx:${p.transaction_id}`)];
  const res = await withLocks(keys, () => atomically(async ({ session, undo }) => {
    const s = session || null;
    const doc = await ExpenseDocument.findById(docId).session(s).lean();
    const twin = await ExpenseDocument.findById(twinId).session(s).lean();
    if (!doc || doc.status === 'void') throw fail(409, 'המסמך מבוטל — אי אפשר לשנות אותו');
    if (doc.icount_id) throw fail(409, 'המסמך כבר מקושר למסמך אחר באייקאונט');
    if (!twin || twin.icount_id !== row.icount_id || twin.source !== 'icount') throw fail(409, 'מסמך האייקאונט השתנה — רעננו ונסו שוב');

    let moved = 0; let combined = 0;
    const pays = await ExpensePayment.find({ document_id: twinId }).session(s).lean();
    for (const p of pays) {
      await ExpensePayment.deleteOne({ _id: p._id }, { session });
      undo(() => ExpensePayment.create(p));
      const mine = await ExpensePayment.findOne({ document_id: docId, transaction_id: p.transaction_id }).session(s).lean();
      if (mine) {
        await ExpensePayment.updateOne({ _id: mine._id }, { $set: { amount: round2(mine.amount + p.amount) } }, { session });
        undo(() => ExpensePayment.updateOne({ _id: mine._id }, { $set: { amount: mine.amount } }));
        combined++;
        continue;
      }
      const [created] = await ExpensePayment.create([{
        document_id: docId, transaction_id: p.transaction_id, amount: p.amount, created_by: p.created_by || by || null,
      }], { session });
      undo(() => ExpensePayment.deleteOne({ _id: created._id }));
      moved++;
    }

    const receipts = await ExpenseDocument.find({ linked_invoice_id: twinId }, '_id').session(s).lean();
    if (receipts.length) {
      const ids = receipts.map(r => r._id);
      await ExpenseDocument.updateMany({ _id: { $in: ids } }, { $set: { linked_invoice_id: docId } }, { session });
      undo(() => ExpenseDocument.updateMany({ _id: { $in: ids } }, { $set: { linked_invoice_id: twinId } }));
    }

    // What a person recorded on the twin (closing decision, "not paid yet", paid
    // reported to iCount) follows it when our document has none of its own.
    // Each model is unique per document, so ours keeps its own when it has one.
    for (const Model of [ExpenseDocDecision, ExpenseUnpaidMark, IcountPaidReport]) {
      const theirs = await Model.findOne({ document_id: twinId }, '_id').session(s).lean();
      if (!theirs) continue;
      if (await Model.findOne({ document_id: docId }, '_id').session(s).lean()) continue;
      await Model.updateOne({ _id: theirs._id }, { $set: { document_id: docId } }, { session });
      undo(() => Model.updateOne({ _id: theirs._id }, { $set: { document_id: twinId } }));
    }

    // The twin's file (a mail item attached to it) moves to ours when ours has none.
    const takeFile = doc.mail_sorter_id == null && !doc.file_id && (twin.mail_sorter_id != null || twin.file_id);
    const fileSet = takeFile ? { mail_sorter_id: twin.mail_sorter_id ?? undefined, file_id: twin.file_id || null } : {};
    if (takeFile && !doc.attachment_sha256 && twin.attachment_sha256) fileSet.attachment_sha256 = twin.attachment_sha256;
    if (fileSet.mail_sorter_id === undefined) delete fileSet.mail_sorter_id;

    // Free the unique icount_id (and mail_sorter_id) first, then hand them to our document.
    const twinOff = { $set: { status: 'void', icount_id: null, ...(takeFile ? { file_id: null } : {}) } };
    if (takeFile && twin.mail_sorter_id != null) twinOff.$unset = { mail_sorter_id: 1 };
    await ExpenseDocument.updateOne({ _id: twinId }, twinOff, { session });
    undo(() => ExpenseDocument.updateOne({ _id: twinId }, { $set: {
      status: twin.status, icount_id: twin.icount_id, file_id: twin.file_id || null,
      ...(twin.mail_sorter_id != null ? { mail_sorter_id: twin.mail_sorter_id } : {}),
    } }));
    await ExpenseDocument.updateOne({ _id: docId }, { $set: { icount_id: row.icount_id, icount_gone_at: null, ...fileSet } }, { session });
    undo(() => ExpenseDocument.updateOne({ _id: docId }, {
      $set: { icount_id: null, icount_gone_at: doc.icount_gone_at ?? null, file_id: doc.file_id || null, attachment_sha256: doc.attachment_sha256 || '' },
      ...(takeFile && twin.mail_sorter_id != null ? { $unset: { mail_sorter_id: 1 } } : {}),
    }));
    return { moved, combined, voided_twin: String(twinId) };
  }, { document_id: docId }));
  await claimPending(docId, row.icount_id);
  await rememberMatch(row, docId, 'same_document', why);
  return res;
}

/** Links our document to the row, whatever currently holds the row's icount_id. */
async function linkToRow(row, docId, by, why) {
  const holder = await ExpenseDocument.findOne({ icount_id: row.icount_id }, 'source status').lean();
  if (holder && String(holder._id) === String(docId)) return { moved: 0, combined: 0 };
  if (holder && holder.source !== 'icount') throw fail(409, 'מסמך האייקאונט כבר מקושר למסמך אחר שלנו');
  if (holder) return mergeIntoTwin(row, docId, holder._id, by, why);
  if (!(await linkPlain(row, docId, why))) throw fail(409, 'המסמך כבר מקושר למסמך אחר באייקאונט');
  return { moved: 0, combined: 0 };
}

/** → the created document, or null (a doctype that is not a document, or another document took the icount_id). */
async function createFromRow(row) {
  const docType = docTypeFor(row.doctype);
  if (!docType) return null;
  const supplier = await core.matchSupplier({ supplier_tax_id: row.supplier_tax_id, vendor_name: row.supplier_name });
  // Ruling: Orly books a receipt in iCount only when it IS the document (exempt
  // supplier) — it pairs like one instead of waiting for an invoice.
  const receiptIsDocument = docType === 'receipt' ? { receipt_disposition: 'is_document', receipt_disposition_at: new Date() } : {};
  try {
    const created = await ExpenseDocument.create({
      source: 'icount',
      icount_id: row.icount_id,
      vendor_name: row.supplier_name || '',
      supplier_tax_id: row.supplier_tax_id || '',
      supplier_id: supplier ? supplier._id : null,
      doc_type: docType,
      ...receiptIsDocument,
      doc_number: row.doc_number || '',
      doc_date: row.doc_date,
      amount_total: Number(row.amount_total) || 0, // iCount's nis_sum: already shekels
      currency: 'ILS',
      fx_confirmed: true,
      needs_review: false,
    });
    if (row.matched_expense_id || row.match_kind) await rememberMatch(row, null, null, ''); // a stale probable / held mark
    return created.toObject();
  } catch (e) {
    if (e.code === 11000) return null;
    throw e;
  }
}

/** A row that left iCount (gone or cancelled) whose document is still active. → 'voided' | 'flagged' | null */
async function retireDocument(row, doc) {
  const at = row.gone_at || row.last_seen_at || new Date();
  const holdsFile = doc.mail_sorter_id != null || !!doc.file_id;
  if (doc.source !== 'icount' || holdsFile) {
    // Our own document, or an iCount one that got the mailed file, stays; it only loses its iCount standing.
    if (doc.icount_gone_at) return null;
    await ExpenseDocument.updateOne({ _id: doc._id }, { $set: { icount_gone_at: at } });
    return 'flagged';
  }
  return withLocks([`doc:${doc._id}`], async () => {
    const fresh = await ExpenseDocument.findById(doc._id, 'status icount_gone_at').lean();
    if (!fresh || fresh.status !== 'active') return null;
    if (await ExpensePayment.exists({ document_id: doc._id })) {
      if (fresh.icount_gone_at) return null;
      await ExpenseDocument.updateOne({ _id: doc._id }, { $set: { icount_gone_at: at } });
      return 'flagged';
    }
    // One write: a void without the bridge's mark could never come back.
    await voidDocument(doc._id, null, { set: { icount_gone_at: at, icount_voided_by_bridge: true } });
    return 'voided';
  });
}

/**
 * The row is back in iCount: undo what `retireDocument` did. Only the bridge's
 * own void comes back, never a person's. It re-links nothing else: the void
 * held no payments (that is why it was voided) and any receipt it released
 * stays released — the document comes back unpaid and pairs again like any other.
 */
async function restoreDocument(doc) {
  if (doc.status === 'active') {
    if (doc.icount_gone_at) await ExpenseDocument.updateOne({ _id: doc._id }, { $set: { icount_gone_at: null } });
    return false;
  }
  if (!doc.icount_voided_by_bridge) return false;
  const res = await ExpenseDocument.updateOne({ _id: doc._id, status: 'void', icount_voided_by_bridge: true },
    { $set: { status: 'active', icount_gone_at: null, icount_voided_by_bridge: false } });
  return res.modifiedCount === 1;
}

// ── the sync ───────────────────────────────────────────────────────────────
/**
 * Mirror → documents. Idempotent; run right after `pullMirror`.
 * → { linked, created, probable, held, skipped_doctype, voided, kept_gone, restored }
 *
 * `held`: a row an active document already answers for under ANOTHER
 * icount_id (filed by us under an id the mirror calls differently, or Orly
 * typed the same document twice). No second document is created — the row is
 * marked match_kind 'held' with that document, for a person to look at.
 */
async function syncBridge() {
  const result = { linked: 0, created: 0, probable: 0, held: 0, skipped_doctype: 0, voided: 0, kept_gone: 0, restored: 0 };
  const ctx = await loadContext();
  const taken = new Set();
  const free = (d) => !taken.has(String(d._id));
  // Active documents holding an icount_id, kept current as this sync links and creates.
  const holding = [...ctx.holders.values()].filter(d => d.status === 'active');
  const heldBy = (row) => holding.find(d => d.icount_id !== row.icount_id && compareToRow(d, row) === 'same_document');

  const waiting = [];
  const twinned = []; // rows already held by an iCount-sourced document
  for (const row of ctx.rows) {
    const holder = ctx.holders.get(row.icount_id);
    if (isDead(row)) {
      if (!holder || holder.status !== 'active') continue;
      const done = await retireDocument(row, holder);
      if (done === 'voided') result.voided++;
      else if (done === 'flagged') result.kept_gone++;
      continue;
    }
    if (!holder && !docTypeFor(row.doctype)) { result.skipped_doctype++; continue; }
    if (holder) {
      if (await restoreDocument(holder)) result.restored++;
      if (holder.source === 'icount' && holder.status === 'active') twinned.push({ row, twin: holder });
      continue;
    }
    waiting.push(row);
  }

  // Certain matches first, across all rows, so a linked document leaves the
  // pool before any other row could see it as merely "probable".
  const certainFor = (row) => ctx.pool.find(d => free(d) && ctx.verdict(d, row) !== 'different'
    && compareToRow(d, row) === 'same_document');
  const linked = (doc, row) => { taken.add(String(doc._id)); holding.push({ ...doc, icount_id: row.icount_id }); result.linked++; };
  const rest = [];
  for (const row of waiting) {
    const hit = certainFor(row);
    if (hit && await linkPlain(row, hit._id, WHY_SAME)) linked(hit, row); else rest.push(row);
  }
  // Our document arrived after the iCount one was created from the row: the same certainty merges them.
  for (const { row, twin } of twinned) {
    const hit = certainFor(row);
    if (!hit) continue;
    try {
      await mergeIntoTwin(row, hit._id, twin._id, null, WHY_SAME);
    } catch (e) {
      if (e.status !== 409) throw e;
      continue; // changed under us; the next sync sees the new state
    }
    linked(hit, row);
  }

  for (const row of rest) {
    const confirmed = ctx.pool.find(d => free(d) && ctx.verdict(d, row) === 'same');
    if (confirmed && await linkPlain(row, confirmed._id, WHY_PERSON)) { linked(confirmed, row); continue; }
    const holder = heldBy(row);
    if (holder) {
      if (row.match_kind !== 'held' || String(row.matched_expense_id) !== String(holder._id)) {
        await rememberMatch(row, holder._id, 'held', WHY_HELD);
      }
      result.held++;
      continue;
    }
    const twin = ctx.pool.find(d => free(d) && !ctx.verdict(d, row) && compareToRow(d, row) === 'probable');
    if (twin) {
      await rememberMatch(row, twin._id, 'probable', WHY_PROBABLE); // a question, not a merge
      continue;
    }
    const created = await createFromRow(row);
    if (created) { result.created++; holding.push(created); }
  }

  result.probable = (await pendingIdentityQuestions()).length;
  return result;
}

/**
 * "Is this the same document?" — computed on read, never stored. One per
 * iCount row not yet joined to one of our documents: its first probable twin
 * among our unlinked documents that nobody has answered for.
 * → [{ icount_expense, document, icount_document_id }]
 */
async function pendingIdentityQuestions() {
  const ctx = await loadContext();
  const out = [];
  for (const row of ctx.rows) {
    if (isDead(row)) continue;
    if (row.match_kind === 'held') continue; // "same" would link a second document to it
    const holder = ctx.holders.get(row.icount_id);
    if (holder && (holder.source !== 'icount' || holder.status !== 'active')) continue;
    const doc = ctx.pool.find(d => !ctx.verdict(d, row) && compareToRow(d, row) === 'probable');
    if (doc) out.push({ icount_expense: row, document: doc, icount_document_id: holder ? holder._id : null });
  }
  return out;
}

/**
 * A person's answer. `same` links our document to the iCount row (voiding the
 * iCount-sourced twin, payments moved); `different` is remembered so the
 * question does not come back and the row gets its own document next sync.
 */
async function decideIdentity(documentId, icountExpenseId, same, by = null) {
  oid(documentId, 'מזהה מסמך');
  oid(icountExpenseId, 'מזהה שורת אייקאונט');
  const [doc, row] = await Promise.all([
    ExpenseDocument.findById(documentId).lean(),
    IcountExpense.findById(icountExpenseId).lean(),
  ]);
  if (!row) throw fail(404, 'שורת האייקאונט לא נמצאה');
  if (!doc) throw fail(404, 'המסמך לא נמצא');
  if (doc.status === 'void') throw fail(409, 'המסמך מבוטל — אי אפשר לשנות אותו');
  if (doc.source === 'icount') throw fail(400, 'זה מסמך שנוצר מאייקאונט — בחרו את המסמך שלנו');
  if (same) {
    if (row.match_kind === 'held') throw fail(409, 'המסמך כבר מוחזק על ידי מסמך אחר');
    const theirType = docTypeFor(row.doctype);
    if (!theirType || !kindsAgree(doc.doc_type, theirType)) throw fail(400, 'סוג מסמך אחר (חשבונית / קבלה / זיכוי) — אלה לא אותו מסמך');
    if (compareToIcount(doc, row) === 'different') throw fail(400, 'ספק אחר או סכום/תאריך רחוקים — אלה לא אותו מסמך');
    if (doc.icount_id && doc.icount_id !== row.icount_id) throw fail(409, 'המסמך כבר מקושר למסמך אחר באייקאונט');
    const holder = await ExpenseDocument.findOne({ icount_id: row.icount_id }, 'source').lean();
    if (holder && holder.source !== 'icount' && String(holder._id) !== String(doc._id)) {
      throw fail(409, 'מסמך האייקאונט כבר מקושר למסמך אחר שלנו');
    }
  }

  const verdict = same ? 'same' : 'different';
  await ExpenseIdentityDecision.findOneAndUpdate(
    { expense_id: doc._id, icount_expense_id: row._id },
    { $set: { verdict, decided_by: by || null, decided_at: new Date() } },
    { upsert: true },
  );
  if (!same) {
    if (row.match_kind === 'probable' && String(row.matched_expense_id) === String(doc._id)) {
      await rememberMatch(row, null, null, '');
    }
    return { verdict };
  }
  const res = await linkToRow(row, doc._id, by, WHY_PERSON);
  return { verdict, moved: res.moved, combined: res.combined };
}

/**
 * An active iCount-sourced document still without a file that `data` (a mail
 * item) is certainly the same as, of the same kind. Looks among the same
 * supplier (supplier_id / ח.פ) first; the full scan covers a side without either.
 */
async function attachableIcountTwin(data) {
  if (!docKey(data.doc_number)) return null;
  const base = { status: 'active', source: 'icount', file_id: null, mail_sorter_id: null };
  const fits = (d) => kindsAgree(data.doc_type, d.doc_type) && compareToIcount(data, d) === 'same_document';
  const tax = trustedTaxId(data.supplier_tax_id);
  const near = [
    ...(data.supplier_id ? [{ supplier_id: data.supplier_id }] : []),
    ...(tax ? [{ supplier_tax_id: { $in: [tax, tax.replace(/^0+/, '')] } }] : []),
  ];
  if (near.length) {
    const hit = (await ExpenseDocument.find({ ...base, $or: near }).sort({ _id: 1 }).lean()).find(fits);
    if (hit) return hit;
  }
  return (await ExpenseDocument.find(base).sort({ _id: 1 }).lean()).find(fits) || null;
}

/** The daily job and the button: pull the mirror, then bridge it. */
async function pullAndSync({ client, ...opts } = {}) {
  const c = client || getClient();
  const pull = await pullMirror({ ...opts, client: c });
  if (!c.isConfigured()) return { pull, bridge: null };
  return { pull, bridge: await syncBridge() };
}

module.exports = {
  compareToIcount, compareToRow, docTypeFor, kindsAgree, linkToRow, syncBridge, pendingIdentityQuestions, decideIdentity, attachableIcountTwin, pullAndSync,
};
