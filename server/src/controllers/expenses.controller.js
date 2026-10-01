'use strict';

/**
 * Expenses & documents — thin HTTP layer over the expense services. The
 * services own every rule and throw Error(<Hebrew message>) carrying `status`
 * (+ optional `code` / `existing_id`); `errorHandler` is the ONE place that
 * turns those into responses. Reads never write (rules are seeded at boot).
 */
const mongoose = require('mongoose');
const { BankTransaction, ExpenseDocument, Supplier, NoInvoiceRule } = require('../models');
const core = require('../services/expenseCore.service');
const pairs = require('../services/expensePairs.service');
const writes = require('../services/expenseWrites.service');
const receipts = require('../services/expenseReceipts.service');
const intake = require('../services/expenseIntake.service');
const orders = require('../services/expenseOrders.service');
const search = require('../services/expenseSearch.service');
const mailSorter = require('../services/mailSorter.service');

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
  if (status && status < 500) {
    return res.status(status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.existing_id ? { existing_id: String(err.existing_id) } : {}),
    });
  }
  console.error('[expenses] request failed:', req.method, req.originalUrl, err && err.stack || err);
  return res.status(500).json({ error: 'אירעה שגיאה בשרת, נסו שוב' });
}

// ── reads ──────────────────────────────────────────────────────────────────
async function pairQueue(req, res) {
  const q = await pairs.pairQueue();
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
async function getFile(req, res) {
  const f = await intake.getFile(req.params.id);
  const mime = String(f.mime || 'application/octet-stream').toLowerCase();
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

const intakePull = async (req, res) => {
  if (!mailSorter.isConfigured()) throw fail(409, 'מיון המיילים לא מוגדר בשרת');
  res.json(await intake.pullFromMailSorter());
};

module.exports = {
  errorHandler,
  pairQueue, pairAlternatives, receiptsLane, receiptCandidates, closed, searchAll, counts, getDocument, getFile,
  documentOrders, listRules, suppliersMissingTaxId, intakeStatus,
  createDocument, patchDocument, voidDoc, confirmDoc, createSupplier, acceptPair, rejectPair, unpair,
  markUnpaid, unmarkUnpaid, decide, undecide, linkReceipt, unlinkReceipt, receiptIsDocument, supplierReceiptIsDocument,
  linkOrder, unlinkOrder, createRule, deleteRule, intakePull,
};
