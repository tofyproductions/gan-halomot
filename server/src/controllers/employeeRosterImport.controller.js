'use strict';

/**
 * Two endpoints over the roster importer: one that shows what WOULD change, and
 * one that changes it.
 *
 * They are deliberately separate calls rather than one call with a `dryRun`
 * flag. A flag that defaults wrong, or is dropped by a retry, writes ninety-five
 * records nobody looked at; two endpoints cannot be confused for one another.
 *
 * The reviewer approves PEOPLE, not values — `apply` re-derives every field
 * from the uploaded rows (see employeeRosterImport.js). So the worst a tampered
 * request can do is apply the accountant's own figures to an employee the
 * reviewer did not tick, never invent a figure.
 */

const XLSX = require('xlsx');
const { buildImportPlan, applyImportPlan } = require('../services/employeeRosterImport');

/**
 * Column headers, as שקלולית's own אלפון עובדים writes them — and as our CSV
 * writes them, so either can be uploaded.
 *
 * The Hebrew here is copied from the real export, apostrophes and full stops
 * included: the birth-date column is "ת' לידה" and marital status is "מ.מ.",
 * not the spelled-out words a person would guess.
 */
const HEADER_MAP = {
  'מספר עובד': 'employee_number', employee_number: 'employee_number',
  'מספר זהות': 'israeli_id', 'מס זהות': 'israeli_id', 'מס\' זהות': 'israeli_id',
  'תעודת זהות': 'israeli_id', israeli_id: 'israeli_id',
  'EMail': 'email', 'Email': 'email', 'E-Mail': 'email',
  'מייל': 'email', 'דואל': 'email', 'דוא"ל': 'email', email: 'email',
  'טלפון': 'phone', phone: 'phone',
  "ת' לידה": 'birth_date', 'תאריך לידה': 'birth_date', birth_date: 'birth_date',
  'מין': 'gender', gender: 'gender',
  'מ.מ.': 'marital', 'מצב משפחתי': 'marital', marital: 'marital', marital_status: 'marital',
  'מיקוד': 'postal', postal: 'postal', postal_code: 'postal',
  'עיר': 'city', 'רחוב': 'street', 'בית': 'house_no',
  'יתרת חופשה': 'vacation_balance', vacation_balance: 'vacation_balance',
  'יתרת מחלה': 'sick_balance', sick_balance: 'sick_balance',
  'יתרת הבראה': 'recreation_balance', recreation_balance: 'recreation_balance',
  'צבירת חופשה לחודש': 'vacation_accrual', vacation_accrual: 'vacation_accrual',
};

/** A row is the header when it names the two columns nothing else can supply. */
function looksLikeHeader(cells) {
  const set = new Set(cells.map((c) => String(c || '').trim()));
  return set.has('מספר עובד') && (set.has('מספר זהות') || set.has('israeli_id'));
}

/**
 * A sheet or CSV into plain rows.
 *
 * שקלולית's export does not start at the first row: five lines of company
 * name, title, user and "הופק ע\"י" come first, and the last line is a
 * "סה\"כ כללי: 95 עובדים" total. Reading row 0 as the header would map every
 * column onto the company name and match nobody, so the header is FOUND rather
 * than assumed, and anything above or below the data block is skipped.
 *
 * `raw: false` so the sheet's own formatting wins — read raw, a ת"ז or a
 * telephone number comes back as a number and loses its leading zero, and
 * 024073124 becomes a different person's ID.
 */
function parseUpload(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const headerIdx = grid.findIndex(looksLikeHeader);
  if (headerIdx === -1) return [];

  const cols = grid[headerIdx].map((c) => HEADER_MAP[String(c || '').trim()] || null);
  const out = [];
  for (const cells of grid.slice(headerIdx + 1)) {
    const row = {};
    cols.forEach((key, i) => {
      if (!key) return;
      const v = cells[i];
      row[key] = typeof v === 'string' ? v.trim() : v;
    });
    // The trailing total line — 'סה"כ כללי: 95 עובדים' — sits in the first
    // column, exactly where the employee number goes, so an empty-cell check
    // does not catch it. A real employee number is digits; anything else in
    // that column is the report talking about itself, not a person, and must
    // not be reported to the reviewer as a bad row.
    const empNo = String(row.employee_number || '').trim();
    const idDigits = String(row.israeli_id || '').replace(/\D/g, '');
    if (!/^\d+$/.test(empNo) && !idDigits) continue;
    // Address arrives split; the record keeps one line.
    const street = [row.street, row.house_no].filter(Boolean).join(' ').trim();
    row.address = [street, row.city].filter(Boolean).join(', ').trim();
    delete row.street; delete row.house_no; delete row.city;
    out.push(row);
  }
  return out;
}

const monthOk = (m) => /^\d{4}-\d{2}$/.test(String(m || ''));

/** POST /employee-roster-import/preview — reads the file, writes nothing. */
async function preview(req, res, next) {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: 'לא צורף קובץ.' });
    const asOfMonth = req.body?.as_of_month || null;
    if (asOfMonth && !monthOk(asOfMonth)) {
      return res.status(400).json({ error: 'חודש היתרות חייב להיות בפורמט YYYY-MM.' });
    }
    const rows = parseUpload(req.file.buffer);
    if (rows.length === 0) {
      return res.status(400).json({ error: 'לא זוהו שורות בקובץ — בדקו שכותרות העמודות תואמות.' });
    }
    const plan = await buildImportPlan(rows, asOfMonth);
    res.json(plan);
  } catch (err) { next(err); }
}

/** POST /employee-roster-import/apply — writes, for approved employees only. */
async function apply(req, res, next) {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: 'לא צורף קובץ.' });
    const asOfMonth = req.body?.as_of_month || null;
    if (asOfMonth && !monthOk(asOfMonth)) {
      return res.status(400).json({ error: 'חודש היתרות חייב להיות בפורמט YYYY-MM.' });
    }
    let approved = req.body?.approved_ids;
    if (typeof approved === 'string') {
      try { approved = JSON.parse(approved); } catch (_) { approved = approved.split(','); }
    }
    if (!Array.isArray(approved) || approved.length === 0) {
      // Not an error worth a 500, and not a silent no-op either: an apply with
      // nothing ticked is a mis-click, and saying so is kinder than "0 updated".
      return res.status(400).json({ error: 'לא סומנו עובדים לעדכון.' });
    }
    const rows = parseUpload(req.file.buffer);
    const result = await applyImportPlan(rows, asOfMonth, approved);
    console.log(`[roster-import] ${req.user?.email || req.user?.id}: ${result.updated.length} עודכנו, ${result.failed.length} נכשלו (as_of ${asOfMonth || '—'})`);
    res.json(result);
  } catch (err) { next(err); }
}

module.exports = { preview, apply, parseUpload };
