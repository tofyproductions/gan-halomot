'use strict';

/**
 * Income — thin HTTP layer over the income services (Kaplan bank attribution,
 * ClickTac debt report, Emunah settlement, "not parent income" rules). The
 * services own every rule and throw Error(<Hebrew message>) carrying `status`;
 * `errorHandler` is the ONE place that turns those into responses. Reads never
 * write (built-in rules are seeded at boot). Nothing here writes Collection /
 * Registration / ExternalEnrollment.
 */
const mongoose = require('mongoose');
const { IncomeRule } = require('../models');
const kaplan = require('../services/incomeKaplan.service');
const kaplanWrites = require('../services/incomeKaplanWrites.service');
const debt = require('../services/clicktacDebt.service');
const emunah = require('../services/emunahStatement.service');
const { getAcademicYears, normalizeYear } = require('../services/academic-year.service');

const fail = (status, message) => Object.assign(new Error(message), { status });
const by = (req) => (req.user && (req.user.id || req.user._id)) || null;
const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function checkId(v, what) {
  if (!mongoose.isValidObjectId(v)) throw fail(400, `${what} לא תקין`);
}

/** Base64 `file_data` → Buffer, capped at 10 MB decoded. */
function fileBuffer(b) {
  const data = typeof b.file_data === 'string' ? b.file_data.replace(/^data:[^;]*;base64,/, '').replace(/\s+/g, '') : '';
  if (!data) throw fail(400, 'לא נבחר קובץ');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw fail(400, 'הקובץ אינו תקין');
  if (Math.floor(data.length * 3 / 4) > MAX_FILE_BYTES) throw fail(400, 'הקובץ גדול מדי (עד 10MB)');
  return Buffer.from(data, 'base64');
}

function yearOf(req) {
  const y = req.query.year ? normalizeYear(req.query.year) : getAcademicYears().current.range;
  if (!/^\d{4}-\d{4}$/.test(y)) throw fail(400, 'שנת לימודים לא תקינה');
  return y;
}

/** Express error middleware for the income router. */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (res.headersSent) return;
  const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 500 ? err.status : null;
  if (status) return res.status(status).json({ error: err.message });
  console.error('[income] request failed:', req.method, req.originalUrl, err && err.stack || err);
  return res.status(500).json({ error: 'אירעה שגיאה בשרת, נסו שוב' });
}

// ── reads ──────────────────────────────────────────────────────────────────
const kaplanQueue = async (req, res) => res.json(await kaplan.incomeQueue());

async function kaplanAlternatives(req, res) {
  checkId(req.query.transaction_id, 'מזהה תנועה');
  const alternatives = await kaplan.alternativesForTx(req.query.transaction_id);
  if (alternatives === null) throw fail(404, 'ההעברה לא נמצאה בהעברות הפתוחות');
  res.json({ alternatives });
}

const kaplanReport = async (req, res) => {
  const year = yearOf(req);
  res.json({ academic_year: year, ...(await kaplanWrites.kaplanMonthReport(year)) });
};

const kaplanMatched = async (req, res) => {
  const year = yearOf(req);
  res.json({ academic_year: year, matched: await kaplanWrites.matchedTransfers(year) });
};

const kaplanHouseholds = async (req, res) => {
  const year = yearOf(req);
  res.json({ academic_year: year, households: await kaplan.kaplanHouseholds(year) });
};

async function clicktacSummary(req, res) {
  const q = {};
  if (req.query.branch_id) { checkId(req.query.branch_id, 'מזהה סניף'); q.branch_id = req.query.branch_id; }
  if (req.query.month) {
    if (!/^\d{4}-\d{2}$/.test(String(req.query.month))) throw fail(400, 'חודש לא תקין');
    q.month = req.query.month;
  }
  res.json({ summary: await debt.debtSummary(q) });
}

const emunahGet = async (req, res) => res.json({ emunah: await emunah.emunahView() });

const listRules = async (req, res) => {
  res.json({ rules: await IncomeRule.find().sort({ built_in: -1, created_at: 1, _id: 1 }).lean() });
};

// ── writes ─────────────────────────────────────────────────────────────────
async function kaplanAccept(req, res) {
  const b = body(req);
  res.json(await kaplanWrites.acceptIncome({
    transaction_id: b.transaction_id, household_key: b.household_key, split: b.split,
    academic_year: b.academic_year, by: by(req),
  }));
}

const kaplanReject = async (req, res) => {
  const b = body(req);
  res.json(await kaplanWrites.rejectIncome({ transaction_id: b.transaction_id, household_key: b.household_key }));
};

const kaplanUnallocate = async (req, res) => res.json(await kaplanWrites.unallocate(body(req).transaction_id));

async function clicktacImport(req, res) {
  const b = body(req);
  checkId(b.branch_id, 'מזהה סניף');
  const buffer = fileBuffer(b);
  const name = String(b.file_name || '').slice(0, 200);
  res.json(await debt.importDebt({ buffer, branch_id: b.branch_id, by: by(req), file_name: name }));
}

async function emunahImport(req, res) {
  const b = body(req);
  const buffer = fileBuffer(b);
  const name = String(b.file_name || '').slice(0, 200);
  res.json({ statement: await emunah.importEmunah({ buffer, by: by(req), file_name: name }) });
}

async function createRule(req, res) {
  const b = body(req);
  const pattern = String(b.pattern || '').trim();
  if (pattern.length < 2) throw fail(400, 'התבנית קצרה מדי');
  if (pattern.length > 100) throw fail(400, 'התבנית ארוכה מדי');
  const dup = await IncomeRule.findOne({ pattern: { $regex: `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }).lean();
  if (dup) throw fail(409, 'כלל כזה כבר קיים');
  const rule = await IncomeRule.create({
    label: String(b.label || '').trim() || pattern, pattern, note: String(b.note || '').trim(), built_in: false,
  });
  res.status(201).json({ rule: rule.toObject() });
}

async function deleteRule(req, res) {
  checkId(req.params.id, 'מזהה כלל');
  const rule = await IncomeRule.findById(req.params.id).lean();
  if (!rule) throw fail(404, 'הכלל לא נמצא');
  if (rule.built_in) throw fail(400, 'אי אפשר למחוק כלל מובנה');
  await IncomeRule.deleteOne({ _id: rule._id });
  res.json({ ok: true });
}

module.exports = {
  errorHandler, kaplanQueue, kaplanAlternatives, kaplanReport, kaplanMatched, kaplanHouseholds, clicktacSummary, emunahGet, listRules,
  kaplanAccept, kaplanReject, kaplanUnallocate, clicktacImport, emunahImport, createRule, deleteRule,
};
