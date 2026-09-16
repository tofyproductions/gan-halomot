/**
 * הטווח של דוח השעות הרב-חודשי — אילו חודשים נכנסים, ומה נדחה.
 *
 * זאת החוליה שיכולה להיות שגויה בלי ששום דבר ייפול: טווח שמפספס חודש מחזיר
 * דוח שנראה תקין לחלוטין ושסכום השעות בו פשוט קטן ממה שהעובדת עבדה. מעבר שנה
 * הוא המקום הרגיל שבו חשבון כזה נשבר — אפריל עד אוגוסט זה קל, נובמבר עד פברואר
 * זה איפה שסופרים חודשים במקום להוסיף ל-`month` ומקבלים "2026-13".
 *
 * התקרה אינה קוסמטית: כל חודש בטווח מחשב סניף שלם דרך `fetchMonthData`, ולכן
 * בקשה של עשר שנים היא דקה של מסד נתונים שאף אחד לא ביקש.
 *
 * טהורה — בלי מסד נתונים ובלי שרת.
 *
 *   node scripts/hours-range-span.test.js
 */

/* Nothing here may read server/.env. Stub dotenv before anything loads it. */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const { monthSpan } = require('../src/controllers/payroll.controller');

let failures = 0;
let checks = 0;

function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}
const eq = (actual, expected, label) => ok(
  JSON.stringify(actual) === JSON.stringify(expected),
  label,
  `קיבלנו ${JSON.stringify(actual)}, ציפינו ${JSON.stringify(expected)}`,
);
const head = (t) => console.log(`\n${t}`);

head('הטווח שביקשו — אפריל עד אוגוסט');
eq(monthSpan('2026-04', '2026-08'),
  ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'],
  'חמישה חודשים, כולל הקצוות');

head('חודש בודד הוא טווח תקין');
eq(monthSpan('2026-05', '2026-05'), ['2026-05'], 'מחודש לעצמו');

head('מעבר שנה');
eq(monthSpan('2025-11', '2026-02'),
  ['2025-11', '2025-12', '2026-01', '2026-02'],
  'נובמבר עד פברואר חוצה את השנה נכון');
eq(monthSpan('2025-12', '2026-01'), ['2025-12', '2026-01'], 'דצמבר לינואר');

head('ריפוד אפסים — "2026-9" אינו חודש קיים בשום מקום אחר במערכת');
ok((monthSpan('2026-08', '2026-10') || []).every(m => /^\d{4}-\d{2}$/.test(m)),
  'כל חודש בפורמט YYYY-MM');
eq(monthSpan('2026-09', '2026-09'), ['2026-09'], 'ספטמבר נשאר 09 ולא 9');

head('שנת לימודים שלמה — ספטמבר עד אוגוסט');
eq((monthSpan('2025-09', '2026-08') || []).length, 12, 'שנים-עשר חודשים');

head('טווח הפוך נדחה, ולא מחזיר רשימה ריקה בשקט');
eq(monthSpan('2026-08', '2026-04'), null, 'סיום לפני התחלה');
eq(monthSpan('2026-01', '2025-12'), null, 'סיום לפני התחלה, מעבר שנה');

head('התקרה');
eq((monthSpan('2025-01', '2026-12') || []).length, 24, 'בדיוק 24 חודשים עובר');
eq(monthSpan('2025-01', '2027-01'), null, '25 חודשים נדחה');

head('קלט פגום נדחה');
eq(monthSpan('', ''), null, 'ריק');
eq(monthSpan(null, '2026-08'), null, 'null');
eq(monthSpan('2026-13', '2026-14'), null, 'חודש 13');
eq(monthSpan('2026-00', '2026-05'), null, 'חודש 0');
eq(monthSpan('אפריל', 'אוגוסט'), null, 'טקסט');
eq(monthSpan('2026-04-15', '2026-08-15'), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'],
  'תאריך מלא נקרא כחודש שלו — זה מה שדפדפן שולח משדה month עם יום');

console.log(failures === 0
  ? `\n✅  הכל עבר (${checks} בדיקות)\n`
  : `\n❌  ${failures} בדיקות נכשלו\n`);
process.exit(failures === 0 ? 0 : 1);
