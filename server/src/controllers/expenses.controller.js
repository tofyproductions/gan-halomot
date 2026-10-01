'use strict';

/**
 * Expenses & documents — thin HTTP layer over the expense services. The
 * services own every rule and throw Error(<Hebrew message>) carrying `status`
 * (+ optional `code` / `existing_id`); `errorHandler` is the ONE place that
 * turns those into responses. Reads never write (rules are seeded at boot).
 */
const mongoose = require('mongoose');
const { BankTransaction, ExpenseDocument, Supplier, NoInvoiceRule, Setting, IcountPull, IcountPaidReport, IcountExpense } = require('../models');
const core = require('../services/expenseCore.service');
const pairs = require('../services/expensePairs.service');
const writes = require('../services/expenseWrites.service');
const receipts = require('../services/expenseReceipts.service');
const intake = require('../services/expenseIntake.service');
const orders = require('../services/expenseOrders.service');
const search = require('../services/expenseSearch.service');
const mailSorter = require('../services/mailSorter.service');
const { withJobLock } = require('../services/jobLock');
const { getClient } = require('../services/ganIcount.client');
const icountSuppliers = require('../services/icountSuppliers.service');
const bridge = require('../services/icountBridge.service');
const filing = require('../services/icountFiling.service');
const { ADMIN_VIEWER } = require('../constants/roles');
// The auth middleware serves a viewer's read as system_admin and keeps the truth in `actual_role`.
const isViewerReq = (req) => ((req.user && (req.user.actual_role || req.user.role)) === ADMIN_VIEWER);

const fail = (status, message) => Object.assign(new Error(message), { status });
const by = (req) => (req.user && (req.user.id || req.user._id)) || null;
const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

function checkId(v, what) {
  if (!mongoose.isValidObjectId(v)) throw fail(400, `${what} לא תקין`);
}

/** Express error middleware for the expenses router. */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (res.headersSent) return;
  const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 600 ? err.status : null;
  // 502/503 pass through only from the iCount services (they set a code and a
  // Hebrew message: THROTTLED / NOT_CONFIGURED → 503, iCount's own refusal → 502),
  // and 500 SAVE_FAILED (created in iCount, not saved here — the screen must
  // know, with the id). Any other 5xx stays the generic message.
  const passThrough = status && (status < 500 || ((status === 502 || status === 503) && err.code)
    || (status === 500 && err.code === 'SAVE_FAILED'));
  if (passThrough) {
    return res.status(status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.existing_id ? { existing_id: String(err.existing_id) } : {}),
      ...(Array.isArray(err.blockers) ? { blockers: err.blockers } : {}),
      ...(err.icount_id ? { icount_id: String(err.icount_id) } : {}),
      ...(err.existing && typeof err.existing === 'object' ? { existing: err.existing } : {}),
    });
  }
  console.error('[expenses] request failed:', req.method, req.originalUrl, err && err.stack || err);
  return res.status(500).json({ error: 'אירעה שגיאה בשרת, נסו שוב' });
}

// ── reads ──────────────────────────────────────────────────────────────────
/**
 * iCount standing of each document row, for the screens:
 * gone (left iCount) > filed (we put it there) > in_icount (linked or created from iCount) > not_in_icount.
 * `paid_reported` = we told iCount it was paid (an IcountPaidReport not undone).
 */
async function attachIcountInfo(docs) {
  const ids = docs.map(d => d._id).filter(Boolean);
  const reported = ids.length
    ? new Set((await IcountPaidReport.find({ document_id: { $in: ids }, undone_at: null }, 'document_id').lean()).map(r => String(r.document_id)))
    : new Set();
  for (const d of docs) {
    let status = 'not_in_icount';
    if (d.icount_gone_at) status = 'gone';
    else if (d.icount_filed_at) status = 'filed';
    else if (d.icount_id || d.source === 'icount') status = 'in_icount';
    d.icount = { status, docnum: d.icount_docnum || '', paid_reported: reported.has(String(d._id)) };
  }
  return docs;
}

async function pairQueue(req, res) {
  const q = await pairs.pairQueue();
  await attachIcountInfo([...q.pairs.map(p => p.doc), ...q.unmatchedDocs]);
  await orders.attachOrderInfo([...q.pairs.map(p => p.doc), ...q.unmatchedDocs]);
  res.json(q);
}

async function pairAlternatives(req, res) {
  const { document_id: docId, transaction_id: txId } = req.query;
  if (!docId === !txId) throw fail(400, 'יש לציין מסמך או תנועה (אחד מהם)');
  const list = docId ? await pairs.alternativesForDoc(String(docId)) : await pairs.alternativesForTx(String(txId));
  if (!list) throw fail(404, docId ? 'המסמך לא נמצא במסך ההתאמות' : 'התנועה לא נמצאה בין החיובים הפתוחים');
  res.json({ alternatives: list });
}

const receiptsLane = async (req, res) => res.json(await receipts.receiptsLane());

async function receiptCandidates(req, res) {
  res.json({ candidates: await receipts.invoiceCandidates(req.params.id) });
}

async function closed(req, res) {
  const docs = (await core.documentsWithState()).filter(d => d.lane === 'closed' || d.lane === 'unpaid_marked');
  // The closed tab lists each payment's charge (date, description, account),
  // so the person can see what closed the document before "✗ לא שייך".
  const txIds = [...new Set(docs.flatMap(d => d.payments.map(p => String(p.transaction_id))))];
  const txs = txIds.length
    ? await BankTransaction.find({ _id: { $in: txIds } }, 'date description counterparty transfer_note account_id')
      .populate('account_id', 'label type').lean()
    : [];
  const txMap = new Map(txs.map(t => [String(t._id), t]));
  for (const d of docs) {
    d.payments = d.payments.map((p) => {
      const t = txMap.get(String(p.transaction_id)) || {};
      const acc = t.account_id && typeof t.account_id === 'object' ? t.account_id : {};
      return {
        ...p, date: t.date || '', description: t.description || '', counterparty: t.counterparty || '',
        transfer_note: t.transfer_note || '', account_label: acc.label || '', account_type: acc.type || null,
      };
    });
  }
  await orders.attachOrderInfo(docs);
  await attachIcountInfo(docs);
  res.json({ documents: docs });
}

const searchAll = async (req, res) => res.json(await search.search(req.query));
const counts = async (req, res) => res.json(await search.counts());

async function getDocument(req, res) {
  checkId(req.params.id, 'מזהה מסמך');
  const doc = await ExpenseDocument.findById(req.params.id).lean();
  if (!doc) throw fail(404, 'המסמך לא נמצא');
  const [withState] = await core.withStates([doc]);
  res.json({ document: withState });
}

const INLINE = /^(application\/pdf|image\/(png|jpe?g|gif|webp))$/i;
const GENERIC_MIME = /^(|application\/octet-stream|binary\/octet-stream)$/i;

/** The real type from the first bytes, or null when they are not a known document. */
function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.slice(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (/^ftyp(heic|heix|mif1)$/.test(buf.slice(4, 12).toString('latin1'))) return 'image/heic';
  return null;
}

async function getFile(req, res) {
  const f = await intake.getFile(req.params.id);
  // mail-sorter always labels its bytes octet-stream, which makes browsers download.
  const declared = String(f.mime || '').split(';')[0].trim().toLowerCase();
  const sniffed = sniffMime(f.buffer);
  const mime = sniffed && (GENERIC_MIME.test(declared) || sniffed !== declared) ? sniffed : (declared || 'application/octet-stream');
  const inline = INLINE.test(mime);
  const name = encodeURIComponent(f.name || 'document').replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  res.set({
    'Content-Type': mime,
    'Content-Length': f.buffer.length,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  res.end(f.buffer);
}

async function documentOrders(req, res) {
  res.json({ candidates: await orders.orderCandidates(req.params.id) });
}

async function listRules(req, res) {
  res.json({ rules: await NoInvoiceRule.find().sort({ built_in: -1, created_at: 1, _id: 1 }).lean() });
}

async function suppliersMissingTaxId(req, res) {
  const ids = await ExpenseDocument.distinct('supplier_id', { status: 'active', supplier_id: { $ne: null } });
  const suppliers = await Supplier.find({
    _id: { $in: ids }, $or: [{ tax_id: '' }, { tax_id: null }, { tax_id: { $exists: false } }],
  }, 'name tax_id receipt_is_document').sort({ name: 1 }).lean();
  res.json({ suppliers });
}

/** Credit notes — a neutral list (never owed, never paired), shown in ⚙️ כלים. */
async function credits(req, res) {
  res.json({ documents: (await core.documentsWithState()).filter(d => d.lane === 'credit') });
}

const getStartDate = async (req, res) => res.json({ start_date: await core.getStartDate(), default: core.DEFAULT_START_DATE });
const putStartDate = async (req, res) => res.json({ start_date: await core.setStartDate(body(req).start_date) });

async function intakeStatus(req, res) {
  const [needsReview, last] = await Promise.all([
    ExpenseDocument.countDocuments({ status: 'active', needs_review: true }),
    ExpenseDocument.findOne({ source: 'mail_sorter' }).sort({ created_at: -1 }).select('created_at').lean(),
  ]);
  res.json({
    mail_sorter_configured: !!mailSorter.isConfigured(),
    needs_review: needsReview,
    last_pulled_at: last ? last.created_at : null,
  });
}

// ── iCount (reads) ─────────────────────────────────────────────────────────
// Booleans and timestamps only — never a credential, never iCount's raw reply.
async function icountStatus(req, res) {
  // `held_rows`: iCount rows the bridge did not turn into documents because an
  // active document already answers for them under another icount_id.
  const HELD = { match_kind: 'held', gone_at: null, is_storno: { $ne: true } };
  const [last, lastComplete, heldRows, heldTotal] = await Promise.all([
    IcountPull.findOne().sort({ started_at: -1 }).lean(),
    IcountPull.findOne({ complete: true }).sort({ started_at: -1 }).lean(),
    IcountExpense.find(HELD, 'icount_id supplier_name doc_number doc_date amount_total match_why matched_expense_id').sort({ doc_date: -1 }).limit(50).lean(),
    IcountExpense.countDocuments(HELD),
  ]);
  const st = getClient().status();
  res.json({
    configured: st.configured,
    logged_in: st.logged_in,
    last_pull: last ? {
      started_at: last.started_at, finished_at: last.finished_at, complete: last.complete,
      suppliers_total: last.suppliers_total, suppliers_read: last.suppliers_read,
      rows_seen: last.rows_seen, upserted: last.upserted, gone: last.gone, failed_suppliers: (last.failures || []).length,
      foreign: last.foreign || 0, gone_suppressed: last.gone_suppressed || null,
    } : null,
    last_complete_pull_at: lastComplete ? lastComplete.finished_at || lastComplete.started_at : null,
    held_rows: heldRows.map(r => ({
      icount_id: r.icount_id, supplier_name: r.supplier_name, doc_number: r.doc_number, doc_date: r.doc_date,
      amount_total: r.amount_total, why: r.match_why, document_id: r.matched_expense_id ? String(r.matched_expense_id) : null,
    })),
    held_total: heldTotal,
  });
}

const typeIdValue = (v) => {
  const n = Number(v);
  return v !== null && v !== '' && Number.isInteger(n) && n > 0 ? n : null;
};

async function getIcountSettings(req, res) {
  const row = await Setting.findOne({ key: filing.EXPENSE_TYPE_KEY }).lean();
  res.json({ expense_type_id: row ? typeIdValue(row.value) : null });
}

async function putIcountSettings(req, res) {
  const raw = body(req).expense_type_id;
  if (raw === null || raw === '') {
    await Setting.deleteOne({ key: filing.EXPENSE_TYPE_KEY });
    return res.json({ expense_type_id: null });
  }
  const n = typeIdValue(raw);
  if (n === null) throw fail(400, 'סוג ההוצאה באייקאונט חייב להיות מספר שלם חיובי');
  await Setting.findOneAndUpdate({ key: filing.EXPENSE_TYPE_KEY }, { $set: { value: n } }, { upsert: true });
  res.json({ expense_type_id: n });
}

/** Our suppliers behind active, not-yet-in-iCount documents that have no card in iCount — what Orly must open there. */
async function icountSuppliersMissing(req, res) {
  const client = getClient();
  if (!client.isConfigured()) throw Object.assign(fail(503, 'אייקאונט לא מחובר'), { code: 'NOT_CONFIGURED' });
  let list;
  try { list = await icountSuppliers.listSuppliers({ client }); } catch (e) { throw filingError(e); }
  if (!list.complete) throw Object.assign(fail(502, 'רשימת הספקים מאייקאונט לא נקראה במלואה — נסו שוב'), { code: 'ICOUNT_ERROR' });
  const docs = await ExpenseDocument.find({
    status: 'active', source: { $ne: 'icount' }, icount_id: null, supplier_id: { $ne: null },
  }, 'supplier_id vendor_name supplier_tax_id').lean();
  const seen = new Map();
  for (const d of docs) {
    const k = String(d.supplier_id);
    const e = seen.get(k) || { supplier_id: k, name: d.vendor_name || '', tax_id: d.supplier_tax_id || '', documents: 0 };
    e.documents += 1;
    seen.set(k, e);
  }
  const missing = [...seen.values()].filter(e => !icountSuppliers.resolveIn(list.suppliers, { tax_id: e.tax_id, name: e.name }));
  res.json({ suppliers: missing.sort((a, b) => a.name.localeCompare(b.name, 'he')) });
}

const identityQuestions = async (req, res) => res.json({ questions: await bridge.pendingIdentityQuestions() });
// A viewer sees the dry run without iCount being asked anything (no supplier read on their behalf).
const icountPreview = async (req, res) => res.json(await filing.previewFiling(req.params.id, {
  expense_type_id: req.query.expense_type_id, remote: !isViewerReq(req),
}));

/** Same status/code shape the filing service throws, for errors raised here. */
function filingError(e) {
  if (e && e.status) return e;
  if (e && (e.code === 'THROTTLED' || e.code === 'NOT_CONFIGURED')) return Object.assign(new Error(e.message), { status: 503, code: e.code });
  // iCount's own refusals carry code ICOUNT_ERROR; anything else is a network/internal failure — log it, show a fixed message.
  if (e && e.code === 'ICOUNT_ERROR') return Object.assign(new Error(e.message), { status: 502, code: 'ICOUNT_ERROR' });
  console.error('[expenses] iCount call failed:', (e && e.stack) || e);
  return Object.assign(new Error('אייקאונט לא ענה — נסו שוב מאוחר יותר'), { status: 502, code: 'ICOUNT_ERROR' });
}

// ── writes ─────────────────────────────────────────────────────────────────
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

async function createDocument(req, res) {
  const { fields, file } = body(req);
  if (fields !== undefined && !isObj(fields)) throw fail(400, 'שדות המסמך לא תקינים');
  if (file !== undefined && file !== null && !isObj(file)) throw fail(400, 'הקובץ לא תקין');
  const doc = await intake.createManual({ fields: fields || {}, file: file || null, by: by(req) });
  res.status(201).json({ document: doc });
}

async function patchDocument(req, res) {
  const b = body(req);
  if (b.fields !== undefined && !isObj(b.fields)) throw fail(400, 'שדות המסמך לא תקינים');
  res.json({ document: await intake.updateDocument(req.params.id, b.fields || b, by(req)) });
}

const voidDoc = async (req, res) => res.json({ document: await writes.voidDocument(req.params.id, by(req)) });
async function confirmDoc(req, res) {
  const b = body(req);
  if (b.fields !== undefined && !isObj(b.fields)) throw fail(400, 'שדות המסמך לא תקינים');
  res.json({ document: await writes.confirmDocument(req.params.id, b.fields || b, by(req)) });
}
const createSupplier = async (req, res) => res.status(201).json({ supplier: await intake.createSupplierFromDocument(req.params.id, by(req)) });

const acceptPair = async (req, res) => {
  const b = body(req);
  res.json(await writes.acceptPair({ document_id: b.document_id, transaction_id: b.transaction_id, amount: b.amount, review: b.review, by: by(req) }));
};
const rejectPair = async (req, res) => {
  const b = body(req);
  res.json(await writes.rejectPair({ document_id: b.document_id, transaction_id: b.transaction_id, by: by(req) }));
};
const unpair = async (req, res) => {
  const b = body(req);
  res.json(await writes.unpairCharge({ document_id: b.document_id, transaction_id: b.transaction_id, by: by(req) }));
};

const markUnpaid = async (req, res) => res.json(await writes.markUnpaid(req.params.id, by(req)));
const unmarkUnpaid = async (req, res) => res.json(await writes.unmarkUnpaid(req.params.id));
const decide = async (req, res) => res.json(await writes.decide(req.params.id, body(req).kind, body(req).note, by(req)));
const undecide = async (req, res) => res.json(await writes.undecide(req.params.id));

const linkReceipt = async (req, res) => res.json(await receipts.linkReceipt(req.params.id, body(req).invoice_id, by(req)));
const unlinkReceipt = async (req, res) => res.json(await receipts.unlinkReceipt(req.params.id));
const receiptIsDocument = async (req, res) => res.json(await receipts.markReceiptIsDocument(req.params.id, by(req)));
const supplierReceiptIsDocument = async (req, res) => {
  const value = body(req).value;
  if (typeof value !== 'boolean') throw fail(400, 'יש לציין true או false');
  res.json(await receipts.setSupplierReceiptIsDocument(req.params.id, value, by(req)));
};

const linkOrder = async (req, res) => res.json(await orders.linkOrder(req.params.id, body(req).order_id, by(req)));
const unlinkOrder = async (req, res) => res.json({ document: await orders.unlinkOrder(req.params.id) });

async function createRule(req, res) {
  const b = body(req);
  const pattern = String(b.pattern || '').trim();
  if (pattern.length < 2) throw fail(400, 'התבנית קצרה מדי');
  if (pattern.length > 100) throw fail(400, 'התבנית ארוכה מדי');
  const dup = await NoInvoiceRule.findOne({ pattern: { $regex: `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }).lean();
  if (dup) throw Object.assign(fail(409, 'כלל כזה כבר קיים'), { existing_id: dup._id });
  const rule = await NoInvoiceRule.create({
    label: String(b.label || '').trim() || pattern, pattern, note: String(b.note || '').trim(), built_in: false,
  });
  res.status(201).json({ rule: rule.toObject() });
}

async function deleteRule(req, res) {
  checkId(req.params.id, 'מזהה כלל');
  const rule = await NoInvoiceRule.findById(req.params.id).lean();
  if (!rule) throw fail(404, 'הכלל לא נמצא');
  if (rule.built_in) throw fail(400, 'אי אפשר למחוק כלל מובנה');
  await NoInvoiceRule.deleteOne({ _id: rule._id });
  res.json({ ok: true });
}

// Same lock as the 6-hour job (same name, same lease), so a click never overlaps a run.
const intakePull = async (req, res) => {
  if (!mailSorter.isConfigured()) throw fail(409, 'מיון המיילים לא מוגדר בשרת');
  const { ran, result } = await withJobLock('expense-mail-pull', 15 * 60 * 1000, () => intake.pullFromMailSorter({ full: req.query.full === '1' }));
  if (!ran) throw fail(409, 'משיכה כבר רצה');
  res.json(result);
};

// Same lock name as the daily job: a click never overlaps a run.
const ICOUNT_LOCK = 'icount-mirror';
const ICOUNT_LOCK_LEASE_MS = 60 * 60 * 1000;
const runIcountPull = () => withJobLock(ICOUNT_LOCK, ICOUNT_LOCK_LEASE_MS, () => bridge.pullAndSync());

async function icountPull(req, res) {
  if (!getClient().isConfigured()) throw Object.assign(fail(503, 'אייקאונט לא מחובר'), { code: 'NOT_CONFIGURED' });
  const { ran, result } = await runIcountPull();
  if (!ran) throw fail(409, 'משיכה כבר רצה');
  res.json(result);
}

async function icountIdentity(req, res) {
  const b = body(req);
  if (typeof b.same !== 'boolean') throw fail(400, 'יש לציין same: true או false');
  res.json(await bridge.decideIdentity(b.document_id, b.icount_expense_id, b.same, by(req)));
}

const icountFile = async (req, res) => {
  const b = body(req);
  res.json(await filing.fileToIcount(req.params.id, {
    expense_type_id: b.expense_type_id, confirm_duplicate: b.confirm_duplicate === true, by: by(req),
  }));
};
const icountReportPaid = async (req, res) => res.json(await filing.reportPaid(req.params.id, { date: body(req).date, by: by(req) }));
const icountUndoPaid = async (req, res) => res.json(await filing.undoReportPaid(req.params.id, { by: by(req) }));

module.exports = {
  runIcountPull, ICOUNT_LOCK, ICOUNT_LOCK_LEASE_MS,
  icountStatus, getIcountSettings, putIcountSettings, icountSuppliersMissing, identityQuestions, icountPreview,
  icountPull, icountIdentity, icountFile, icountReportPaid, icountUndoPaid,
  errorHandler,
  pairQueue, pairAlternatives, receiptsLane, receiptCandidates, closed, searchAll, counts, getDocument, getFile,
  documentOrders, listRules, suppliersMissingTaxId, intakeStatus, credits, getStartDate, putStartDate,
  createDocument, patchDocument, voidDoc, confirmDoc, createSupplier, acceptPair, rejectPair, unpair,
  markUnpaid, unmarkUnpaid, decide, undecide, linkReceipt, unlinkReceipt, receiptIsDocument, supplierReceiptIsDocument,
  linkOrder, unlinkOrder, createRule, deleteRule, intakePull,
};
