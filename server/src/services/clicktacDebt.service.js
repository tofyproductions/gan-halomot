/**
 * ClickTac's monthly collection report (debt_contract_export) — income spec §2.
 *
 * One row per child per month: what the child was charged, the target after the
 * monthly limit, what was actually paid. The file says nothing about the branch
 * (`מוסד` = "כפר סבא" for two gans), so the branch is chosen at upload and the
 * `מוסד` column is only used to REFUSE a file that plainly belongs to another
 * city. Re-uploading a branch+month replaces that branch+month's rows and
 * nothing else.
 *
 * READ-ONLY ON COLLECTIONS: this module writes ClickTacImport/ClickTacMonthRow
 * and never Collection / Registration / ExternalEnrollment.
 */
const XLSX = require('xlsx');
const { Branch, Child, ClickTacImport, ClickTacMonthRow } = require('../models');
const {
  DEBT_COLUMNS: C, identifyHeader, institutionMatchesBranch, parseDate,
} = require('./clicktac.service');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const str = (v) => (v == null ? '' : String(v).trim());
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(str(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const EXCEL_EPOCH_OFFSET = 25569;

/** 9-digit ת"ז; a passport (any Latin letter) is kept as is, upper-cased. */
function normalizeChildId(value) {
  const raw = str(value);
  if (!raw) return '';
  if (/[A-Za-z]/.test(raw)) return raw.toUpperCase();
  const digits = raw.replace(/\D/g, '');
  return digits.length && digits.length <= 9 ? digits.padStart(9, '0') : digits;
}

/** `חודש` is an Excel date (a serial, or text when someone retyped it) → 'YYYY-MM'. */
function monthOf(value) {
  let d = null;
  if (typeof value === 'number') d = new Date(Math.round(value) * 86400000 - EXCEL_EPOCH_OFFSET * 86400000);
  else if (value instanceof Date) d = new Date(value.getTime() + 12 * 3600000); // cellDates drifts a minute either way
  else d = parseDate(value);
  if (!d || isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** buffer → `{ month, rows, institutions }`. Throws a 400 with a Hebrew message on a bad file. */
function parseDebtExport(buffer) {
  let sheetRows;
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    sheetRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null, raw: true });
  } catch (_) {
    throw httpError(400, 'הקובץ אינו גיליון שאפשר לקרוא');
  }
  if (!sheetRows.length) throw httpError(400, 'הגיליון ריק');
  const verdict = identifyHeader(sheetRows[0]);
  if (verdict.type !== 'debt') {
    throw httpError(400, verdict.error || 'הקובץ אינו דוח הגבייה החודשי של קליקטאק (debt_contract_export)');
  }

  const months = new Set();
  const institutions = new Set();
  const byChild = new Map();
  for (const r of sheetRows) {
    const id = normalizeChildId(r[C.id_number]);
    if (!id) continue;
    const month = monthOf(r[C.month]);
    if (!month) throw httpError(400, 'בעמודת החודש יש ערך שאינו תאריך');
    months.add(month);
    if (str(r[C.institution])) institutions.add(str(r[C.institution]));
    const row = {
      child_id_number: id,
      child_name: `${str(r[C.child_first])} ${str(r[C.child_last])}`.trim(),
      status: str(r[C.status]),
      charges: num(r[C.charges]),
      target: num(r[C.target]),
      paid: num(r[C.paid]),
      adjustments: num(r[C.adjustments]),
      collection_status: str(r[C.collection_status]),
      payment_method: str(r[C.payment_method]),
    };
    row.institution = str(r[C.institution]);
    const prev = byChild.get(id);
    if (prev) { // one child twice in a file: add up, never trip the unique index
      for (const k of ['charges', 'target', 'paid', 'adjustments']) prev[k] += row[k];
    } else byChild.set(id, row);
  }
  if (!months.size) throw httpError(400, 'לא נמצאו בקובץ שורות עם תעודת זהות');
  if (months.size > 1) {
    throw httpError(400, `בקובץ יש יותר מחודש אחד (${[...months].sort().join(', ')}) — מעלים חודש בכל פעם`);
  }
  return { month: [...months][0], rows: [...byChild.values()], institutions: [...institutions] };
}

/** Parse, check the branch, then replace that branch+month. → `{ month, rows, replaced, skipped }` (skipped = other institutions' rows). */
async function importDebt({ buffer, branch_id, by = null, file_name = '' }) {
  const branch = await Branch.findById(branch_id).select('name').lean().catch(() => null);
  if (!branch) throw httpError(404, 'הסניף לא נמצא');
  const parsed = parseDebtExport(buffer);
  // The vendor's file covers the whole organisation (three cities in one sheet):
  // keep this branch's rows, skip the others, and refuse only a file with none.
  const mine = parsed.rows.filter(r => institutionMatchesBranch(r.institution, branch.name));
  if (!mine.length) {
    throw httpError(400, `בקובץ אין שורות של "${branch.name}" (מוסדות בקובץ: ${parsed.institutions.join(', ')}) — כנראה בחרת סניף אחר`);
  }
  parsed.skipped = parsed.rows.length - mine.length;
  parsed.rows = mine;
  const imp = await ClickTacImport.create({
    branch_id, month: parsed.month, file_name, rows: parsed.rows.length, created_by: by,
  });
  const del = await ClickTacMonthRow.deleteMany({ branch_id, month: parsed.month });
  await ClickTacMonthRow.insertMany(parsed.rows.map(({ institution, ...r }) => ({
    ...r, branch_id, month: parsed.month, import_id: imp._id,
  })));
  return { month: parsed.month, rows: parsed.rows.length, replaced: del.deletedCount || 0, skipped: parsed.skipped };
}

/**
 * Per branch+month: `{ target, paid, gap, unpaid_count, no_method_count, unpaid[] }`.
 * "Unpaid" = paid < target (a cancelled child with a balance is still a debt);
 * `no_method_count` counts those unpaid children who have no payment method on
 * file. `child_link` is the Registration id when a Child with the same ID exists.
 */
async function debtSummary({ branch_id, month } = {}) {
  const q = {};
  if (branch_id) q.branch_id = branch_id;
  if (month) q.month = month;
  const rows = await ClickTacMonthRow.find(q).lean();

  const ids = [...new Set(rows.map(r => r.child_id_number))];
  // Child.child_id_number is free text: also look for the id without its padding zeros.
  const variants = ids.flatMap(i => [i, i.replace(/^0+/, '')]).filter(Boolean);
  const children = ids.length
    ? await Child.find({ child_id_number: { $in: variants } }).select('child_id_number registration_id').lean()
    : [];
  const link = new Map();
  for (const c of children) {
    const k = normalizeChildId(c.child_id_number);
    if (!link.has(k) && c.registration_id) link.set(k, c.registration_id);
  }

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.branch_id}|${r.month}`;
    if (!groups.has(key)) {
      groups.set(key, { branch_id: r.branch_id, month: r.month, target: 0, paid: 0, gap: 0, unpaid_count: 0, no_method_count: 0, unpaid: [] });
    }
    const g = groups.get(key);
    g.target += r.target;
    g.paid += r.paid;
    const gap = r.target - r.paid;
    if (gap > 0.005) {
      g.unpaid_count++;
      if (!r.payment_method) g.no_method_count++;
      g.unpaid.push({
        child_id_number: r.child_id_number, child_name: r.child_name, status: r.status,
        target: r.target, paid: r.paid, gap: Math.round(gap * 100) / 100,
        collection_status: r.collection_status, payment_method: r.payment_method,
        child_link: link.get(r.child_id_number) || null,
      });
    }
  }
  const out = [...groups.values()].map(g => ({
    ...g,
    target: Math.round(g.target * 100) / 100,
    paid: Math.round(g.paid * 100) / 100,
    gap: Math.round((g.target - g.paid) * 100) / 100,
    unpaid: g.unpaid.sort((a, b) => b.gap - a.gap),
  }));
  return out.sort((a, b) => (a.month === b.month ? 0 : a.month < b.month ? 1 : -1));
}

module.exports = { parseDebtExport, importDebt, debtSummary, normalizeChildId, monthOf };
