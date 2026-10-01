/**
 * Expenses writes — every one is a person's click (port notes §3). Nothing
 * here is called from a scan, a poll or a job.
 *
 * Atomicity: a write that touches several documents runs inside a Mongo
 * transaction when the connection is a replica set / mongos (production is
 * Atlas). On a standalone server (local dev, the in-memory test server)
 * transactions do not exist, so the same steps run as ordered writes, each
 * registering an undo, and a failure rolls the earlier steps back in reverse.
 * Both paths are tested.
 *
 * Errors are `Error` with a Hebrew message and `status` (400/404/409).
 */
const mongoose = require('mongoose');
const {
  BankTransaction, ExpenseDocument, ExpensePayment, ExpensePairRejection, ExpenseUnpaidMark, ExpenseDocDecision, Supplier,
} = require('../models');
const core = require('./expenseCore.service');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const fail = (status, message) => Object.assign(new Error(message), { status });

const oid = (v, what = 'מזהה') => {
  if (!mongoose.isValidObjectId(v)) throw fail(400, `${what} לא תקין`);
  return String(v);
};

// ── atomic runner ──────────────────────────────────────────────────────────
const txSupport = new WeakMap(); // connection client -> boolean
async function supportsTransactions() {
  const client = mongoose.connection.getClient();
  if (txSupport.has(client)) return txSupport.get(client);
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  const yes = !!(hello.setName || hello.msg === 'isdbgrid');
  txSupport.set(client, yes);
  return yes;
}

/**
 * work({ session, undo }) — pass `session` to every query (undefined on a
 * standalone server); call `undo(fn)` after each write that has an inverse.
 */
async function atomically(work, meta = {}) {
  if (await supportsTransactions()) {
    // The driver may re-run the callback on a transient error, so `work` must
    // start from scratch each time (it does: it only reads and writes).
    let result;
    await mongoose.connection.transaction(async (session) => { result = await work({ session, undo: () => {} }); });
    return result;
  }
  const undos = [];
  try {
    return await work({ session: undefined, undo: (fn) => undos.push(fn) });
  } catch (e) {
    for (const fn of undos.reverse()) {
      try { await fn(); } catch (ue) {
        e.rollbackFailed = true;
        console.error('[expenseWrites] rollback step failed', { document_id: meta.document_id, transaction_id: meta.transaction_id, error: ue && ue.message });
      }
    }
    throw e;
  }
}

// ── in-process keyed mutex ─────────────────────────────────────────────────
// Production runs a single Render instance, so serialising per charge and per
// document in-process closes the check-then-insert race (two accepts both
// seeing room on one charge). Keys are taken in sorted order: no deadlock.
const locks = new Map(); // key -> tail promise
async function withLocks(keys, fn) {
  const sorted = [...new Set(keys)].sort();
  const releases = [];
  try {
    for (const k of sorted) {
      const prev = locks.get(k) || Promise.resolve();
      let release;
      const mine = new Promise((r) => { release = r; });
      const tail = prev.then(() => mine);
      locks.set(k, tail);
      await prev;
      releases.push(() => { release(); if (locks.get(k) === tail) locks.delete(k); });
    }
    return await fn();
  } finally { releases.forEach(r => r()); }
}

// ── loaders ────────────────────────────────────────────────────────────────
async function activeDoc(id, session) {
  oid(id, 'מזהה מסמך');
  const doc = await ExpenseDocument.findById(id).session(session || null);
  if (!doc) throw fail(404, 'המסמך לא נמצא');
  if (doc.status === 'void') throw fail(409, 'המסמך מבוטל — אי אפשר לשנות אותו');
  return doc;
}

async function loadTx(id, session) {
  oid(id, 'מזהה תנועה');
  const tx = await BankTransaction.findById(id).session(session || null);
  if (!tx) throw fail(404, 'התנועה לא נמצאה');
  return tx;
}

async function paidOn(filter, session) {
  const rows = await ExpensePayment.find(filter, 'amount').session(session || null).lean();
  return round2(rows.reduce((s, r) => s + r.amount, 0));
}

// Fields a person may correct while accepting/confirming a machine reading.
const REVIEW_FIELDS = ['vendor_name', 'supplier_tax_id', 'doc_type', 'doc_number', 'doc_date', 'amount_total'];
const DOC_TYPES = ['tax_invoice', 'invoice_receipt', 'receipt', 'credit_note', 'other'];

function pickReview(review) {
  const patch = {};
  for (const k of REVIEW_FIELDS) {
    if (review && review[k] !== undefined && review[k] !== null) patch[k] = review[k];
  }
  if (patch.doc_type !== undefined && !DOC_TYPES.includes(patch.doc_type)) throw fail(400, 'סוג המסמך לא תקין');
  if (patch.amount_total !== undefined) {
    const n = Number(patch.amount_total);
    if (!Number.isFinite(n) || n < 0) throw fail(400, 'הסכום לא תקין');
    patch.amount_total = round2(n);
  }
  for (const k of ['vendor_name', 'supplier_tax_id', 'doc_number', 'doc_date']) {
    if (patch[k] !== undefined) patch[k] = String(patch[k]).trim();
  }
  if (patch.doc_date && !/^\d{4}-\d{2}-\d{2}$/.test(patch.doc_date)) throw fail(400, 'התאריך לא תקין');
  // Branch tagging may ride along with the review (null / '' clears it).
  if (review && review.branch_id !== undefined) {
    const b = review.branch_id;
    if (b === null || b === '') patch.branch_id = null;
    else if (mongoose.isValidObjectId(b)) patch.branch_id = String(b);
    else throw fail(400, 'מזהה סניף לא תקין');
  }
  if (review && review.is_general !== undefined && review.is_general !== null) {
    patch.is_general = !!review.is_general;
    if (patch.is_general) patch.branch_id = null;
  }
  return patch;
}

/** Apply `patch` to the document; registers the inverse. Returns the updated plain doc. */
async function patchDoc(doc, patch, { session, undo }) {
  const before = {};
  for (const k of Object.keys(patch)) before[k] = doc[k];
  const res = await ExpenseDocument.findOneAndUpdate(
    { _id: doc._id }, { $set: patch }, { new: true, runValidators: true, session },
  ).lean();
  undo(() => ExpenseDocument.updateOne({ _id: doc._id }, { $set: before }));
  return res;
}

async function receiptGuard(docLike) {
  const supplier = docLike.supplier_id ? await Supplier.findById(docLike.supplier_id, 'receipt_is_document').lean() : null;
  if (core.isReceiptLike(docLike, supplier)) {
    throw fail(409, 'קבלה לא משויכת לחיוב — היא ממתינה לחשבונית שלה');
  }
}

/**
 * Only a charge the pair screen would offer may be paired: not an internal
 * transfer, not a card's settlement line, settled, not exempt by a rule, and
 * not before the start date — the same `chargePool().open` the screen shows.
 */
async function poolGuard(tx) {
  const pool = await core.chargePool();
  const id = String(tx._id);
  if (pool.open.some(t => String(t._id) === id)) return;
  const ex = pool.exempt.find(e => String(e.tx._id) === id);
  if (ex) throw fail(409, `החיוב פטור מחשבונית לפי הכלל "${ex.rule.label}"`);
  if (tx.is_internal_transfer) throw fail(409, 'זו העברה פנימית — לא חיוב של ספק');
  if (tx.matched_card_account_id) throw fail(409, 'זו שורת החיוב החודשי של הכרטיס — שייכו את הקניות עצמן');
  if (tx.status !== 'completed') throw fail(409, 'החיוב עוד לא נקלט סופית בבנק');
  if (core.beforeStart(tx.date, await core.getStartDate())) throw fail(409, 'החיוב לפני תאריך ההתחלה של מסך ההוצאות');
  throw fail(409, 'החיוב לא נמצא בין החיובים הפתוחים');
}

// ── accept ─────────────────────────────────────────────────────────────────
/**
 * Port §3.1. Optional field corrections + confirmation + the payment, all or
 * nothing (a confirmed document with no charge, because the link was refused,
 * is the failure this prevents). The payment amount defaults to
 * min(document remaining, charge remaining) — never to the document alone.
 */
async function acceptPair({ document_id, transaction_id, amount, review, by } = {}) {
  oid(document_id, 'מזהה מסמך'); oid(transaction_id, 'מזהה תנועה');
  pickReview(review); // validate up front; `patch` itself is rebuilt inside the work
  if (amount !== undefined && amount !== null) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) throw fail(400, 'סכום השיוך חייב להיות גדול מאפס');
  }

  return withLocks([`tx:${transaction_id}`, `doc:${document_id}`], () => atomically(async (ctx) => {
    const { session, undo } = ctx;
    const patch = pickReview(review); // fresh each (re)try of a transaction
    if (session) await BankTransaction.updateOne({ _id: transaction_id }, { $inc: { pay_seq: 1 } }, { session });
    let doc = await activeDoc(document_id, session);
    const tx = await loadTx(transaction_id, session);
    await receiptGuard({ ...doc.toObject(), ...patch });
    if (!(tx.amount < 0)) throw fail(400, 'אפשר לשייך רק חיוב יוצא');
    const charge = Math.abs(tx.amount);

    if (await ExpensePayment.exists({ document_id, transaction_id }).session(session || null)) {
      throw fail(409, 'התנועה כבר משויכת למסמך הזה');
    }
    const chargeRemaining = round2(charge - await paidOn({ transaction_id }, session));
    if (chargeRemaining <= core.COVERAGE_TOLERANCE_ILS) throw fail(409, 'החיוב כבר מכוסה במלואו');
    await poolGuard(tx);
    if ({ ...doc.toObject(), ...patch }.doc_type === 'credit_note') throw fail(409, 'זיכוי לא משויך לחיוב');

    // A foreign document takes its shekel figure from the charge (what the
    // bank charged — never a conversion rate); that also confirms the figure.
    const foreignUnconfirmed = (doc.currency || 'ILS') !== 'ILS' && !doc.fx_confirmed;
    if (foreignUnconfirmed && patch.amount_total === undefined) patch.amount_total = round2(charge);
    if ((doc.currency || 'ILS') !== 'ILS' && patch.amount_total !== undefined) patch.fx_confirmed = true;

    if (doc.needs_review) {
      patch.needs_review = false;
      patch.confirmed_by = by || null;
      patch.confirmed_at = new Date();
    }
    const updated = Object.keys(patch).length ? await patchDoc(doc, patch, ctx) : doc.toObject();

    const paid = await paidOn({ document_id }, session);
    const docRemaining = round2(core.computeState(updated, { payments: [{ amount: paid }] }).remaining);
    let pay = amount !== undefined && amount !== null ? round2(amount) : Math.min(docRemaining, chargeRemaining);
    if (!(pay > 0)) throw fail(409, 'המסמך כבר מכוסה — אין מה לשייך');
    if (pay > chargeRemaining + core.COVERAGE_TOLERANCE_ILS) throw fail(409, 'הסכום גדול מיתרת החיוב');
    if (pay > docRemaining + core.COVERAGE_TOLERANCE_ILS) throw fail(409, 'הסכום גדול מיתרת המסמך');

    let payment;
    try {
      [payment] = await ExpensePayment.create([{ document_id, transaction_id, amount: pay, created_by: by || null }], { session });
    } catch (e) {
      if (e && e.code === 11000) throw fail(409, 'התנועה כבר משויכת למסמך הזה');
      throw e;
    }
    undo(() => ExpensePayment.deleteOne({ _id: payment._id }));
    return { payment: payment.toObject(), document: updated };
  }, { document_id, transaction_id }));
}

// ── reject / unpair ────────────────────────────────────────────────────────
const upsertRejection = (document_id, transaction_id, by, session) => ExpensePairRejection.updateOne(
  { document_id, transaction_id }, { $setOnInsert: { created_by: by || null } }, { upsert: true, session },
);

/** Port §3.2 — idempotent. */
async function rejectPair({ document_id, transaction_id, by } = {}) {
  await activeDoc(document_id);
  await loadTx(transaction_id);
  await upsertRejection(document_id, transaction_id, by);
  return { ok: true };
}

/**
 * Port §3.3 — remove the payment AND remember the rejection, so the pair
 * tab does not propose the same charge for the same document again at once.
 */
async function unpairCharge({ document_id, transaction_id, by } = {}) {
  oid(document_id, 'מזהה מסמך'); oid(transaction_id, 'מזהה תנועה');
  return atomically(async ({ session, undo }) => {
    await activeDoc(document_id, session);
    const pay = await ExpensePayment.findOneAndDelete({ document_id, transaction_id }, { session }).lean();
    if (!pay) throw fail(404, 'לא נמצא שיוך להסרה');
    undo(() => ExpensePayment.create(pay));
    const had = await ExpensePairRejection.exists({ document_id, transaction_id }).session(session || null);
    await upsertRejection(document_id, transaction_id, by, session);
    if (!had) undo(() => ExpensePairRejection.deleteOne({ document_id, transaction_id }));
    return { ok: true };
  }, { document_id, transaction_id });
}

// ── unpaid marks / decisions ───────────────────────────────────────────────
async function markUnpaid(document_id, by) {
  await activeDoc(document_id);
  await ExpenseUnpaidMark.updateOne({ document_id }, { $setOnInsert: { created_by: by || null } }, { upsert: true });
  return { ok: true };
}

async function unmarkUnpaid(document_id) {
  await activeDoc(document_id);
  await ExpenseUnpaidMark.deleteOne({ document_id });
  return { ok: true };
}

/** One decision per document; deciding again replaces it (port §3.5). */
async function decide(document_id, kind, note, by) {
  if (!['closed_anyway', 'paid_outside_bank'].includes(kind)) throw fail(400, 'סוג ההחלטה לא תקין');
  await activeDoc(document_id);
  await ExpenseDocDecision.updateOne(
    { document_id }, { $set: { kind, note: String(note || '').trim(), created_by: by || null } }, { upsert: true },
  );
  return { ok: true };
}

async function undecide(document_id) {
  await activeDoc(document_id);
  await ExpenseDocDecision.deleteOne({ document_id });
  return { ok: true };
}

// ── confirm / void ─────────────────────────────────────────────────────────
/** A person confirms a machine reading (optionally corrected) without pairing it. */
async function confirmDocument(document_id, fields, by) {
  const patch = pickReview(fields);
  const doc = await activeDoc(document_id);
  if ((doc.currency || 'ILS') !== 'ILS' && patch.amount_total !== undefined) patch.fx_confirmed = true;
  patch.needs_review = false;
  patch.confirmed_by = by || null;
  patch.confirmed_at = new Date();
  return ExpenseDocument.findOneAndUpdate({ _id: doc._id }, { $set: patch }, { new: true, runValidators: true }).lean();
}

/**
 * Void a document. Its payments go with it: a void document must not keep
 * covering a bank charge, or that charge would never reach the pool again.
 * Receipts linked to it are released back to the receipts lane.
 */
async function voidDocument(document_id, by) {
  oid(document_id, 'מזהה מסמך');
  return atomically(async ({ session, undo }) => {
    const doc = await activeDoc(document_id, session);
    const pays = await ExpensePayment.find({ document_id }).session(session || null).lean();
    await ExpensePayment.deleteMany({ document_id }, { session });
    if (pays.length) undo(() => ExpensePayment.insertMany(pays));
    // Receipts attached to this invoice go back to waiting for one.
    const receipts = await ExpenseDocument.find({ linked_invoice_id: doc._id }, 'linked_invoice_id receipt_disposition receipt_disposition_at')
      .session(session || null).lean();
    if (receipts.length) {
      await ExpenseDocument.updateMany({ _id: { $in: receipts.map(r => r._id) } },
        { $set: { linked_invoice_id: null, receipt_disposition: null, receipt_disposition_at: null } }, { session });
      undo(() => Promise.all(receipts.map(r => ExpenseDocument.updateOne({ _id: r._id }, {
        $set: { linked_invoice_id: r.linked_invoice_id, receipt_disposition: r.receipt_disposition ?? null, receipt_disposition_at: r.receipt_disposition_at ?? null },
      }))));
    }
    // Ruling (Task 3/4): our document linked to an iCount row lets go of it, so
    // the next sync gives that row its own document — Orly's entry still exists
    // and its charge must stay explained. An iCount-sourced document keeps its
    // icount_id: the bridge restores it if the row comes back.
    const release = doc.source !== 'icount' && doc.icount_id ? { icount_id: null, icount_id_released: doc.icount_id } : {};
    await ExpenseDocument.updateOne({ _id: doc._id }, { $set: { status: 'void', ...release } }, { session });
    undo(() => ExpenseDocument.updateOne({ _id: doc._id }, {
      $set: { status: 'active', ...(release.icount_id_released ? { icount_id: doc.icount_id, icount_id_released: doc.icount_id_released ?? null } : {}) },
    }));
    return { ok: true, removed_payments: pays.length, released_receipts: receipts.length };
  }, { document_id });
}

module.exports = {
  acceptPair, rejectPair, unpairCharge, markUnpaid, unmarkUnpaid, decide, undecide, confirmDocument, voidDocument,
  // shared with the receipts service so payment moves serialise against accepts
  withLocks, atomically,
};
