/**
 * Emunah's monthly settlement workbook ("תחשיב תשפ״ו גן החלומות") — income spec §3.
 *
 * Emunah collects for משה דיין / הרצליה / תל אביב through ClickTac and passes
 * the money on once a month. Its workbook has three income blocks side by side
 * (one per branch), an expenses table, a "payments made" table and a summary.
 * Everything is found by its LABEL TEXT, never by a cell address, so a sheet
 * with an extra row or column still parses. "X" or an empty cell is null.
 *
 * Each upload is kept as a version (EmunahStatement); the newest is shown.
 *
 * READ-ONLY ON COLLECTIONS: this module writes EmunahStatement only — never
 * Collection / Registration / ExternalEnrollment.
 */
const XLSX = require('xlsx');
const {
  Branch, BankAccount, BankTransaction, ClickTacMonthRow, EmunahStatement,
} = require('../models');
const { hebrewYearForStart } = require('./academic-year.service');
const { getStartDate } = require('./expenseCore.service');
const incomeRules = require('./incomeRules.service');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const round2 = (n) => Math.round(n * 100) / 100;
const EXCEL_EPOCH_OFFSET = 25569;
const DAY_MS = 86400000;
const MATCH_AMOUNT_ILS = 1;
const MATCH_DAYS = 7;
const EMUNAH_PATTERN = 'אמונה';
const todayIL = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

/** Cell text, with Hebrew gershayim/geresh folded to ASCII and spaces collapsed. */
const norm = (v) => (v == null ? '' : String(v))
  .replace(/[״“”]/g, '"').replace(/[׳’]/g, "'").replace(/\s+/g, ' ').trim();
const letters = (s) => norm(s).replace(/[^א-ת]/g, '');
const isTotal = (v) => /^סה"?כ/.test(norm(v));

/** A number, or null for "X", "-", an empty cell or text. */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = norm(v);
  if (!s || /^x$/i.test(s)) return null;
  const t = s.replace(/[,₪\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

const MONTH_NAMES = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
/** Hebrew month name → 1..12, or null. */
function monthNumber(v) {
  const l = letters(v);
  if (!l) return null;
  if (l === 'מרס') return 3;
  const i = MONTH_NAMES.indexOf(l);
  return i < 0 ? null : i + 1;
}

const ymd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
/** "20.9.25" / "20/9/2025" / an Excel serial / a Date → 'YYYY-MM-DD', else null. */
function parseDate(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : ymd(new Date(v.getTime() + 12 * 3600000));
  if (typeof v === 'number') {
    if (!(v > 0)) return null;
    return ymd(new Date((Math.round(v) - EXCEL_EPOCH_OFFSET) * DAY_MS));
  }
  const m = norm(v).match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1])));
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[1])) return null;
  return ymd(d);
}

/** "תשפ\"ו" → 2025 (the Gregorian year the gan year starts in), or null. */
function academicStartYear(label) {
  const want = letters(label);
  if (!want) return null;
  for (let y = 2015; y <= 2050; y++) if (letters(hebrewYearForStart(y)) === want) return y;
  return null;
}

/** Calendar 'YYYY-MM' of month `m` (1..12) in the gan year starting `start`; `index` 0 = the opening August. */
function calendarMonth(m, start, { index = null, date = null } = {}) {
  if (!m || !start) return null;
  let year;
  if (m >= 9) year = start;
  else if (m <= 7) year = start + 1;
  else if (index != null) year = index === 0 ? start : start + 1; // August opens and closes the year
  else year = date && date < `${start + 1}-03-01` ? start : start + 1;
  return `${year}-${String(m).padStart(2, '0')}`;
}

// ---------- sheet reading

const INCOME_FIELDS = [
  ['system', 'גבייה מהמערכת'], ['parents', 'העברת הורים'], ['refunds', 'החזרים להורים'],
  ['government', 'תשלומי ממשלה'], ['welfare', 'תשלומי רווחה'],
];
const BRANCH_NAME = /הרצליה|כפר סבא|משה דיין|אייזיק|חריף|תל אביב/;
const SUMMARY_FIELDS = [
  ['income', 'הכנסות'], ['expenses', 'הוצאות'], ['paid', 'תשלומים ששולמו'], ['balance', 'יתרה לתשלום'],
];

function gridOf(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
}
const cell = (g, r, c) => (g[r] ? g[r][c] : null);
function findAll(g, text) {
  const out = [];
  g.forEach((row, r) => (row || []).forEach((v, c) => { if (norm(v) === text) out.push({ r, c }); }));
  return out;
}
/** The cell with `text` in row `r`, strictly between columns `from` and `to`; nearest to `from` (or to `to` when `fromRight`). */
function inRow(g, r, text, from, to, fromRight = false) {
  const row = g[r] || [];
  const cols = [];
  for (let c = Math.max(0, from + 1); c < Math.min(row.length, to); c++) if (norm(row[c]) === text) cols.push(c);
  if (!cols.length) return null;
  return fromRight ? cols[cols.length - 1] : cols[0];
}

function parseIncomeBlocks(g) {
  const anchors = findAll(g, 'גבייה מהמערכת').sort((a, b) => a.r - b.r || a.c - b.c);
  const blocks = anchors.map(a => ({ ...a, monthCol: inRow(g, a.r, 'חודשים', -1, a.c, true) ?? a.c - 1 }));
  return blocks.map((b, k) => {
    const next = blocks.find((o, j) => j > k && o.r === b.r);
    const limit = next ? next.monthCol : Infinity;
    const cols = {};
    for (const [key, label] of INCOME_FIELDS) cols[key] = inRow(g, b.r, label, b.monthCol, limit);

    let name = '';
    for (let r = b.r - 1; r >= Math.max(0, b.r - 4) && !name; r--) {
      for (let c = b.monthCol; c < Math.min(limit, (g[r] || []).length); c++) {
        if (BRANCH_NAME.test(norm(cell(g, r, c)))) { name = norm(cell(g, r, c)); break; }
      }
    }

    const months = [];
    const totals = {};
    for (let r = b.r + 1; r < g.length; r++) {
      const label = cell(g, r, b.monthCol);
      const read = (target) => { for (const [key] of INCOME_FIELDS) target[key] = cols[key] == null ? null : num(cell(g, r, cols[key])); };
      if (isTotal(label)) { read(totals); break; }
      const m = monthNumber(label);
      if (!m) break;
      const row = { month_label: MONTH_NAMES[m - 1], month_index: months.length };
      read(row);
      months.push(row);
    }
    return { name, months, totals };
  });
}

function parseExpenses(g) {
  const a = findAll(g, 'שכר דירה')[0];
  if (!a) return [];
  const labelCol = inRow(g, a.r, 'חודשים', -1, a.c, true) ?? a.c - 1;
  const miscCol = inRow(g, a.r, 'שונות', a.c, Infinity);
  const out = [];
  for (let r = a.r + 1; r < g.length; r++) {
    const label = norm(cell(g, r, labelCol));
    if (!label || isTotal(label)) break;
    const rent = num(cell(g, r, a.c));
    const misc = miscCol == null ? null : num(cell(g, r, miscCol));
    const m = monthNumber(label);
    if (m) {
      out.push({ label, month_label: MONTH_NAMES[m - 1], rent, misc });
    } else {
      // A special line ("הוצאות תשפ״ה", water) spans both columns in the sheet: it is not rent.
      const amount = rent == null && misc == null ? null : (rent || 0) + (misc || 0);
      out.push({ label, month_label: null, rent: null, misc: amount });
    }
  }
  return out;
}

function parsePayments(g, start) {
  const a = findAll(g, 'תאריך העברה')[0];
  if (!a) return [];
  const amountCol = inRow(g, a.r, 'סכום', a.c, Infinity);
  const forCol = inRow(g, a.r, 'עבור חודש', a.c, Infinity);
  const out = [];
  for (let r = a.r + 1; r < g.length; r++) {
    const rawDate = cell(g, r, a.c);
    if (isTotal(rawDate)) break;
    const date = parseDate(rawDate);
    const amount = amountCol == null ? null : num(cell(g, r, amountCol));
    if (date == null && amount == null) break;
    const rawFor = forCol == null ? null : cell(g, r, forCol);
    const n = num(rawFor);
    const m = n != null && Number.isInteger(n) && n >= 1 && n <= 12 ? n : monthNumber(rawFor);
    const for_month = calendarMonth(m, start, { date }) || (norm(rawFor) || null);
    out.push({ date, amount, for_month });
  }
  return out;
}

/**
 * The summary sits right of the "payments made" block (from a few rows above
 * its header down). Only labels there count — "הכנסות"/"הוצאות" are also block
 * titles elsewhere in the sheet, and a number next to one of those is not the summary.
 */
function parseSummary(g) {
  const pay = findAll(g, 'תאריך העברה')[0];
  let inArea = () => true;
  if (pay) {
    const right = Math.max(pay.c, inRow(g, pay.r, 'סכום', pay.c, Infinity) ?? -1, inRow(g, pay.r, 'עבור חודש', pay.c, Infinity) ?? -1);
    inArea = ({ r, c }) => c > right && r >= pay.r - 3;
  }
  const out = {};
  for (const [key, label] of SUMMARY_FIELDS) {
    out[key] = null;
    for (const { r, c } of findAll(g, label).filter(inArea)) {
      const v = num(cell(g, r, c + 1));
      if (v != null) { out[key] = v; break; }
    }
  }
  return out;
}

function findYearLabel(g, sheetName) {
  const re = /^ת[א-ת]{1,3}"[א-ת]$/;
  for (const row of g) for (const v of row || []) if (re.test(norm(v))) return norm(v);
  return re.test(norm(sheetName)) ? norm(sheetName) : '';
}

/** buffer → `{ academic_year_label, branches, expenses, payments, summary }`. Throws a 400 with a Hebrew message on a bad file. */
function parseEmunah(buffer) {
  let wb;
  try { wb = XLSX.read(buffer, { type: 'buffer' }); } catch (_) { throw httpError(400, 'הקובץ אינו גיליון שאפשר לקרוא'); }
  let g = null;
  let sheetName = '';
  for (const n of wb.SheetNames || []) {
    const grid = gridOf(wb.Sheets[n]);
    if (findAll(grid, 'גבייה מהמערכת').length) { g = grid; sheetName = n; break; }
  }
  if (!g) throw httpError(400, 'הקובץ אינו תחשיב של אמונה — לא נמצאה הכותרת "גבייה מהמערכת"');
  const academic_year_label = findYearLabel(g, sheetName);
  const start = academicStartYear(academic_year_label);
  return {
    academic_year_label,
    branches: parseIncomeBlocks(g),
    expenses: parseExpenses(g),
    payments: parsePayments(g, start),
    summary: parseSummary(g),
  };
}

// ---------- storage

/** The statement's branch name → our Branch. כפר סבא is משה דיין — never קפלן. */
function branchPattern(name) {
  if (/הרצליה/.test(name)) return /הרצליה/;
  if (/כפר סבא|משה דיין/.test(name)) return /משה דיין/;
  if (/אייזיק|חריף|תל אביב/.test(name)) return /תל אביב/;
  return null;
}

async function importEmunah({ buffer, by = null, file_name = '' }) {
  const parsed = parseEmunah(buffer);
  const branches = (await Branch.find({}, 'name').lean()).filter(b => !/קפלן/.test(b.name || ''));
  for (const b of parsed.branches) {
    const re = branchPattern(b.name);
    const hit = re && branches.find(x => re.test(x.name || ''));
    b.branch_id = hit ? hit._id : null;
  }
  const doc = await EmunahStatement.create({ ...parsed, file_name, created_by: by });
  return doc.toObject();
}

function latestStatement() {
  return EmunahStatement.findOne({}).sort({ created_at: -1, _id: -1 }).lean();
}

// ---------- view

const dayNumber = (d) => Date.parse(`${d}T00:00:00Z`) / DAY_MS;
const shift = (d, days) => ymd(new Date((dayNumber(d) + days) * DAY_MS));

/**
 * The bank pool (income constraint): money in, bank (not card) accounts, not an
 * internal transfer, from the expenses start date, up to `to`. An "Emunah line"
 * is one the ACTIVE built-in "אמונה" income rule catches (description, original
 * description or payee). `rule_inactive` when that rule was switched off — then
 * there are no Emunah lines at all.
 */
async function emunahBankLines(to) {
  const rule = (await incomeRules.activeRules()).find(r => r.built_in && String(r.pattern).trim() === EMUNAH_PATTERN);
  if (!rule) return { rule_inactive: true, lines: [] };
  const bankIds = (await BankAccount.find({ type: 'bank' }, '_id').lean()).map(a => a._id);
  if (!bankIds.length) return { rule_inactive: false, lines: [] };
  const txs = await BankTransaction.find({
    account_id: { $in: bankIds },
    date: { $gte: await getStartDate(), $lte: to },
    amount: { $gt: 0 },
    is_internal_transfer: { $ne: true },
    status: 'completed',
  }).sort({ date: 1, _id: 1 }).lean();
  const lines = txs.filter(t => incomeRules.match([t.description, t.original_description, t.counterparty].filter(Boolean).join(' '), [rule]));
  return { rule_inactive: false, lines };
}

/** One-to-one, closest first: date distance, then amount distance. → Map(paymentIndex → tx). */
function matchPayments(payments, txs) {
  const pairs = [];
  payments.forEach((p, i) => {
    if (!p.date || p.amount == null) return;
    txs.forEach((t, j) => {
      const days = Math.abs(dayNumber(t.date) - dayNumber(p.date));
      const diff = Math.abs(t.amount - p.amount);
      if (days <= MATCH_DAYS && diff <= MATCH_AMOUNT_ILS + 1e-9) pairs.push({ i, j, days, diff });
    });
  });
  pairs.sort((a, b) => a.days - b.days || a.diff - b.diff || a.i - b.i || a.j - b.j);
  const out = new Map();
  const usedTx = new Set();
  for (const p of pairs) {
    if (out.has(p.i) || usedTx.has(p.j)) continue;
    out.set(p.i, txs[p.j]);
    usedTx.add(p.j);
  }
  return out;
}

async function clicktacCheck(statement, start) {
  const wanted = [];
  for (const b of statement.branches || []) {
    if (!b.branch_id) continue;
    for (const m of b.months || []) {
      const month = calendarMonth(monthNumber(m.month_label), start, { index: m.month_index });
      if (month) wanted.push({ branch_id: b.branch_id, branch_name: b.name, month, month_label: m.month_label, system: m.system });
    }
  }
  if (!wanted.length) return [];
  const sums = await ClickTacMonthRow.aggregate([
    { $match: {
      branch_id: { $in: wanted.map(w => w.branch_id) },
      // exact months only; a staged re-upload (`YYYY-MM~<id>`) is never counted
      month: { $in: [...new Set(wanted.map(w => w.month))], $not: /~/ },
    } },
    { $group: { _id: { b: '$branch_id', m: '$month' }, paid: { $sum: '$paid' } } },
  ]);
  const paid = new Map(sums.map(s => [`${s._id.b}|${s._id.m}`, s.paid]));
  return wanted
    .map((w) => {
      const p = paid.get(`${w.branch_id}|${w.month}`);
      const clicktac_paid = p == null ? null : round2(p);
      const diff = clicktac_paid == null || w.system == null ? null : round2(clicktac_paid - w.system);
      return { ...w, clicktac_paid, diff };
    })
    .filter(w => w.system != null || w.clicktac_paid != null);
}

function recompute(statement) {
  let income = 0;
  for (const b of statement.branches || []) {
    for (const m of b.months || []) for (const [key] of INCOME_FIELDS) income += m[key] || 0;
  }
  const expenses = (statement.expenses || []).reduce((s, e) => s + (e.rent || 0) + (e.misc || 0), 0);
  const paid = (statement.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
  return {
    income: round2(income), expenses: round2(expenses), paid: round2(paid),
    balance: round2(round2(income) - round2(expenses) - round2(paid)),
  };
}

/**
 * The newest statement with: each payment's bank line (or null, ±1 ₪ / ±7
 * days), the Emunah bank lines from max(expenses start, 1 Aug of the
 * statement's year) to today that no payment row explains, whether the
 * built-in "אמונה" rule is off, the blocks with no Branch, the per
 * branch+month ClickTac cross-check, and the summary recomputed. null when
 * nothing was imported.
 */
async function emunahView() {
  const statement = await latestStatement();
  if (!statement) return null;
  const start = academicStartYear(statement.academic_year_label);

  // Matching uses ±7 days around each payment row; "no row in the statement"
  // covers the whole year so far: from the later of the expenses start date and
  // 1 August of the statement's year, up to today.
  const today = todayIL();
  const dates = (statement.payments || []).map(p => p.date).filter(Boolean).sort();
  const lastPay = dates.length ? shift(dates[dates.length - 1], MATCH_DAYS) : today;
  const { rule_inactive, lines: txs } = await emunahBankLines(lastPay > today ? lastPay : today);
  const startDate = await getStartDate();
  const yearStart = start ? `${start}-08-01` : startDate;
  const from = yearStart > startDate ? yearStart : startDate;

  const matched = matchPayments(statement.payments || [], txs);
  const payments = (statement.payments || []).map((p, i) => {
    const t = matched.get(i);
    return { ...p, bank: t ? { transaction_id: t._id, date: t.date, amount: t.amount } : null };
  });
  const used = new Set([...matched.values()].map(t => String(t._id)));
  const unexplained_bank = txs.filter(t => !used.has(String(t._id)) && t.date >= from && t.date <= today).map(t => ({
    transaction_id: t._id, date: t.date, amount: t.amount, description: t.description, counterparty: t.counterparty,
  }));

  return {
    statement,
    payments,
    unexplained_bank,
    emunah_rule_inactive: rule_inactive,
    unmapped_branches: (statement.branches || []).filter(b => !b.branch_id).map(b => b.name),
    clicktac_check: await clicktacCheck(statement, start),
    recomputed: recompute(statement),
  };
}

module.exports = {
  parseEmunah, importEmunah, latestStatement, emunahView, parseDate, academicStartYear,
};
