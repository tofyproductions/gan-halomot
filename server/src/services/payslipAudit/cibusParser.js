/**
 * Cibus monthly report parser.
 *
 * The user exports a per-employee usage report from the Cibus (Pluxee) admin
 * dashboard — usually xlsx, sometimes csv. Column headers vary between Hebrew
 * and English depending on the export, and column order isn't guaranteed, so
 * we detect each column by a list of likely header names instead of by
 * position.
 *
 * Output: { rows: [{ name, id, amount, days, raw }, ...], detected_columns: {...} }
 *
 * If the parser can't find a column, the field is null and the comparator
 * just won't surface that comparison — the raw rows are still kept so the UI
 * can display them as supporting evidence.
 */

const XLSX = require('xlsx');

// Header synonyms — first match wins, case-insensitive after trim/normalize.
// `שם העובד/ת` is the canonical header used in real Pluxee transaction exports.
// `הסכום שחוייב` / `חלק חברה` are the amount columns. Real exports are TRANSACTION-
// level (one row per Cibus charge) — we aggregate per employee further down.
const COL_SYNONYMS = {
  name:   ['שם העובד/ת', 'שם העובדת', 'שם העובד', 'שם', 'שם עובד', 'שם מלא', 'name', 'employee name', 'full name'],
  first_name: ['שם פרטי', 'first name', 'firstname'],
  last_name:  ['שם משפחה', 'last name', 'lastname', 'surname'],
  emp_no: ["מס' עובד", 'מס עובד', 'מספר עובד', 'employee number', 'employee no', 'emp_no', 'emp no'],
  id:     ['תעודת זהות', 'ת.ז.', 'ת"ז', "ת'ז", 'ת״ז', 'תז', 'מספר זהות', 'id', 'id number', 'national id', 'employee id'],
  amount: ['חלק חברה', 'הסכום שחוייב', 'סכום חיוב', 'סכום', 'סך חיוב', 'חיוב', 'סה"כ', 'סהכ', 'סכום לחיוב', 'amount', 'total', 'charge', 'employer charge', 'monthly charge', 'הוצאות', 'הוצאה'],
  txn_date: ['תאריך', 'תאריך עסקה', "תאריך ושעה", 'date', 'transaction date'],
  vendor: ['שם בית העסק', 'בית עסק', 'vendor', 'merchant'],
  branch_label: ['מחלקה', 'department', 'branch'],
  group_label:  ['שם קבוצה', 'קבוצה', 'group'],
  days:   ['ימי שימוש', 'ימים', 'מספר ימים', 'ימי פעילות', 'days', 'days used', 'usage days', 'active days'],
  email:  ['email', 'אימייל', 'דוא"ל', 'דואל', 'mail'],
  phone:  ['phone', 'טלפון', 'נייד', 'mobile'],
};

function normalize(s) {
  if (s == null) return '';
  return String(s).trim().replace(/[\s"'״’]+/g, '').toLowerCase();
}

function detectColumns(headerRow) {
  const detected = {};
  const lookup = headerRow.map((h) => normalize(h));
  for (const [field, candidates] of Object.entries(COL_SYNONYMS)) {
    for (const cand of candidates) {
      const idx = lookup.indexOf(normalize(cand));
      if (idx >= 0) {
        detected[field] = idx;
        break;
      }
    }
  }
  return detected;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[,₪\s]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function padIsraeliId(v) {
  if (!v) return null;
  const digits = String(v).replace(/\D/g, '');
  if (!digits) return null;
  return digits.padStart(9, '0');
}

/**
 * Parse a Cibus report buffer (xlsx or csv).
 *
 * Strategy: take the first sheet, scan rows top-to-bottom for the first row
 * that contains at least 2 detectable column headers — that's the header row.
 * All rows below it are data.
 *
 * @param {Buffer} buffer
 * @param {string} originalName  used to detect csv vs xlsx
 * @returns {{ rows: Array, detected_columns: Object, sheet_name: string, header_row_index: number }}
 */
function parseCibusReport(buffer, originalName = '') {
  const isCsv = /\.csv$/i.test(originalName);
  const wb = XLSX.read(buffer, { type: 'buffer', codepage: isCsv ? 65001 : undefined });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error('דוח סיבוס: לא נמצא גליון בקובץ');
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });

  // Find the first row that looks like a header (at least 2 known columns)
  let headerRowIdx = -1;
  let detected = {};
  for (let i = 0; i < Math.min(raw.length, 30); i++) {
    const row = raw[i];
    if (!row || row.length === 0) continue;
    const d = detectColumns(row);
    if (Object.keys(d).length >= 2) {
      headerRowIdx = i;
      detected = d;
      break;
    }
  }
  if (headerRowIdx === -1) {
    return {
      rows: [],
      detected_columns: {},
      sheet_name: sheetName,
      header_row_index: -1,
      total_rows: raw.length,
      warning: 'לא זוהו עמודות בכותרת (שם / ת״ז / סכום) — בדוק שזה דוח Cibus תקין',
    };
  }

  // Real Cibus exports are transaction-level: one row per charge. We collect
  // every transaction and then aggregate per employee. Aggregation key:
  // ID > emp_no > normalized name (in that priority order).
  const txns = [];
  for (let i = headerRowIdx + 1; i < raw.length; i++) {
    const r = raw[i];
    if (!r) continue;
    if (r.every((c) => c === null || c === '')) continue;
    let name = detected.name != null ? r[detected.name] : null;
    if (!name && detected.first_name != null && detected.last_name != null) {
      const fn = r[detected.first_name];
      const ln = r[detected.last_name];
      if (fn || ln) name = [fn, ln].filter(Boolean).join(' ');
    }
    const id     = detected.id     != null ? padIsraeliId(r[detected.id])  : null;
    const empNo  = detected.emp_no != null ? r[detected.emp_no]            : null;
    const amount = detected.amount != null ? toNumber(r[detected.amount])  : null;
    const days   = detected.days   != null ? toNumber(r[detected.days])    : null;
    const txnDate = detected.txn_date != null ? r[detected.txn_date]       : null;
    const vendor  = detected.vendor   != null ? r[detected.vendor]         : null;
    // Skip summary / footer rows: rows with an amount but no employee identity
    // (no name + no ID + no emp_no). Pluxee adds a "סה"כ" total row at the
    // bottom of every export — without this filter it appears as a phantom
    // orphan in the audit.
    const hasIdentity = name || id || (empNo != null && empNo !== '');
    if (!hasIdentity) continue;
    if (name == null && id == null && amount == null) continue;
    txns.push({
      name: name ? String(name).trim() : null,
      id,
      emp_no: empNo != null && empNo !== '' ? String(empNo).trim() : null,
      amount,
      days,
      txn_date: txnDate,
      vendor,
      raw: r,
    });
  }

  // Aggregate. Use ID as primary key when available (most robust); fall back to
  // emp_no, then normalized name. We carry through name + id + emp_no so the
  // matcher in comparator.js can use whichever is most specific.
  const aggMap = new Map();
  for (const t of txns) {
    const key = t.id || t.emp_no ? `${t.id || ''}|${t.emp_no || ''}` : `name:${(t.name || '').toLowerCase().trim()}`;
    if (!aggMap.has(key)) {
      aggMap.set(key, {
        name: t.name,
        id: t.id,
        emp_no: t.emp_no,
        amount: 0,
        days: null,
        txn_count: 0,
        // Keep a few sample transactions for debugging / display
        sample_transactions: [],
      });
    }
    const a = aggMap.get(key);
    if (t.amount != null) a.amount += t.amount;
    if (t.days != null) a.days = (a.days || 0) + t.days;
    a.txn_count++;
    // Keep first 3 transactions as evidence
    if (a.sample_transactions.length < 3 && (t.txn_date || t.vendor)) {
      a.sample_transactions.push({
        date: t.txn_date,
        vendor: t.vendor,
        amount: t.amount,
      });
    }
    // Prefer the longest non-empty name we've seen for this key (Pluxee
    // sometimes has the first row with just first name, later rows have full).
    if (t.name && (!a.name || String(t.name).length > String(a.name).length)) {
      a.name = t.name;
    }
    // First-seen ID/emp_no wins (don't overwrite)
    if (!a.id && t.id) a.id = t.id;
    if (!a.emp_no && t.emp_no) a.emp_no = t.emp_no;
  }

  // Round amounts to fix floating-point noise from summing many .15 / .42 etc.
  const rows = [];
  for (const a of aggMap.values()) {
    a.amount = Math.round(a.amount * 100) / 100;
    rows.push(a);
  }

  return {
    rows,
    detected_columns: detected,
    sheet_name: sheetName,
    header_row_index: headerRowIdx,
    total_rows: raw.length,
    transaction_count: txns.length,
    aggregated_employee_count: rows.length,
  };
}

module.exports = { parseCibusReport };
