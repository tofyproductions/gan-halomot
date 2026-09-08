#!/usr/bin/env node
/**
 * זיהוי הקובץ שאינו אחד משני הייצואים של קליקטאק.
 *
 * THE STORY THIS TEST TELLS. בפורטל של קליקטאק יש שני ייצואים, ושמות הקבצים
 * שלהם נבדלים במילה אחת. מישהי הורידה את `contracts_export_*.xlsx` — ייצוא
 * החוזים — והמערכת ענתה "חסרות עמודות בקובץ: שם פרטי של הנרשם, …". המשפט נכון
 * ולא עוזר: זה לא ייצוא נרשמים שבור, זה דוח אחר לגמרי.
 *
 * מאז, ייצוא החוזים המלא נקלט — הוא מביא את הכיתה, את הדרגה ואת תאריכי החוזה,
 * והוא נבדק ב-scripts/clicktac-contracts.test.js. מה שנשאר כאן הוא הצד השני של
 * אותו כלל: קובץ שאינו אף אחד מהשניים. גיליון שיש בו שתיים משלוש עמודות החוזה
 * אבל אין בו את `ת.ז. או דרכון` אינו ייצוא חוזים שאפשר לקלוט — הוא גיליון
 * חתוך או ערוך ביד — והתשובה עליו חייבת לנקוב בשני הדוחות שכן מתקבלים, ולא
 * לשלוח את הקוראת לחפש עמודה שממילא לא הייתה שם.
 *
 * WHAT MUST HOLD:
 *   - כותרות בצורת חוזה בלי עמודת הזהות → WRONG_EXPORT_TYPE, עם שמות שני
 *     הדוחות שכן נקלטים;
 *   - ייצוא נרשמים שחסרה בו עמודה אחת → ההודעה הגנרית, שנוקבת בשם העמודה;
 *   - ייצוא נרשמים מלא → עובר, בלי שגיאה בכלל.
 *
 * הקבצים נבנים כאן כ-xlsx אמיתיים ונקראים בחזרה בדיוק כמו ב-importFile
 * (XLSX.read → sheet_to_json עם defval:null, raw:false), כדי שהבדיקה תרוץ מול
 * אותו אובייקט שורה שהבקר רואה ולא מול אובייקט שנכתב ביד.
 *
 *   node scripts/clicktac-file-type.test.js
 */
const XLSX = require('xlsx');
const {
  COLUMNS, validateHeader, looksLikeContractsExport, WRONG_EXPORT_MESSAGE,
} = require('../src/services/clicktac.service');

let failures = 0;
let checks = 0;

function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}

const head = (t) => console.log(`\n${t}`);

/** A workbook in memory, read back exactly the way importFile reads an upload. */
function firstRowOf(header, values) {
  const ws = XLSX.utils.aoa_to_sheet([header, values]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const back = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(back.Sheets[back.SheetNames[0]], { defval: null, raw: false });
  return rows[0];
}

/* ---- the two files, as ClickTac actually names their columns ---- */

/**
 * ייצוא חוזים חתוך: יש בו את עמודות החוזה אבל לא את `ת.ז. או דרכון`, ולכן אין
 * בו את המפתח שלפיו הילד/ה מתמזג/ת עם ייצוא הנרשמים. קובץ כזה אינו נקלט.
 */
const CONTRACTS_HEADER = [
  'Id', 'שם פרטי', 'שם משפחה', 'כינוי', 'תאריך לידה', 'מעון', 'שנת לימודים',
  'כיתה', 'שכר לימוד', 'דרגה', 'תאריך התחלה', 'תאריך סיום',
];
const CONTRACTS_ROW = [
  '1041', 'נועם', 'כהן', '', '12/03/2024', 'כפר סבא', 'תשפ"ז',
  'פעוטות', '2,150', '7', '01/09/2026', '31/08/2027',
];

/** The registrations export — the one that carries the parents and the payment. */
const REGISTRATIONS_HEADER = Object.values(COLUMNS);
const REGISTRATIONS_ROW = REGISTRATIONS_HEADER.map(() => '');

function main() {
  console.log('=== קליקטאק — זיהוי סוג הייצוא ===');

  head('בדיקה 1 — גיליון בצורת חוזה, בלי עמודת הזהות');
  {
    const row = firstRowOf(CONTRACTS_HEADER, CONTRACTS_ROW);
    ok(looksLikeContractsExport(row), '1a הכותרות מזוהות כייצוא חוזים');
    const err = validateHeader(row);
    ok(!!err, '1b הקובץ נדחה');
    ok(err?.code === 'WRONG_EXPORT_TYPE', '1c הקוד הוא WRONG_EXPORT_TYPE', `code=${err?.code}`);
    ok(err?.error === WRONG_EXPORT_MESSAGE, '1d ההודעה נוקבת בשני הדוחות שכן נקלטים', err?.error);
    ok(!/חסרות עמודות/.test(err?.error || ''),
      '1e ואינה ההודעה הגנרית על עמודות חסרות');
  }

  head('בדיקה 2 — ייצוא נרשמים שחסרה בו עמודה');
  {
    const dropped = COLUMNS.p1_phone;
    const header = REGISTRATIONS_HEADER.filter(h => h !== dropped);
    const row = firstRowOf(header, header.map(() => ''));
    ok(!looksLikeContractsExport(row), '2a לא מזוהה כייצוא חוזים');
    const err = validateHeader(row);
    ok(err?.code === 'MISSING_COLUMNS', '2b חוזרת ההודעה הגנרית', `code=${err?.code}`);
    ok((err?.error || '').includes(dropped),
      `2c והיא נוקבת בשם העמודה החסרה ("${dropped}")`, err?.error);
    ok(Array.isArray(err?.expected) && err.expected.includes(COLUMNS.child_first),
      '2d ורשימת העמודות הצפויות מצורפת');
  }

  head('בדיקה 3 — ייצוא נרשמים תקין');
  {
    const row = firstRowOf(REGISTRATIONS_HEADER, REGISTRATIONS_ROW);
    ok(validateHeader(row) === null, '3a עובר ללא שגיאה');
  }

  /**
   * הכותרת 'מעון' לבדה אינה ראיה — יום אחד ייצוא הנרשמים עשוי לקבל עמודה
   * בשם הזה, וזיהוי על סמך אחת מהשלוש יהפוך קובץ תקין ל"קובץ הלא נכון".
   */
  head('בדיקה 4 — עמודה אחת בלבד אינה מספיקה');
  {
    const row = firstRowOf(['מעון', 'משהו אחר'], ['כפר סבא', '']);
    ok(!looksLikeContractsExport(row), '4a "מעון" לבדה אינה ייצוא חוזים');
    ok(validateHeader(row)?.code === 'MISSING_COLUMNS', '4b ולכן ההודעה הגנרית');

    const two = firstRowOf(['מעון', 'דרגה'], ['כפר סבא', '7']);
    ok(looksLikeContractsExport(two), '4c שתיים מתוך השלוש — כן');
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} בדיקות עברו`);
}

try { main(); } catch (err) { console.error('\n💥', err); failures++; }
process.exit(failures === 0 ? 0 : 1);
