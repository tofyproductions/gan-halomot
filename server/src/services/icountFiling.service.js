/**
 * Filing a closed expense document to iCount, and telling iCount it was paid
 * (spec §4-§5; port notes §7-§9 are binding).
 *
 * iCount is the gan's audited books and has NO undo — a wrong document there
 * can only be reversed by a credit note. So:
 *
 *  - every refusal happens before any network write, in a fixed order;
 *  - right before creating, iCount is searched live for the same supplier +
 *    printed number; a hit is ADOPTED (our document takes its icount_id) and
 *    nothing is created. A search we could not read to the end stops the
 *    filing: absence cannot be proven from half a list;
 *  - /expense/create gets exactly seven fields. Never payments (they would
 *    replace the bookkeeper's), never VAT (the gan does not reclaim it),
 *    never a description or a scan;
 *  - report-paid sends only expense_paid + expense_paid_date, and is recorded
 *    only after iCount accepted it.
 *
 * Errors: Error with a Hebrew message, `status` and `code`.
 */
const mongoose = require('mongoose');
const { ExpenseDocument, BankTransaction, IcountExpense, IcountPaidReport, Setting, Supplier } = require('../models');
const core = require('./expenseCore.service');
const { withLocks } = require('./expenseWrites.service');
const { compareToIcount, linkToRow } = require('./icountBridge.service');
const { mapExpenseRow } = require('./icountMirror.service');
const { METHODS, fetchPaged, listSuppliers, resolveIn } = require('./icountSuppliers.service');
const { getClient } = require('./ganIcount.client');

const EXPENSE_TYPE_KEY = 'icount_expense_type_id';
const DOCTYPE_BY_KIND = Object.freeze({
  tax_invoice: 'invoice', invoice_receipt: 'invrec', receipt: 'receipt', credit_note: 'refund', other: 'other',
});

const MSG = Object.freeze({
  supplierListIncomplete: 'רשימת הספקים מאייקאונט לא נקראה במלואה — נסו שוב',
  supplierMissing: 'הספק לא קיים באייקאונט — אורלי צריכה לפתוח אותו שם',
  notConnected: 'אייקאונט לא מחובר',
  typeUnset: 'סוג ההוצאה באייקאונט לא הוגדר (⚙️ כלים)',
  typeBad: 'סוג ההוצאה באייקאונט לא תקין',
  notClosed: 'אפשר להעלות לאייקאונט רק מלשונית "סגור" — שייכו חיוב או סמנו "עוד לא שולמה"',
  already: 'המסמך כבר באייקאונט',
  needsReview: 'הפרטים שנקראו מהמסמך עוד לא אושרו',
  sourceIcount: 'המסמך הזה נוצר מאייקאונט — הוא כבר שם',
});

const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/** iCount's own errors keep their code; THROTTLED / NOT_CONFIGURED are 503, everything else 502 with the reason verbatim. */
function fromIcount(e) {
  if (e && (e.code === 'THROTTLED' || e.code === 'NOT_CONFIGURED')) return fail(503, e.code, e.message);
  return fail(502, 'ICOUNT_ERROR', String((e && e.message) || 'שגיאה לא ידועה מאייקאונט'));
}

/** A positive integer, or null. */
function typeIdOf(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

/** The per-document override wins over the setting. → number | null (unset) | NaN (invalid) */
async function expenseTypeId(override) {
  const o = typeIdOf(override);
  if (o !== null) return o;
  const row = await Setting.findOne({ key: EXPENSE_TYPE_KEY }).lean();
  return typeIdOf(row && row.value);
}

/**
 * Every reason this document cannot be filed (spec §4, gan rules), as Hebrew
 * strings, most fundamental first. Pure.
 *
 * ctx.supplier          our Supplier (receipt rule of 2א)
 * ctx.expense_type_id   number | null | NaN
 * ctx.icount            omitted → iCount not consulted;
 *                       { configured, complete, supplier: {id,name}|null }
 */
function fileBlockers(doc, ctx = {}) {
  const out = [];
  const currency = doc.currency || 'ILS';
  const ils = currency === 'ILS';
  if (!ils && !doc.fx_confirmed) {
    out.push(`חשבונית ב-${currency}${doc.amount_original != null ? ` (${doc.amount_original})` : ''} — הזינו את הסכום בשקלים כפי שחויב בבנק`);
  }
  if (ils && !String(doc.supplier_tax_id || '').trim()) out.push('חסר מספר עוסק / ח.פ של הספק');
  if (!String(doc.doc_number || '').trim()) out.push('חסר מספר מסמך');
  if (!(Number(doc.amount_total) > 0)) out.push('הסכום לא תקין');
  if (!isYmd(doc.doc_date)) out.push('חסר תאריך מסמך');
  if (!DOCTYPE_BY_KIND[doc.doc_type]) out.push('סוג מסמך לא מוכר');
  else if (core.isReceiptLike(doc, ctx.supplier || null)) {
    out.push(doc.receipt_disposition === 'has_invoice'
      ? 'קבלה של חשבונית — מעלים את החשבונית עצמה'
      : 'קבלה שאינה המסמך — ממתינה לחשבונית שלה (או סמנו שהקבלה היא המסמך)');
  }
  if (ctx.expense_type_id === null || ctx.expense_type_id === undefined) out.push(MSG.typeUnset);
  else if (Number.isNaN(ctx.expense_type_id)) out.push(MSG.typeBad);

  const ic = ctx.icount;
  if (ic) {
    if (!ic.configured) out.push(MSG.notConnected);
    else if (!ic.complete) out.push(MSG.supplierListIncomplete);
    else if (!ic.supplier) {
      const who = [doc.vendor_name, doc.supplier_tax_id && `ח.פ ${doc.supplier_tax_id}`].filter(Boolean).join(', ');
      out.push(who ? `${MSG.supplierMissing} (${who})` : MSG.supplierMissing);
    }
  }
  return out;
}

/** The exact /expense/create body (Global Constraints). Only called with no blockers. */
const payloadFor = (doc, supplierId, typeId) => ({
  supplier_id: String(supplierId),
  expense_type_id: typeId,
  expense_doctype: DOCTYPE_BY_KIND[doc.doc_type],
  expense_docnum: String(doc.doc_number).trim(),
  expense_sum: Number(doc.amount_total),
  expense_date: doc.doc_date,
  currency_code: 'ILS',
});

async function loadDoc(documentId) {
  if (!mongoose.isValidObjectId(documentId)) throw fail(404, 'NOT_FOUND', 'המסמך לא נמצא');
  const doc = await ExpenseDocument.findById(documentId).lean();
  if (!doc) throw fail(404, 'NOT_FOUND', 'המסמך לא נמצא');
  return doc;
}

const ourSupplier = (doc) => (doc.supplier_id ? Supplier.findById(doc.supplier_id, 'receipt_is_document').lean() : null);

/** Read iCount's supplier list and find this document's supplier there ({id,name,tax_id} | null). Errors propagate. */
async function icountSupplierFor(doc, client) {
  if (!client.isConfigured()) return { configured: false, complete: false, supplier: null };
  const { suppliers, complete } = await listSuppliers({ client });
  const hit = complete ? resolveIn(suppliers, { tax_id: doc.supplier_tax_id, name: doc.vendor_name }) : null;
  const supplier = hit ? suppliers.find(x => x.id === hit.id) || { ...hit, tax_id: '' } : null;
  return { configured: true, complete, supplier };
}

/** Gate failures as [{status, code, message}], in the filing order (404 excluded). */
async function gateFailures(doc) {
  const out = [];
  if (doc.icount_id || doc.icount_filed_at) out.push([409, 'ALREADY_FILED', MSG.already]);
  if (doc.needs_review) out.push([400, 'NEEDS_REVIEW', MSG.needsReview]);
  if (doc.source === 'icount') out.push([400, 'SOURCE_ICOUNT', MSG.sourceIcount]);
  if (!(await core.isClosed(doc))) out.push([409, 'NOT_CLOSED', MSG.notClosed]);
  return out.map(([status, code, message]) => ({ status, code, message }));
}

/**
 * Dry run: what would be sent, and to which iCount supplier. Reads the
 * supplier list only — never searches, never writes.
 * → { ok, blockers, payload|null, icount_supplier|null }
 */
async function previewFiling(documentId, { expense_type_id, client = getClient() } = {}) {
  const doc = await loadDoc(documentId);
  const gates = (await gateFailures(doc)).map(g => g.message);
  const typeId = await expenseTypeId(expense_type_id);
  let icount;
  try {
    icount = await icountSupplierFor(doc, client);
  } catch (e) {
    const err = fromIcount(e);
    icount = { configured: true, complete: false, supplier: null, error: err.message };
  }
  const blockers = [...gates, ...fileBlockers(doc, { supplier: await ourSupplier(doc), expense_type_id: typeId, icount })];
  if (icount.error) blockers.push(icount.error);
  const ready = blockers.length === 0;
  return {
    ok: ready,
    blockers,
    payload: ready ? payloadFor(doc, icount.supplier.id, typeId) : null,
    icount_supplier: icount.supplier ? { id: icount.supplier.id, name: icount.supplier.name } : null,
  };
}

/**
 * Port notes §6-§7 pre-create check: every iCount expense of that supplier
 * (no date filter). → { verdict: 'same_document'|'probable'|'different', row? }
 */
async function searchExisting(doc, icountSupplier, client) {
  const { rows, total, complete } = await fetchPaged(client, METHODS.search, { supplier_id: icountSupplier.id });
  if (!complete) {
    throw fail(502, 'ICOUNT_ERROR', `אייקאונט דיווח על ${total ?? 'יותר'} מסמכים לספק הזה ולא הצלחנו לקרוא את כולם — ההעלאה נעצרה`);
  }
  // The search is scoped to the resolved supplier, so both sides are that
  // supplier by construction; compareToIcount then decides on number, or on
  // amount + date for "probable".
  const sameSupplier = { supplier_tax_id: '', supplier_name: `#${icountSupplier.id}` };
  let probable = null;
  for (const raw of rows) {
    const m = mapExpenseRow(raw);
    if (m.is_storno || !m.icount_id) continue;
    const v = compareToIcount({ ...doc, ...sameSupplier }, { ...m, ...sameSupplier });
    if (v === 'same_document') return { verdict: v, row: m };
    if (v === 'probable' && !probable) probable = m;
  }
  return probable ? { verdict: 'probable', row: probable } : { verdict: 'different' };
}

/** "Already in iCount": our document takes the existing icount_id. Nothing is created. */
async function adopt(doc, icountId, by) {
  const row = await IcountExpense.findOne({ icount_id: icountId }).lean();
  try {
    if (row) {
      // Merges away an iCount-sourced twin the bridge may have created from that row.
      await linkToRow(row, doc._id, by, 'כבר היה באייקאונט');
    } else {
      const res = await ExpenseDocument.updateOne({ _id: doc._id, status: 'active', icount_id: null },
        { $set: { icount_id: icountId, icount_gone_at: null } });
      if (!res.modifiedCount) throw Object.assign(new Error('changed'), { status: 409 });
    }
  } catch (e) {
    if (e.code === 11000 || e.status === 409) {
      throw fail(409, 'ALREADY_FILED', 'המסמך כבר קיים באייקאונט ומקושר למסמך אחר כאן — בדקו כפילות');
    }
    throw e;
  }
  return { adopted: true, icount_id: icountId };
}

/**
 * File one document. Gates in order: 404, 409 ALREADY_FILED, 400 NEEDS_REVIEW,
 * 400 SOURCE_ICOUNT, 409 NOT_CLOSED, 400 BLOCKED (document), 503 NOT_CONFIGURED,
 * 400 BLOCKED (supplier), then the pre-create search (adopt / 409
 * PROBABLE_DUPLICATE unless confirm_duplicate), then create.
 * → { filed: true, icount_id } | { adopted: true, icount_id }
 */
async function fileToIcount(documentId, { expense_type_id, confirm_duplicate = false, by = null, client = getClient() } = {}) {
  const pre = await loadDoc(documentId);
  // Every iCount write for one document runs one at a time (a double click
  // must not create twice). Not the `doc:` key: adopting may merge a twin,
  // which takes that lock itself.
  return withLocks([`icount:${pre._id}`], async () => {
    const doc = await loadDoc(documentId);
    const [gate] = await gateFailures(doc);
    if (gate) throw fail(gate.status, gate.code, gate.message);

    const typeId = await expenseTypeId(expense_type_id);
    const supplier = await ourSupplier(doc);
    const local = fileBlockers(doc, { supplier, expense_type_id: typeId });
    if (local.length) throw fail(400, 'BLOCKED', local[0], { blockers: local });
    if (!client.isConfigured()) throw fail(503, 'NOT_CONFIGURED', MSG.notConnected);

    let icount;
    try { icount = await icountSupplierFor(doc, client); } catch (e) { throw fromIcount(e); }
    const remote = fileBlockers(doc, { supplier, expense_type_id: typeId, icount });
    if (remote.length) throw fail(400, 'BLOCKED', remote[0], { blockers: remote });

    let found;
    try { found = await searchExisting(doc, icount.supplier, client); } catch (e) { throw e.status ? e : fromIcount(e); }
    if (found.verdict === 'same_document') return adopt(doc, found.row.icount_id, by);
    if (found.verdict === 'probable' && confirm_duplicate !== true) {
      throw fail(409, 'PROBABLE_DUPLICATE',
        `ייתכן שהמסמך כבר באייקאונט (מסמך ${found.row.doc_number || found.row.icount_id}, ${found.row.amount_total} ₪, ${found.row.doc_date}) — אשרו שזה מסמך אחר`,
        { existing: { icount_id: found.row.icount_id, doc_number: found.row.doc_number, amount_total: found.row.amount_total, doc_date: found.row.doc_date } });
    }

    let resp;
    try {
      resp = await client.post(METHODS.create, payloadFor(doc, icount.supplier.id, typeId));
    } catch (e) { throw fromIcount(e); }
    if (!resp || !resp.status) {
      throw fail(502, 'ICOUNT_ERROR', String(resp?.reason ?? resp?.error_description ?? resp?.error ?? 'שגיאה לא ידועה מאייקאונט'));
    }

    // icount_id in the mirror's order (it must equal what the next pull calls this row);
    // icount_docnum in the port notes' order.
    const pick = (...vals) => { const v = vals.find(x => x !== undefined && x !== null && String(x).trim() !== ''); return v === undefined ? null : String(v); };
    const icountId = pick(resp.expense_id, resp.docnum, resp.id);
    const docnum = pick(resp.docnum, resp.expense_id, resp.id) || '';
    const set = { icount_docnum: docnum, icount_filed_at: new Date(), icount_filed_by: by || null };
    if (icountId) set.icount_id = icountId;
    let saved;
    try {
      saved = await ExpenseDocument.updateOne({ _id: doc._id, icount_id: null, icount_filed_at: null }, { $set: set });
    } catch (e) { saved = { modifiedCount: 0, error: e }; }
    if (!saved.modifiedCount) {
      // It IS in iCount now. Say so loudly; a retry's pre-create search adopts it.
      console.error('[icountFiling] created in iCount but not saved here', { document_id: String(doc._id), icount_id: icountId, error: saved.error && saved.error.message });
      throw fail(500, 'SAVE_FAILED', `המסמך נוצר באייקאונט (${icountId || 'בלי מספר'}) אבל לא נשמר כאן — אל תעלו אותו שוב; משכו מאייקאונט`, { icount_id: icountId });
    }
    const out = { filed: true, icount_id: icountId };
    if (!icountId) out.warning = 'אייקאונט קיבל את המסמך אבל לא החזיר מספר — המשיכה הבאה מאייקאונט תקשר אותו';
    return out;
  });
}

// ── report paid (port notes §8) ────────────────────────────────────────────

/**
 * Tell iCount the document was paid: expense_paid + expense_paid_date only.
 * Allowed only when bank charges cover it within 2 ₪ (no "closed anyway",
 * no "paid outside the bank") and it is in iCount. The date is the latest
 * linked charge's date unless one is given — never the day of the press.
 * → { reported: true, paid_date }
 */
async function reportPaid(documentId, { date, by = null, client = getClient() } = {}) {
  const pre = await loadDoc(documentId);
  return withLocks([`icount:${pre._id}`], async () => {
    const doc = await loadDoc(documentId);
    if (doc.status === 'void') throw fail(409, 'VOID', 'המסמך מבוטל');
    if (!doc.icount_id) throw fail(400, 'NOT_IN_ICOUNT', 'המסמך לא באייקאונט — אין מה לעדכן');
    if (doc.icount_gone_at) throw fail(409, 'ICOUNT_GONE', 'המסמך נמחק באייקאונט');
    const [s] = await core.withStates([doc]);
    if (!(s.state === 'settled' && !s.decision && s.payments.length > 0)) {
      throw fail(400, 'NOT_SETTLED', 'אפשר לעדכן ששולם רק כשחיובי הבנק מכסים את המסמך');
    }
    let paidDate = date;
    if (paidDate === undefined || paidDate === null || paidDate === '') {
      const txs = await BankTransaction.find({ _id: { $in: s.payments.map(p => p.transaction_id) } }, 'date').lean();
      paidDate = txs.map(t => String(t.date || '').slice(0, 10)).sort().slice(-1)[0];
    }
    if (!isYmd(paidDate) || Number.isNaN(Date.parse(paidDate))) {
      throw fail(400, 'BAD_DATE', 'תאריך התשלום חסר או לא תקין — זה תאריך החיוב בבנק, לא היום');
    }
    if (!client.isConfigured()) throw fail(503, 'NOT_CONFIGURED', MSG.notConnected);

    let resp;
    try {
      resp = await client.post(METHODS.update, { expense_id: doc.icount_id, expense_paid: 1, expense_paid_date: paidDate });
    } catch (e) { throw fromIcount(e); }
    if (!resp || !resp.status) throw fail(502, 'ICOUNT_ERROR', String(resp?.reason ?? resp?.error_description ?? resp?.error ?? 'שגיאה לא ידועה מאייקאונט'));

    // Only now: a row written before the call would claim a statement possibly never made.
    await IcountPaidReport.findOneAndUpdate(
      { document_id: doc._id },
      { $set: { icount_id: doc.icount_id, paid_date: paidDate, reported_by: by || null, reported_at: new Date() } },
      { upsert: true },
    );
    return { reported: true, paid_date: paidDate };
  });
}

/** A press of its own: iCount back to unpaid (expense_paid:0, no date), then the record goes. */
async function undoReportPaid(documentId, { client = getClient() } = {}) {
  const pre = await loadDoc(documentId);
  return withLocks([`icount:${pre._id}`], async () => {
    const report = await IcountPaidReport.findOne({ document_id: pre._id }).lean();
    if (!report) throw fail(400, 'NOT_REPORTED', 'לא דווח לאייקאונט ששולם');
    if (!client.isConfigured()) throw fail(503, 'NOT_CONFIGURED', MSG.notConnected);
    let resp;
    try {
      resp = await client.post(METHODS.update, { expense_id: report.icount_id, expense_paid: 0 });
    } catch (e) { throw fromIcount(e); }
    if (!resp || !resp.status) throw fail(502, 'ICOUNT_ERROR', String(resp?.reason ?? resp?.error_description ?? resp?.error ?? 'שגיאה לא ידועה מאייקאונט'));
    await IcountPaidReport.deleteOne({ _id: report._id });
    return { undone: true };
  });
}

module.exports = {
  EXPENSE_TYPE_KEY, DOCTYPE_BY_KIND, fileBlockers, previewFiling, fileToIcount, reportPaid, undoReportPaid,
};
