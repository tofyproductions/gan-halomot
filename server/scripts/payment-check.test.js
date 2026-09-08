#!/usr/bin/env node
/**
 * אמצעי התשלום של המשפחה — הכלל, על כל הצורות שקליקטאק כותבת בהן.
 *
 * THE STORY THIS TEST TELLS. הגן אינו מקבל מזומן, ומשפחה שלא הגדירה אמצעי
 * תשלום צריכה טלפון לפני ספטמבר. שתי העובדות האלה יושבות בייצוא הנרשמים של
 * קליקטאק מהיום הראשון — בעמודה `צורת תשלום שכ"ל` ובארבע עמודות ההו"ק — ואף
 * אחד לא הסתכל בהן. משפחה שמשלמת במזומן ומשפחה בלי אמצעי תשלום בכלל נראו
 * בדיוק כמו משפחה עם כרטיס אשראי.
 *
 * WHAT MUST HOLD:
 *   1. הטקסט הוא של הספק ואינו חוזה. הו"ק / הו״ק / הו׳ק / הוראת-קבע /
 *      "  הוראת   קבע  " — כולם אותו דבר, כי מה שמשתנה בשטח הוא הגרש והרווח.
 *   2. ריק, undefined, null ורווחים בלבד — "לא הוגדר אמצעי תשלום", כי כאן לא
 *      הוחלט כלום.
 *   3. כל מחרוזת שיש בה מזומן — נדחית, גם אם כתוב בה עוד משהו. חצי במזומן זה
 *      מזומן.
 *   4. הוראת קבע היא חסרה ולעולם לא שגויה: המשפחה בחרה אמצעי שהגן מקבל ופרטי
 *      הבנק לא הגיעו. חסר קוד בנק או חסר חשבון — שניהם חסרים.
 *   5. כרטיס אשראי, ותווית שלא מוכרת לנו — אין התרעה. להמציא בעיה מתווית
 *      שטרם ראינו זה לשלוח את המשרד לטלפון מיותר.
 *   6. שורה שהגיעה רק מייצוא החוזים אינה מסומנת כ"לא הוגדר": אין בקובץ הזה
 *      עמודת תשלום בכלל. היא כבר מסומנת "חסר פרטי הורים", וזאת התלונה הנכונה.
 *
 * NO DATABASE AND NO SERVER — this is one pure function in
 * src/services/paymentCheck.js, which is exactly why it lives in its own file.
 *
 *   node scripts/payment-check.test.js
 */
const {
  paymentAlert, paymentAlertFor, paymentMethodCounts, normalizeMethod, LABELS,
  classifyPaymentMethod, paymentMethodFor,
} = require('../src/services/paymentCheck');

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

/** The alert's code alone — the label is asserted separately, once each. */
const codeOf = (method, so) => paymentAlert({ tuition_method: method }, so)?.code ?? null;

const BANK = { bank: '12', branch: '650', account: '123456', holder_name: 'אם' };

console.log('=== אמצעי תשלום — הכלל על הטקסט של קליקטאק ===');

/* ================================================================== */
head('בדיקה 1 — נרמול: מה שמשתנה בשטח הוא הגרש והרווח');
{
  eq(normalizeMethod('  הוראת קבע  '), 'הוראת קבע', '1a רווחים בקצוות נחתכים');
  eq(normalizeMethod('הוראת   קבע'), 'הוראת קבע', '1b רצף רווחים מתכווץ לאחד');
  eq(normalizeMethod('הו"ק'), 'הוק', '1c גרשיים ASCII נופלים');
  eq(normalizeMethod('הו״ק'), 'הוק', '1d גרשיים עבריים (U+05F4) נופלים');
  eq(normalizeMethod('הו׳ק'), 'הוק', '1e גרש עברי (U+05F3) נופל');
  eq(normalizeMethod('הוראת-קבע'), 'הוראת קבע', '1f מקף הופך לרווח');
  eq(normalizeMethod('הוראת־קבע'), 'הוראת קבע', '1g וגם מקף עברי (U+05BE)');
  eq(normalizeMethod(undefined), '', '1h undefined הוא מחרוזת ריקה, לא "undefined"');
  eq(normalizeMethod(null), '', '1i וגם null');
  // Hebrew is not lower-cased or transliterated — a value must survive intact.
  eq(normalizeMethod('כרטיס אשראי'), 'כרטיס אשראי', '1j ערך תקין עובר כמו שהוא');
}

/* ================================================================== */
head('בדיקה 2 — לא הוגדר אמצעי תשלום');
{
  eq(codeOf(''), 'missing', '2a מחרוזת ריקה');
  eq(codeOf('   '), 'missing', '2b רווחים בלבד');
  eq(codeOf(undefined), 'missing', '2c undefined');
  eq(codeOf(null), 'missing', '2d null');
  eq(paymentAlert(undefined, undefined)?.code, 'missing', '2e אין enrollment בכלל');
  eq(paymentAlert({}, {})?.code, 'missing', '2f enrollment בלי השדה');
  eq(paymentAlert({ tuition_method: '' }).label, LABELS.missing, '2g והתווית היא של missing');
  eq(LABELS.missing, 'לא הוגדר אמצעי תשלום לשכ"ל', '2h התווית עצמה');
}

/* ================================================================== */
head('בדיקה 3 — מזומן אינו מתקבל');
{
  eq(codeOf('מזומן'), 'cash', '3a מזומן');
  eq(codeOf('  מזומן  '), 'cash', '3b עם רווחים');
  eq(codeOf('מזומן / העברה בנקאית'), 'cash', '3c חצי במזומן הוא מזומן');
  eq(codeOf('תשלום במזומן בתחילת החודש'), 'cash', '3d גם כשהוא בתוך משפט');
  // Cash wins over a complete standing order — the method is refused whatever
  // else the family also filled in.
  eq(codeOf('מזומן', BANK), 'cash', '3e ואפילו כשפרטי הבנק מלאים');
  eq(paymentAlert({ tuition_method: 'מזומן' }).label, LABELS.cash, '3f התווית');
  eq(LABELS.cash, 'מזומן — לא מתקבל', '3g התווית עצמה');
}

/* ================================================================== */
head('בדיקה 4 — הוראת קבע: חסרה, לעולם לא שגויה');
{
  const forms = ['הוראת קבע', 'הוראת-קבע', 'הו"ק', 'הו״ק', 'הו׳ק', 'הוק', '  הוראת   קבע '];
  forms.forEach((f, i) => {
    eq(codeOf(f), 'incomplete', `4a.${i + 1} "${f}" ללא פרטי בנק — חסרה`);
  });
  forms.forEach((f, i) => {
    eq(codeOf(f, BANK), null, `4b.${i + 1} "${f}" עם בנק וחשבון — אין התרעה`);
  });

  eq(codeOf('הוראת קבע', { bank: '12', account: '' }), 'incomplete', '4c חסר חשבון');
  eq(codeOf('הוראת קבע', { bank: '', account: '123456' }), 'incomplete', '4d חסר קוד בנק');
  eq(codeOf('הוראת קבע', { bank: '  ', account: '  ' }), 'incomplete', '4e רווחים אינם פרטים');
  eq(codeOf('הוראת קבע', undefined), 'incomplete', '4f אין standing_order בכלל');
  // The caller that forgets to pass it gets the same answer as the family that
  // never filled it in — which is why every caller must pass it.
  eq(paymentAlert({ tuition_method: 'הו"ק' }).label, LABELS.incomplete, '4g התווית');
  eq(LABELS.incomplete, 'הוראת קבע ללא פרטי בנק', '4h התווית עצמה');
  // The bank BRANCH is not required: a הו"ק is filed on a bank code and an
  // account number, and demanding a third field would flag complete families.
  eq(codeOf('הוראת קבע', { bank: '12', account: '123456' }), null, '4i סניף אינו נדרש');
}

/* ================================================================== */
head('בדיקה 5 — מה שאינו התרעה');
{
  eq(codeOf('כרטיס אשראי'), null, '5a כרטיס אשראי');
  eq(codeOf('כרטיס אשראי', undefined), null, '5b וגם בלי הוראת קבע כלל');
  // An unrecognised label is NOT an alert. Inventing a problem out of wording
  // we have not seen yet sends the office on a phone call it does not need.
  eq(codeOf('העברה בנקאית'), null, '5c תווית שאיננו מכירים — לא מומצאת בעיה');
  eq(codeOf('אפליקציית ביט'), null, '5d וגם זו');
}

/* ================================================================== */
head('בדיקה 6 — שורה מייצוא החוזים בלבד אינה "לא הוגדר"');
{
  const contractsOnly = { sources: ['contracts'], enrollment: {}, standing_order: {} };
  eq(paymentAlertFor(contractsOnly), null, '6a אין עמודת תשלום בקובץ — אין התרעה');

  // The same empty row, once the registrations export has filled it in: now
  // the blank IS a statement, and it is flagged.
  eq(paymentAlertFor({ ...contractsOnly, sources: ['contracts', 'registrations'] })?.code,
    'missing', '6b ואחרי שהנרשמים נקלטו — כן');
  eq(paymentAlertFor({ sources: ['registrations'], enrollment: { tuition_method: 'מזומן' } })?.code,
    'cash', '6c שורת נרשמים רגילה נבדקת');
  // Rows written before the contracts export was supported have no `sources`
  // at all, and every one of them came from the registrations file.
  eq(paymentAlertFor({ enrollment: { tuition_method: '' } })?.code, 'missing',
    '6d שורה ישנה בלי sources נקראת כשורת נרשמים');
  eq(paymentAlertFor({ sources: [], enrollment: { tuition_method: '' } })?.code, 'missing',
    '6e וגם sources ריק');
  // A row that is not there at all reads as a registrations row with nothing
  // filled in — the same answer as an empty one, and never an exception. The
  // callers map over query results, so a throw here would take a whole screen
  // down over one malformed record.
  eq(paymentAlertFor(undefined)?.code, 'missing', '6f ושורה שאינה קיימת אינה מפילה כלום');
}

/* ================================================================== */
head('בדיקה 7 — ספירת הערכים הגולמיים');
{
  const docs = [
    { enrollment: { tuition_method: 'כרטיס אשראי' } },
    { enrollment: { tuition_method: 'כרטיס אשראי' } },
    { enrollment: { tuition_method: '  כרטיס אשראי  ' } },
    { enrollment: { tuition_method: 'מזומן' } },
    { enrollment: {} },
    {},
  ];
  const counts = paymentMethodCounts(docs);
  eq(counts[0], { value: 'כרטיס אשראי', count: 3 }, '7a הערך השכיח ראשון, אחרי trim');
  // The empty string is a value like any other here: "how many families have
  // no method at all" is the first number the office wants.
  eq(counts.find(c => c.value === '')?.count, 2, '7b הריקים נספרים ואינם נעלמים');
  eq(counts.find(c => c.value === 'מזומן')?.count, 1, '7c ומזומן');
  eq(paymentMethodCounts([]), [], '7d רשימה ריקה');
  eq(paymentMethodCounts(), [], '7e ובלי ארגומנט בכלל');
}

/* ================================================================== */
head('בדיקה 8 — לכל שיטה שם משלה, כדי שיהיה לה צבע משלה');
{
  const kindOf = (v) => classifyPaymentMethod(v).kind;

  eq(kindOf('הוראת קבע'), 'standing_order', '8a הוראת קבע');
  eq(kindOf('הו"ק'), 'standing_order', '8b וגם בקיצור');
  eq(kindOf('הרשאה לחיוב חשבון'), 'standing_order', '8c והרשאה לחיוב היא אותו דבר');
  eq(kindOf('כרטיס אשראי'), 'credit_card', '8d כרטיס אשראי');
  eq(kindOf('אשראי'), 'credit_card', '8e וגם מילה אחת');
  eq(kindOf('העברה בנקאית'), 'bank_transfer', '8f העברה בנקאית — שיטה מתקבלת');
  eq(kindOf("צ'ק"), 'cheque', '8g צ׳ק עם גרש ASCII');
  eq(kindOf('צ׳ק'), 'cheque', '8h וגם עם גרש עברי');
  eq(kindOf('שיקים'), 'cheque', '8i וגם ברבים');
  eq(kindOf('המחאה'), 'cheque', '8j וגם בשמה הרשמי');
  eq(kindOf('מזומן'), 'cash', '8k מזומן');
  eq(kindOf(''), 'none', '8l ריק');
  eq(kindOf(undefined), 'none', '8m ו-undefined');
  eq(kindOf('אפליקציית ביט'), 'other', '8n תווית שאיננו מכירים היא "אחר", לא שגיאה');
  // The raw text survives as the label — otherwise a label ClickTac invented
  // last week becomes invisible the moment it is classified.
  eq(classifyPaymentMethod('  אפליקציית ביט  ').label, 'אפליקציית ביט',
    '8o והתווית של "אחר" היא מה שהספק כתב');

  // Order of the rules, where a family wrote more than one thing.
  eq(kindOf('מזומן / העברה בנקאית'), 'cash', '8p חצי במזומן הוא מזומן');
  eq(kindOf('הוראת קבע באשראי'), 'standing_order', '8q הוראת קבע גוברת על אשראי');
}

/* ================================================================== */
head('בדיקה 9 — "לא רלוונטי" אינו אמצעי תשלום');
{
  eq(classifyPaymentMethod('לא רלוונטי').kind, 'none', '9a לא רלוונטי הוא "לא הוגדר"');
  eq(codeOf('לא רלוונטי'), 'missing', '9b ולכן ההתרעה היא "לא הוגדר אמצעי תשלום"');
  eq(paymentAlert({ tuition_method: 'לא רלוונטי' }).severity, 'error', '9c והיא שגיאה');
  // עברית כותבת את המילה גם בבי"ת, והמשרד מקליד את מה שהוא מקליד. איות
  // שהרשימה אינה מכירה נקרא כ-other ונכנס לטבלה כאילו הוא אמצעי תשלום שנבחר.
  eq(classifyPaymentMethod('לא רלבנטי').kind, 'none', '9d גם באיות בבי"ת');
  eq(codeOf('לא רלבנטי'), 'missing', '9e ואותה התרעה בדיוק');
}

/* ================================================================== */
head('בדיקה 10 — צ׳ק מתקבל, ומסומן ברכות');
{
  eq(codeOf("צ'ק"), 'cheque', '10a לצ׳ק יש קוד משלו');
  eq(paymentAlert({ tuition_method: "צ'ק" }).severity, 'warning',
    '10b והוא אזהרה — לא שגיאה, כי הגן מקבל צ׳קים');
  eq(paymentAlert({ tuition_method: "צ'ק" }).label, LABELS.cheque, '10c התווית');
  eq(LABELS.cheque, 'צ\'ק — מומלץ לעבור להו"ק', '10d התווית עצמה — המלצה, לא סירוב');
  // The three that stop the money stay errors, and that is what the counter
  // on the screen counts.
  eq(paymentAlert({ tuition_method: 'מזומן' }).severity, 'error', '10e מזומן נשאר שגיאה');
  eq(paymentAlert({ tuition_method: '' }).severity, 'error', '10f וגם "לא הוגדר"');
  eq(paymentAlert({ tuition_method: 'הו"ק' }).severity, 'error', '10g וגם הו"ק ללא בנק');
  // העברה בנקאית — מתקבלת, ואין עליה מה לומר בכלל.
  eq(codeOf('העברה בנקאית'), null, '10h והעברה בנקאית אינה מעלה דבר');
}

/* ================================================================== */
head('בדיקה 11 — הצ׳יפ של השיטה, לפי אותו כלל מקורות');
{
  eq(paymentMethodFor({ sources: ['contracts'], enrollment: {} }), null,
    '11a שורת חוזים בלבד — אין צ׳יפ, כי אין בקובץ עמודת תשלום');
  eq(paymentMethodFor({ sources: ['registrations'], enrollment: { tuition_method: "צ'ק" } })?.kind,
    'cheque', '11b שורת נרשמים מסווגת');
  eq(paymentMethodFor({ enrollment: { tuition_method: '' } })?.kind, 'none',
    '11c ושורה ישנה בלי sources נקראת כשורת נרשמים');
  eq(paymentMethodFor(undefined)?.kind, 'none', '11d ושורה שאינה קיימת אינה מפילה כלום');
}

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} בדיקות עברו`);
process.exit(failures === 0 ? 0 : 1);
