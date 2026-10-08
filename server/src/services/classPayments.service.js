/**
 * Class payments — the accounting side of מעקב חוגים.
 *
 * Three acts, all on one row per (branch, month, provider):
 *
 *   list     what the accountant sees next to the owed figures: paid or not,
 *            which invoice, and whether it already reached iCount;
 *   setPaid  the human marking "the money left" / "it did not";
 *   attach   the provider's invoice, uploaded HERE but stored THERE — an
 *            ExpenseDocument like every supplier document, so bank pairing
 *            and the iCount filing guards work on it unchanged.
 *
 * WHY THE UNPAID MARK IS SYNCED. iCount filing only accepts a document from
 * the closed lane, and an unpaid invoice is closed by the "עוד לא שולמה"
 * mark. The paid toggle here IS that knowledge, so it moves the mark: not
 * paid → mark up (fileable now), paid → mark down (the bank pairing takes
 * over in the expenses tab). Without the sync the accountant would say
 * "unpaid" twice in two screens, and one of them would be forgotten.
 *
 * Errors: Error with a Hebrew message and `status`.
 */
const mongoose = require('mongoose');
const { ClassPayment, ClassProvider, ExpenseDocument } = require('../models');
const intake = require('./expenseIntake.service');
const writes = require('./expenseWrites.service');

const fail = (status, message) => Object.assign(new Error(message), { status });
const isYm = (v) => /^\d{4}-\d{2}$/.test(String(v || ''));

/**
 * The same two shapes the payment summary groups by: a registered provider's
 * id, or 'name:<שם>' for the name-only instructor old programs still carry.
 */
function keyOf({ provider_id, provider_name }) {
  if (provider_id) {
    if (!mongoose.isValidObjectId(provider_id)) throw fail(400, 'מזהה ספק לא תקין');
    return String(provider_id);
  }
  const name = String(provider_name || '').trim();
  if (!name) throw fail(400, 'חסר ספק');
  return `name:${name}`;
}

function checkMonth(month) {
  if (!isYm(month)) throw fail(400, 'חודש לא תקין (YYYY-MM)');
}

function checkBranch(branch_id) {
  if (!mongoose.isValidObjectId(branch_id)) throw fail(400, 'מזהה סניף לא תקין');
}

// What the screen needs from the linked invoice — enough for the iCount
// dialog's preview and nothing it does not show.
const DOC_FIELDS = 'vendor_name supplier_tax_id doc_type doc_number doc_date amount_total currency amount_original fx_confirmed status icount_id icount_docnum file_id';

/** The month's rows within a branch filter, each with its live invoice (a voided one reads as none). */
async function listForMonth(branchFilter, month) {
  checkMonth(month);
  const rows = await ClassPayment.find({ ...branchFilter, month })
    .populate('expense_document_id', DOC_FIELDS)
    .lean();
  return rows.map((r) => {
    const doc = r.expense_document_id && r.expense_document_id.status !== 'void'
      ? r.expense_document_id : null;
    return { ...r, expense_document_id: doc ? doc._id : null, document: doc };
  });
}

/** Mark a provider's month paid / not paid. Upserts — the row exists the moment somebody has an opinion about it. */
async function setPaid({ branch_id, month, provider_id, provider_name, paid, by = null }) {
  checkMonth(month);
  checkBranch(branch_id);
  const provider_key = keyOf({ provider_id, provider_name });
  const isPaid = !!paid;
  const row = await ClassPayment.findOneAndUpdate(
    { branch_id, month, provider_key },
    {
      $set: {
        paid: isPaid,
        paid_at: isPaid ? new Date() : null,
        paid_by: isPaid ? by : null,
        provider_id: provider_id || null,
        provider_name: String(provider_name || '').trim(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  // Keep the expenses tab telling the same story (see the header). A voided
  // or deleted document must not block the toggle — the mark is advisory.
  if (row.expense_document_id) {
    try {
      if (isPaid) await writes.unmarkUnpaid(row.expense_document_id);
      else await writes.markUnpaid(row.expense_document_id, by);
    } catch { /* the toggle stands; the mark simply has nothing to sit on */ }
  }
  return row;
}

/**
 * Upload this month's invoice: one per provider per month, created through
 * the expenses intake (its duplicate/file/supplier rules apply verbatim).
 * An unpaid month's invoice is immediately marked "עוד לא שולמה" so it is
 * fileable to iCount without a detour through the expenses tab.
 */
async function attachInvoice({ branch_id, month, provider_id, provider_name, fields = {}, file, by = null }) {
  checkMonth(month);
  checkBranch(branch_id);
  const provider_key = keyOf({ provider_id, provider_name });
  if (!file) throw fail(400, 'חסר קובץ חשבונית');

  const existing = await ClassPayment.findOne({ branch_id, month, provider_key }).lean();
  if (existing && existing.expense_document_id) {
    const d = await ExpenseDocument.findById(existing.expense_document_id, 'status').lean();
    if (d && d.status !== 'void') {
      throw fail(409, 'כבר צורפה חשבונית לחודש הזה — אפשר לבטל אותה במסך הוצאות ולצרף אחרת');
    }
  }

  // The invoice is written in the PROVIDER's name, even when the screen
  // passed free text, so the expenses tab and iCount see the entity the
  // money actually goes to.
  let vendorName = String(provider_name || '').trim();
  if (provider_id) {
    const provider = await ClassProvider.findById(provider_id).lean();
    if (!provider) throw fail(404, 'הספק לא נמצא');
    vendorName = provider.name;
  }

  const DOC_TYPES = ['tax_invoice', 'invoice_receipt', 'receipt'];
  const doc = await intake.createManual({
    fields: {
      vendor_name: vendorName,
      doc_type: DOC_TYPES.includes(fields.doc_type) ? fields.doc_type : 'tax_invoice',
      doc_number: String(fields.doc_number || '').trim(),
      doc_date: fields.doc_date,
      amount_total: fields.amount_total,
      currency: 'ILS',
      branch_id,
      is_general: false,
    },
    file,
    by,
  });

  const row = await ClassPayment.findOneAndUpdate(
    { branch_id, month, provider_key },
    {
      $set: {
        expense_document_id: doc._id,
        provider_id: provider_id || null,
        provider_name: vendorName,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  if (!row.paid) await writes.markUnpaid(doc._id, by);

  return { payment: row, document: doc };
}

module.exports = { keyOf, listForMonth, setPaid, attachInvoice };
