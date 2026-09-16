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

head('שערי דוח הסניף — נדחים לפני שנוגעים במסד');

/**
 * The guards on the branch report all return before the first query, so they
 * can be driven with no database at all. Anything past them needs Mongo and is
 * covered by running the report itself, not here.
 */
async function branchGates() {
  const { hoursRangeBulk } = require('../src/controllers/payroll.controller');
  const ask = async (query, user = { role: 'system_admin' }) => {
    let out = { status: 0, body: {} };
    const res = {
      json: (b) => { out = { status: 200, body: b }; },
      status: (code) => ({ json: (b) => { out = { status: code, body: b }; } }),
    };
    await hoursRangeBulk({ query, user }, res, (e) => { out = { status: 500, body: { error: e.message } }; });
    return out;
  };
  const BRANCH = '69dde62467ff14714973a158';

  let r = await ask({ branch: BRANCH, from: '2026-08', to: '2026-04' });
  ok(r.status === 400, 'טווח הפוך נדחה ב-400', JSON.stringify(r));

  r = await ask({ branch: BRANCH, from: '2025-01', to: '2026-06' });
  ok(r.status === 400, '18 חודשים נדחים — התקרה לדוח סניף היא 12', JSON.stringify(r));
  ok(/12/.test(r.body.error || ''), 'וההודעה אומרת מה התקרה');

  r = await ask({ from: '2026-04', to: '2026-08' });
  ok(r.status === 400, 'בלי סניף נדחה', JSON.stringify(r));

  r = await ask({ branch: 'all', from: '2026-04', to: '2026-08' });
  ok(r.status === 400, '"כל הסניפים" נדחה — כבד מדי', JSON.stringify(r));

  r = await ask({ branch: BRANCH, from: '2026-04', to: '2026-08' },
    { role: 'branch_manager', managed_branch_ids: ['aaaaaaaaaaaaaaaaaaaaaaaa'] });
  ok(r.status === 403, 'מנהלת של סניף אחר נחסמת ב-403', JSON.stringify(r));
}

branchGates().then(() => {
  console.log(failures === 0
    ? `\n✅  הכל עבר (${checks} בדיקות)\n`
    : `\n❌  ${failures} בדיקות נכשלו\n`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((e) => { console.error('💥 ', e); process.exit(1); });
