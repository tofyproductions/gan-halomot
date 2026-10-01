/**
 * Expenses intake — how a supplier document enters the system: typed by a
 * person (+ optional file), or copied from mail-sorter by the 6-hour job.
 *
 * What the job copies is what mail-sorter ALREADY read (`extracted`); nothing
 * is read here and nothing is paid for. mail-sorter files are never stored —
 * `getFile` pulls them on demand. Manual files live in ExpenseFile (<= 10 MB).
 *
 * Errors are `Error` with a Hebrew message and `status` (400/404/409);
 * a duplicate is 409 with `code:'DUPLICATE'` and `existing_id`.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const { ExpenseDocument, ExpenseFile, ExpensePayment, Supplier } = require('../models');
const core = require('./expenseCore.service');
const mailSorter = require('./mailSorter.service');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DOC_TYPES = ['tax_invoice', 'invoice_receipt', 'receipt', 'credit_note', 'other'];
const EDITABLE = ['supplier_id', 'vendor_name', 'supplier_tax_id', 'doc_type', 'doc_number', 'doc_date',
  'amount_total', 'currency', 'amount_original', 'branch_id', 'is_general', 'order_id'];
const FILE_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp'];
const ID_FIELDS = ['supplier_id', 'branch_id', 'order_id'];
// Fields that tag a document without correcting what was read from it.
const TAG_FIELDS = ['branch_id', 'is_general', 'order_id'];

const fail = (status, message, extra) => Object.assign(new Error(message), { status }, extra);
const str = (v) => String(v ?? '').trim();
const isIls = (c) => (c || 'ILS') === 'ILS';

function normCurrency(c) {
  const v = str(c).toUpperCase();
  if (!v || v === 'NIS' || v === '₪' || v === 'ILS') return 'ILS';
  return v;
}

function checkId(v, what) {
  if (!mongoose.isValidObjectId(v)) throw fail(400, `${what} לא תקין`);
}

const duplicateError = (hit) => fail(409, 'המסמך כבר קיים במערכת', { code: 'DUPLICATE', existing_id: String(hit._id) });

/**
 * Validates and normalises the whitelisted fields present in `src`.
 * Returns only what was given, so an update touches nothing else.
 */
function cleanFields(src) {
  const out = {};
  for (const k of EDITABLE) {
    if (src[k] === undefined) continue;
    let v = src[k];
    if (ID_FIELDS.includes(k)) {
      if (v === null || v === '') v = null; else checkId(v, 'מזהה');
    } else if (k === 'doc_type') {
      if (!DOC_TYPES.includes(v)) throw fail(400, 'סוג מסמך לא תקין');
    } else if (k === 'doc_date') {
      v = str(v);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw fail(400, 'תאריך מסמך לא תקין (YYYY-MM-DD)');
    } else if (k === 'amount_total') {
      v = Number(v);
      if (!Number.isFinite(v)) throw fail(400, 'סכום לא תקין');
    } else if (k === 'amount_original') {
      if (v === null || v === '') v = null;
      else { v = Number(v); if (!Number.isFinite(v)) throw fail(400, 'סכום מקורי לא תקין'); }
    } else if (k === 'currency') {
      v = normCurrency(v);
    } else if (k === 'is_general') {
      v = !!v;
    } else {
      v = str(v);
    }
    out[k] = v;
  }
  return out;
}

/**
 * Foreign-currency rule (kept simple): fx_confirmed is true only when the
 * person typed the shekel amount, i.e. `amount_original` came with the edit
 * (then `amount_total` IS the shekel figure). A foreign edit without
 * `amount_original` leaves the shekel amount unconfirmed, and the typed
 * number is kept as the original. ILS is always confirmed.
 */
function applyFx(patch, current) {
  const currency = patch.currency ?? current.currency ?? 'ILS';
  if (isIls(currency)) {
    patch.fx_confirmed = true;
    return;
  }
  const changed = patch.currency !== undefined && patch.currency !== (current.currency || 'ILS');
  if (!changed && patch.amount_total === undefined) return;
  if (patch.amount_original != null) {
    patch.fx_confirmed = true;
  } else {
    patch.fx_confirmed = false;
    const typed = patch.amount_total ?? current.amount_total;
    if (current.amount_original == null && typed) patch.amount_original = typed;
  }
}

function decodeFile(file) {
  const buf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data || ''), 'base64');
  if (!FILE_MIMES.includes(str(file.mime).toLowerCase())) throw fail(400, 'סוג קובץ לא נתמך (PDF או תמונה)');
  if (!buf.length) throw fail(400, 'הקובץ ריק');
  if (buf.length > MAX_FILE_BYTES) throw fail(400, 'הקובץ גדול מדי (עד 10MB)');
  return buf;
}

async function createManual({ fields = {}, file = null, by = null } = {}) {
  const data = cleanFields(fields);
  if (data.supplier_id) {
    const sup = await Supplier.findById(data.supplier_id).lean();
    if (!sup) throw fail(404, 'הספק לא נמצא');
    if (!data.vendor_name) data.vendor_name = sup.name;
    if (!data.supplier_tax_id) data.supplier_tax_id = sup.tax_id || '';
  } else {
    const match = await core.matchSupplier(data);
    if (match) data.supplier_id = match._id;
  }
  if (!data.vendor_name) throw fail(400, 'חסר שם ספק');
  if (data.doc_date === undefined || data.amount_total === undefined) throw fail(400, 'חסרים תאריך וסכום');
  if (data.currency === undefined) data.currency = 'ILS';
  applyFx(data, {});

  let buf = null;
  let sha = '';
  if (file) {
    buf = decodeFile(file);
    sha = crypto.createHash('sha256').update(buf).digest('hex');
  }
  const dup = await core.findDuplicate({ attachment_sha256: sha, supplier_id: data.supplier_id, vendor_name: data.vendor_name, doc_number: data.doc_number });
  if (dup) throw duplicateError(dup);

  let stored = null;
  if (buf) {
    stored = await ExpenseFile.create({ data: buf.toString('base64'), name: str(file.name), mime: str(file.mime), size: buf.length });
  }
  try {
    return await ExpenseDocument.create({
      ...data,
      source: 'manual',
      file_id: stored ? stored._id : null,
      attachment_sha256: sha,
      needs_review: false,
      created_by: by || null,
      confirmed_by: by || null,
      confirmed_at: new Date(),
    });
  } catch (e) {
    if (stored) await ExpenseFile.deleteOne({ _id: stored._id }).catch(() => {});
    throw e;
  }
}

/**
 * A document that already has money linked may not be edited out from under
 * it: its total may not drop below what is paid (2 ₪ rounding), and it may
 * not become a receipt or a credit note (neither is paired with a charge).
 */
async function paymentsGuard(doc, patch) {
  if (patch.amount_total === undefined && patch.doc_type === undefined) return;
  const rows = await ExpensePayment.find({ document_id: doc._id }, 'amount').lean();
  if (!rows.length) return;
  const paid = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  if (patch.doc_type !== undefined && patch.doc_type !== doc.doc_type && ['receipt', 'credit_note'].includes(patch.doc_type)) {
    throw fail(409, 'למסמך משויכים חיובים — בטלו קודם את השיוך');
  }
  const next = { ...doc, ...patch };
  const ils = isIls(next.currency) || next.fx_confirmed ? Number(next.amount_total) : null;
  if (patch.amount_total !== undefined && ils != null && ils < paid - core.COVERAGE_TOLERANCE_ILS) {
    throw fail(409, `הסכום נמוך ממה שכבר שויך (${Math.round(paid * 100) / 100} ₪) — בטלו קודם את השיוך`);
  }
}

/** A person's edit also confirms a mail-sorter document (needs_review -> false). */
async function updateDocument(id, fields = {}, by = null) {
  checkId(id, 'מזהה מסמך');
  const doc = await ExpenseDocument.findById(id).lean();
  if (!doc) throw fail(404, 'המסמך לא נמצא');
  if (doc.status === 'void') throw fail(409, 'מסמך מבוטל לא ניתן לעריכה');
  const patch = cleanFields(fields);
  if (patch.supplier_id) {
    const sup = await Supplier.findById(patch.supplier_id).lean();
    if (!sup) throw fail(404, 'הספק לא נמצא');
  }
  const next = { ...doc, ...patch };
  const dup = await core.findDuplicate({
    supplier_id: next.supplier_id, vendor_name: next.vendor_name, doc_number: next.doc_number,
  }, id);
  if (dup) throw duplicateError(dup);
  applyFx(patch, doc);
  await paymentsGuard(doc, patch);
  // Tagging (branch / general / order) is not a check of the machine reading:
  // the owner sets the branch on mail-sorter documents before reviewing them.
  // Any other field is a correction and confirms the document.
  const keys = Object.keys(patch).filter(k => k !== 'fx_confirmed' || patch.fx_confirmed !== doc.fx_confirmed);
  const taggingOnly = keys.length > 0 && keys.every(k => TAG_FIELDS.includes(k));
  if (!taggingOnly) {
    patch.needs_review = false;
    patch.confirmed_by = by || null;
    patch.confirmed_at = new Date();
  }
  return ExpenseDocument.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true }).lean();
}

/** The "add supplier" click: never called by a job. */
async function createSupplierFromDocument(docId, by = null) {
  checkId(docId, 'מזהה מסמך');
  const doc = await ExpenseDocument.findById(docId).lean();
  if (!doc) throw fail(404, 'המסמך לא נמצא');
  if (doc.status === 'void') throw fail(409, 'המסמך מבוטל — אי אפשר לשנות אותו');
  if (doc.supplier_id) throw fail(409, 'למסמך כבר יש ספק');
  const name = str(doc.vendor_name);
  if (!name) throw fail(400, 'למסמך אין שם ספק');
  const existing = await core.matchSupplier({ supplier_tax_id: doc.supplier_tax_id, vendor_name: name });
  if (existing) throw fail(409, 'ספק כזה כבר קיים', { code: 'SUPPLIER_EXISTS', existing_id: String(existing._id) });
  const supplier = await Supplier.create({ name, tax_id: str(doc.supplier_tax_id) });
  await ExpenseDocument.updateOne({ _id: docId }, { $set: { supplier_id: supplier._id } });
  return supplier;
}

const KIND_TYPE = { invoice: 'tax_invoice', receipt: 'receipt' };

function mapItem(item, kind) {
  const x = item.extracted || {};
  const currency = normCurrency(x.currency);
  const amount = Number(x.amount_total);
  const hasAmount = Number.isFinite(amount);
  const out = {
    source: 'mail_sorter',
    mail_sorter_id: item.id,
    attachment_sha256: str(item.attachment_sha256),
    vendor_name: str(x.vendor_name),
    supplier_tax_id: str(x.supplier_tax_id),
    doc_type: DOC_TYPES.includes(x.doc_type) ? x.doc_type : KIND_TYPE[kind] || 'other',
    doc_number: str(x.doc_number),
    doc_date: /^\d{4}-\d{2}-\d{2}$/.test(str(x.doc_date)) ? str(x.doc_date) : '',
    currency,
    needs_review: true,
  };
  if (isIls(currency)) {
    out.amount_total = hasAmount ? amount : 0;
    out.fx_confirmed = true;
  } else {
    // The extracted figure is in the foreign currency; the shekel amount is
    // only known from the bank charge, so it stays 0 and unconfirmed.
    out.amount_original = hasAmount ? amount : null;
    out.amount_total = 0;
    out.fx_confirmed = false;
  }
  return out;
}

/**
 * Copies the not-yet-acknowledged invoices and receipts. Each item is acked
 * exactly once — when it is created, when its mail_sorter_id already exists,
 * or when it is skipped (duplicate, or dated before the start date) — and
 * then drops off mail-sorter's list (asked WITHOUT `all=1`).
 */
async function pullFromMailSorter({ client = mailSorter } = {}) {
  const result = { fetched: 0, created: 0, skipped: 0, skipped_old: 0, errors: 0 };
  const start = await core.getStartDate();
  for (const kind of ['invoice', 'receipt']) {
    let list;
    try {
      const raw = await client.listDocuments(kind, { all: false });
      list = Array.isArray(raw) ? raw : (raw && raw.items) || [];
    } catch (e) {
      console.error(`[expense-pull] list ${kind} failed:`, e.message);
      result.errors++;
      continue;
    }
    for (const item of list) {
      result.fetched++;
      try {
        if (!item || item.id == null || item.id === '') throw new Error('פריט בלי מזהה');
        // No status filter: a void document keeps its mail_sorter_id, and the
        // item must not come back to life. It is only listed again if an
        // earlier ack failed, so acking it here recovers that.
        if (await ExpenseDocument.exists({ mail_sorter_id: item.id })) {
          result.skipped++;
          await client.ack(item.id);
          continue;
        }
        const data = mapItem(item, kind);
        if (core.beforeStart(data.doc_date, start)) {
          result.skipped_old++;
          await client.ack(item.id);
          continue;
        }
        const supplier = await core.matchSupplier(data);
        if (supplier) data.supplier_id = supplier._id;
        // Already represented by another active document: acked so it drops off the list.
        if (await core.findDuplicate(data)) {
          result.skipped++;
          await client.ack(item.id);
          continue;
        }
        await ExpenseDocument.create(data);
        result.created++;
        await client.ack(item.id);
      } catch (e) {
        console.error(`[expense-pull] item ${item && item.id} failed:`, e.message);
        result.errors++;
      }
    }
  }
  return result;
}

async function getFile(docId, { client = mailSorter } = {}) {
  checkId(docId, 'מזהה מסמך');
  const doc = await ExpenseDocument.findById(docId).lean();
  if (!doc) throw fail(404, 'המסמך לא נמצא');
  if (doc.file_id) {
    const f = await ExpenseFile.findById(doc.file_id).lean();
    if (!f) throw fail(404, 'הקובץ לא נמצא');
    return { buffer: Buffer.from(f.data, 'base64'), name: f.name, mime: f.mime };
  }
  if (doc.mail_sorter_id != null) {
    const f = await client.fetchFile(doc.mail_sorter_id);
    return { buffer: f.buffer, name: f.filename, mime: f.mime };
  }
  throw fail(404, 'למסמך אין קובץ');
}

module.exports = { MAX_FILE_BYTES, createManual, updateDocument, createSupplierFromDocument, pullFromMailSorter, getFile };
