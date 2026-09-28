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

/** Column headers as the accountant's exports and our own CSV write them. */
const HEADER_MAP = {
  'מספר עובד': 'employee_number', employee_number: 'employee_number',
  'מספר זהות': 'israeli_id', 'מס זהות': 'israeli_id', 'תעודת זהות': 'israeli_id',
  israeli_id: 'israeli_id',
  'מייל': 'email', 'דואל': 'email', 'דוא"ל': 'email', email: 'email',
  'טלפון': 'phone', phone: 'phone',
  'תאריך לידה': 'birth_date', birth_date: 'birth_date',
  'מין': 'gender', gender: 'gender',
  'מצב משפחתי': 'marital', marital: 'marital', marital_status: 'marital',
  'מיקוד': 'postal', postal: 'postal', postal_code: 'postal',
  'יתרת חופשה': 'vacation_balance', vacation_balance: 'vacation_balance',
  'יתרת מחלה': 'sick_balance', sick_balance: 'sick_balance',
  'יתרת הבראה': 'recreation_balance', recreation_balance: 'recreation_balance',
};

/**
 * A sheet or CSV into plain rows.
 *
 * `raw: false` so the sheet's own formatting wins: read raw, a ת"ז with a
 * leading zero comes back as a number and loses it, and 0224073124 becomes a
 * different person's ID.
 */
function parseUpload(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  return rows.map((r) => {
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      const key = HEADER_MAP[String(k).trim()];
      if (key) out[key] = typeof v === 'string' ? v.trim() : v;
    }
    return out;
  });
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
