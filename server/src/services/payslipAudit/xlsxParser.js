/**
 * Salary table xlsx parser.
 *
 * Reads a sheet that follows the convention used by the accountant-facing
 * monthly salary spreadsheet ("טבלת שכר - גן החלומות"):
 *
 * Row layout (after 3 header rows):
 *   A=סניף, B=שם, C=ימי עבודה, D=שעות רגילות, E=OT 125%, F=OT 150%,
 *   G=שכר שעתי, H=שכר גלובלי, I=OT גלובלי,
 *   J–P  Emuna כפר סבא (ימי, שעות, OT-a, OT-b, שעתי, גלובלי, OT-גל)
 *   Q–W  Emuna הרצליה (same)
 *   X=נסיעות, Y=מחלה, Z=היעדרות, AA=חופשה, AB=דמי חגים,
 *   AC=אחוז קיזוז (advance directive — free text),
 *   AD=GIFT CARD, AE=הבראה, AF=סיבוס, AG=מילואים,
 *   AH=הערות (free text — contains directives like "לאפס" / "להוריד 8")
 *
 * The branch column (A) is sparse — it carries the branch name only on the
 * first row of each branch group. We forward-fill it.
 */

const XLSX = require('xlsx');

const COL = {
  branch: 0,
  name: 1,
  days: 2,
  hours_regular: 3,
  ot_125: 4,
  ot_150: 5,
  hourly_rate: 6,
  global_salary: 7,
  global_ot: 8,
  emuna_ks_global: 14,
  emuna_ks_global_ot: 15,
  emuna_hz_global: 21,
  emuna_hz_global_ot: 22,
  transport: 23,
  sick: 24,
  absence: 25,
  vacation: 26,
  holidays: 27,
  advance_directive: 28,
  gift: 29,
  recuperation: 30,
  cibus: 31,
  reserve_duty: 32,
  notes: 33,
};

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return null;
    const cleaned = t.replace(/[,\s]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStringOrNull(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s || null;
}

/**
 * Parse a salary cell that may contain numeric or "נטו 6,500" / "ברוטו 8000" text.
 * Returns { kind: 'net'|'gross'|'unknown', amount, raw }.
 */
function parseSalaryCell(value) {
  if (value === null || value === undefined || value === '') {
    return { kind: 'unknown', amount: null, raw: null };
  }
  if (typeof value === 'number') {
    return { kind: 'unknown', amount: value, raw: value };
  }
  const str = String(value);
  let kind = 'unknown';
  if (str.includes('נטו')) kind = 'net';
  else if (str.includes('ברוטו')) kind = 'gross';
  const match = str.match(/-?\d[\d,]*(?:\.\d+)?/);
  const amount = match ? Number(match[0].replace(/,/g, '')) : null;
  return { kind, amount: Number.isFinite(amount) ? amount : null, raw: null };
}

/**
 * Parse the salary xlsx into structured rows.
 *
 * @param {Buffer} buffer  raw xlsx bytes
 * @param {{ sheetName?: string, branchFilter?: string }} options
 * @returns {{ sheet_name: string, rows: SalaryTableRow[], available_sheets: string[] }}
 */
function parseSalaryTable(buffer, options = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = options.sheetName || wb.SheetNames[wb.SheetNames.length - 1];
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    throw new Error(`גליון "${sheetName}" לא נמצא בקובץ`);
  }
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });

  // First 3 rows are headers (title, section, columns).
  const dataStartRow = 3;
  let currentBranch = '';
  const rows = [];
  for (let i = dataStartRow; i < raw.length; i++) {
    const r = raw[i];
    if (!r) continue;
    const branchCell = toStringOrNull(r[COL.branch]);
    if (branchCell) currentBranch = branchCell;
    const name = toStringOrNull(r[COL.name]);
    if (!name) continue;
    if (options.branchFilter && !currentBranch.includes(options.branchFilter)) continue;

    const globalSalary = parseSalaryCell(r[COL.global_salary]);
    const globalOt = parseSalaryCell(r[COL.global_ot]);

    rows.push({
      branch: currentBranch,
      employee_name: name,
      days: toNumber(r[COL.days]),
      hours_regular: toNumber(r[COL.hours_regular]),
      ot_125: toNumber(r[COL.ot_125]),
      ot_150: toNumber(r[COL.ot_150]),
      hourly_rate: toNumber(r[COL.hourly_rate]),
      global_salary: globalSalary.raw,
      global_ot: globalOt.raw,
      global_salary_kind: globalSalary.kind,
      global_salary_amount: globalSalary.amount,
      global_ot_amount: globalOt.amount,
      emuna_ks_global: toNumber(r[COL.emuna_ks_global]),
      emuna_ks_global_ot: toNumber(r[COL.emuna_ks_global_ot]),
      emuna_hz_global: toNumber(r[COL.emuna_hz_global]),
      emuna_hz_global_ot: toNumber(r[COL.emuna_hz_global_ot]),
      transport: toNumber(r[COL.transport]),
      sick_days: toNumber(r[COL.sick]),
      absence: toNumber(r[COL.absence]),
      vacation_days: toNumber(r[COL.vacation]),
      holiday_days: toNumber(r[COL.holidays]),
      advance_directive: toStringOrNull(r[COL.advance_directive]),
      gift_card: toNumber(r[COL.gift]),
      recuperation: toNumber(r[COL.recuperation]),
      cibus: toNumber(r[COL.cibus]),
      reserve_duty: toNumber(r[COL.reserve_duty]),
      notes: toStringOrNull(r[COL.notes]),
    });
  }

  return {
    sheet_name: sheetName,
    rows,
    available_sheets: wb.SheetNames,
  };
}

module.exports = { parseSalaryTable };
