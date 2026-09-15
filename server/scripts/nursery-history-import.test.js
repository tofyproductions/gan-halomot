/**
 * Reading the old board's export.
 *
 * The import runs once, against eight months of a family's record, and there
 * is no second export to compare it against afterwards. So the conversion is
 * tested here rather than trusted: every assertion below is a value that
 * actually appears in the Moshe Dayan export, and three of them are mistakes
 * that were made before they were caught.
 *
 * Pure — no database, no file, no network unless the real export happens to be
 * on the machine, in which case the last block reads it too.
 *
 *   node scripts/nursery-history-import.test.js
 */

const assert = require('assert');
const fs = require('fs');
const H = require('./lib/nursery-history');

let failures = 0;
function check(label, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`  ✓ ${label}`);
  } catch {
    failures += 1;
    console.log(`  ✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// --- Trap 1 ---------------------------------------------------------------

console.log('\nזמנים מאוחסנים כשבר של יממה');
check('0.28125 → 06:45', H.cellToTime(0.28125), '06:45');
check('0.75 as a time → 18:00', H.cellToTime(0.75), '18:00');
check('0.3020833333333333 → 07:15', H.cellToTime(0.3020833333333333), '07:15');
check('0.3715277777777778 → 08:55', H.cellToTime(0.3715277777777778), '08:55');
check('0 → 00:00', H.cellToTime(0), '00:00');
check('a string that already reads as a time passes through', H.cellToTime('09:20'), '09:20');
check('a number ≥ 1 is millilitres in the wrong column, not a time', H.cellToTime(180), '');
check('a sentence is not a time', H.cellToTime('בקבוק תמל 180'), '');
check('a malformed time is refused rather than half-read', H.cellToTime('9:5'), '');
check('empty stays empty', H.cellToTime(null), '');

console.log('\nשעון 12 שעות — היום הראשון של קפלן');
check('"11:00:00 AM" → 11:00', H.cellToTime('11:00:00 AM'), '11:00');
check('"9:00:00 AM" → 09:00', H.cellToTime('9:00:00 AM'), '09:00');
check('"1:30 PM" → 13:30', H.cellToTime('1:30 PM'), '13:30');
check('"12:15 AM" → 00:15', H.cellToTime('12:15 AM'), '00:15');
check('"12:15 PM" נשאר 12:15', H.cellToTime('12:15 PM'), '12:15');
check('"13:45:00" בלי AM/PM', H.cellToTime('13:45:00'), '13:45');
check('"25:00 PM" עדיין נדחה', H.cellToTime('25:00 PM'), '');

console.log('\nאותה עמודה מחזיקה גם שבר וגם מחרוזת');
check('0.75 as an amount → 75%', H.cellToPortion(0.75), '75%');
check('0 as an amount → 0%', H.cellToPortion(0), '0%');
check('1 as an amount → 100%', H.cellToPortion(1), '100%');
check('0.25 → 25%', H.cellToPortion(0.25), '25%');
check('210 is millilitres, not 21000%', H.cellToPortion(210), '210');
check('"בקבוק תמל 180" survives verbatim', H.cellToPortion('בקבוק תמל 180'), 'בקבוק תמל 180');
check('"120 תמ״ל צמחי" survives verbatim', H.cellToPortion('120 תמ״ל צמחי'), '120 תמ״ל צמחי');
check('"הנקה" survives verbatim', H.cellToPortion('הנקה'), 'הנקה');
check('"75%" already rendered passes through', H.cellToPortion('75%'), '75%');

// --- Trap 2 ---------------------------------------------------------------

console.log('\nאותו שם שדה בשתי צורות');
check('גרשיים עבריים ↔ גרש ASCII', H.normalizeFieldName('תמ״ל בוקר'), H.normalizeFieldName('תמ"ל בוקר'));
check('the sheet header carries a newline the JSON does not',
  H.normalizeFieldName('שנת בוקר \nשעת השכבה'), H.normalizeFieldName('שנת בוקר שעת השכבה'));
check('the sheet spelling finds the mapping', !!H.FIELD_MAP[H.normalizeFieldName('תמ״ל צהריים')], true);
check('the JSON spelling finds the same mapping', !!H.FIELD_MAP[H.normalizeFieldName('תמ"ל צהריים')], true);
check('both reach the same field',
  H.FIELD_MAP[H.normalizeFieldName('תמ״ל 4')].path,
  H.FIELD_MAP[H.normalizeFieldName('תמ"ל 4')].path);
check('a naive string compare is what would have failed', 'תמ״ל בוקר' === 'תמ"ל בוקר', false);

console.log('\nהנרמול לא נוגע בשמות מנות');
check('קוטג׳ keeps its geresh', H.cellToText('קוטג׳'), 'קוטג׳');
check('מג׳דרה keeps its geresh', H.menuSelections({ 'צהריים - פחמימה': 'מג׳דרה' }).selections['lunch.פחמימה'], ['מג׳דרה']);

// --- The eighteen fields --------------------------------------------------

console.log('\nיום שלם של ילד אחד, כמו שהוא מופיע בייצוא');
const DAY = {
  'נוכחות': '',
  'ארוחת בוקר': '75%',
  'תמ"ל בוקר': '120',
  'שנת בוקר שעת השכבה': '09:20',
  'שנת בוקר שעת השכמה': '10:15',
  'ארוחת צהריים': '100%',
  'תמ"ל צהריים': '180',
  'שנת צהריים שעת השכבה': '12:50',
  'שנת צהריים שעת השכמה': '14:40',
  'ארוחת 4': '50%',
  'תמ"ל 4': '90',
  'יציאות': '2',
  'מה חסר': 'משחת החתלה, טיטולים',
  'הערות': 'לא ישן בבוקר',
  'התעורר בבית': '06:00',
  'אכל בבית - שעה': '06:45',
  'אכל בבית - כמות': 'הנקה',
  'הערת הורים': 'ישן טוב',
};
const day = H.dailyLogSet(DAY);
check('every field maps', day.unmapped, []);
check('nothing is rejected', day.rejected, []);
check('the set is the DailyLog paths', day.set, {
  'home.wake_time': '06:00',
  'home.meal_time': '06:45',
  'home.meal_amount': 'הנקה',
  'home.parent_note': 'ישן טוב',
  'meals.breakfast.amount': '75%',
  'meals.breakfast.formula': '120',
  'meals.lunch.amount': '100%',
  'meals.lunch.formula': '180',
  'meals.snack.amount': '50%',
  'meals.snack.formula': '90',
  'sleep.morning.start': '09:20',
  'sleep.morning.end': '10:15',
  'sleep.noon.start': '12:50',
  'sleep.noon.end': '14:40',
  diapers: '2',
  missing: ['משחת החתלה', 'טיטולים'],
  staff_note: 'לא ישן בבוקר',
});
check('נוכחות is empty in the source and so is never written', 'attendance' in day.set, false);

console.log('\nהייבוא לא מוחק');
check('an all-blank day writes nothing at all',
  Object.keys(H.dailyLogSet(Object.fromEntries(Object.keys(DAY).map(k => [k, '']))).set).length, 0);
check('a field the export does not know is reported, not dropped silently',
  H.dailyLogSet({ 'שדה חדש': 'משהו' }).unmapped, [{ field: 'שדה חדש', value: 'משהו' }]);
check('a blank unknown field is not worth reporting',
  H.dailyLogSet({ 'שדה חדש': '' }).unmapped, []);
check('a broken time is rejected with its field named',
  H.dailyLogSet({ 'התעורר בבית': '25:99' }).rejected,
  [{ field: 'התעורר בבית', path: 'home.wake_time', value: '25:99' }]);

console.log('\nמה חסר — רשימה, לא מחרוזת');
check('comma separated', H.splitMissing('תמ״ל, סינרים, גרביים'), ['תמ״ל', 'סינרים', 'גרביים']);
check('a sloppy separator still splits', H.splitMissing('מגבונים ,טיטולים'), ['מגבונים', 'טיטולים']);
check('two words are one item', H.splitMissing('משחת החתלה'), ['משחת החתלה']);
check('empty is an empty list', H.splitMissing(''), []);

// --- The menu -------------------------------------------------------------

console.log('\nתפריט — מפתחות הגיליון והמפתחות של הלוח');
check('בוקר - חלבון → breakfast.חלבון', H.menuKey('בוקר - חלבון'), 'breakfast.חלבון');
check('צהריים - ירק → lunch.ירק', H.menuKey('צהריים - ירק'), 'lunch.ירק');
check('4 - כריך → snack.כריך', H.menuKey('4 - כריך'), 'snack.כריך');
check('an unknown meal maps to nothing', H.menuKey('ערב - חלבון'), null);

const menu = H.menuSelections({
  'בוקר - חלבון': 'יוגורט|קוטג׳',
  'בוקר - קבוע': '',
  'צהריים - פחמימה': 'תפוח אדמה|פתיתים',
  'ערב - משהו': 'משהו',
}, H.knownDishSet({
  breakfast: { categories: { 'חלבון': ['יוגורט', 'קוטג׳'] } },
  lunch: { categories: { 'פחמימה': ['תפוח אדמה'] } },
}));
check('pipe-joined dishes become an array', menu.selections['breakfast.חלבון'], ['יוגורט', 'קוטג׳']);
check('a single dish is still an array', H.menuSelections({ 'בוקר - ירק': 'מלפפון' }).selections['בוקר - ירק'], undefined);
check('one dish, one-element array', H.menuSelections({ 'בוקר - ירק': 'מלפפון' }).selections['breakfast.ירק'], ['מלפפון']);
check('an empty line is not a selection', 'breakfast.קבוע' in menu.selections, false);
check('an unknown key is reported', menu.unknownKeys, ['ערב - משהו']);
check('a dish the current menu does not offer is reported, not dropped',
  menu.unknownDishes, [{ key: 'lunch.פחמימה', dish: 'פתיתים' }]);
check('…and is still imported', menu.selections['lunch.פחמימה'], ['תפוח אדמה', 'פתיתים']);

// --- Choosing between snapshots of the same day ---------------------------

console.log('\nכמה snapshots לאותו תאריך');
const full = {
  children: [
    { name: 'א', data: { 'ארוחת בוקר': '75%', 'התעורר בבית': '06:00' } },
    { name: 'ב', data: { 'ארוחת בוקר': '50%' } },
  ],
};
const emptied = { children: [{ name: 'א', data: { 'ארוחת בוקר': '' } }, { name: 'ב', data: { 'ארוחת בוקר': '' } }] };

check('a full board scores its filled fields', H.snapshotScore(full), 3);
check('a wiped board scores nothing', H.snapshotScore(emptied), 0);
check("the day's menu counts too", H.snapshotScore({ children: [], menu: { selected: { a: 'x', b: '' } } }), 1);

// 2026-01-17, exactly as it is in the export: the later archive ran after the
// nightly reset had already wiped the sheet, and holds nineteen empty rows.
const jan17 = [
  { date: '2026-01-17', timestamp: '17/01/2026 | 00:03', payload: full },
  { date: '2026-01-17', timestamp: '18/01/2026 | 00:04', payload: emptied },
];
check('richest keeps the day that has the day in it',
  H.chooseSnapshot(jan17, 'richest').chosen.timestamp, '17/01/2026 | 00:03');
check('latest — what the sheet would have said — loses it',
  H.chooseSnapshot(jan17, 'latest').chosen.timestamp, '18/01/2026 | 00:04');

// 2026-02-01: both runs hold something, the later holds more.
const feb1 = [
  { date: '2026-02-01', timestamp: '01/02/2026 | 09:23', payload: { children: [{ data: { a: 'x' } }] } },
  { date: '2026-02-01', timestamp: '01/02/2026 | 23:24', payload: { children: [{ data: { a: 'x', b: 'y' } }] } },
];
check('when the later run holds more, both modes agree',
  H.chooseSnapshot(feb1, 'richest').chosen.timestamp, H.chooseSnapshot(feb1, 'latest').chosen.timestamp);
check('equal richness falls back to the later stamp',
  H.chooseSnapshot([
    { timestamp: '01/02/2026 | 09:23', payload: { children: [{ data: { a: 'x' } }] } },
    { timestamp: '01/02/2026 | 23:24', payload: { children: [{ data: { b: 'y' } }] } },
  ], 'richest').chosen.timestamp, '01/02/2026 | 23:24');
check('no snapshots, no choice', H.chooseSnapshot([]), null);

console.log('\nחותמת הזמן של הארכיון');
check('DD/MM/YYYY | HH:MM', H.parseTimestamp('18/01/2026 | 00:04'), Date.UTC(2026, 0, 18, 0, 4));
check('an unreadable stamp sorts first, never wins on its own', H.parseTimestamp('שטויות'), 0);
check('day before month — 12/09 is September, not December',
  H.parseTimestamp('12/09/2026 | 23:36') < H.parseTimestamp('13/09/2026 | 23:37'), true);

// --- Dates and phones -----------------------------------------------------

console.log('\nתאריכי לידה');
check('45897 → 2025-08-28', H.excelSerialToDateKey(45897), '2025-08-28');
check('46190 → 2026-06-17', H.excelSerialToDateKey(46190), '2026-06-17');
check('not a serial, not a date', H.excelSerialToDateKey('2025-08-28'), '');

// --- The explicit name map ------------------------------------------------

console.log('\nמיפוי שמות מפורש — רק מה שכתוב, ורק כשהמסד לא זז');
const { resolveChild, NAME_ALIASES, aliasesFor } = require('./import-nursery-history');
const idx = (name, ...kids) => new Map([[name.split(/\s+/).sort().join(' '), kids]]);
const kid = (name, dob) => ({ _id: 'x', child_name: name, birth_date: dob ? new Date(`${dob}T00:00:00Z`) : null });
const ALIAS = { from: 'אתי שיר', to: 'איתי שיר', db_birth_date: '2026-02-01' };

check('מיפוי תופס כשת. הלידה במסד היא זו שאומתה',
  resolveChild({ name: 'איתי שיר', dob: '2026-02-01' }, idx('איתי שיר', kid('איתי שיר', '2026-02-01')), ALIAS).child?.child_name,
  'איתי שיר');
check('הייצוא רשאי לחלוק על ת. הלידה — נבדק מול המסד',
  resolveChild({ name: 'איתי שיר', dob: '1999-01-01' }, idx('איתי שיר', kid('איתי שיר', '2026-02-01')), ALIAS).child?.child_name,
  'איתי שיר');
check('אבל אם המסד זז מאז האימות — דילוג',
  resolveChild({ name: 'איתי שיר', dob: '2026-02-01' }, idx('איתי שיר', kid('איתי שיר', '2026-03-09')), ALIAS).child,
  null);
check('והדילוג מדווח כדו-משמעי, לא כ"לא נמצא"',
  resolveChild({ name: 'איתי שיר' }, idx('איתי שיר', kid('איתי שיר', '2026-03-09')), ALIAS).ambiguous, true);
check('שני יעדים באותו שם — דילוג',
  resolveChild({ name: 'איתי שיר' }, idx('איתי שיר', kid('איתי שיר', '2026-02-01'), kid('איתי שיר', '2026-02-01')), ALIAS).child,
  null);
check('יעד שנעלם — דילוג', resolveChild({ name: 'איתי שיר' }, new Map(), ALIAS).child, null);

const MISSING_DOB = { from: 'פאר אסתר', to: 'פאר אסתר עומייסי', db_birth_date: '' };
check('ת. לידה חסרה במסד היא ערך תקף לאימות',
  resolveChild({ name: 'פאר אסתר עומייסי', dob: '2025-03-10' },
    idx('פאר אסתר עומייסי', kid('פאר אסתר עומייסי', null)), MISSING_DOB).child?.child_name,
  'פאר אסתר עומייסי');
check('ואם הופיע תאריך — מישהו ערך, דילוג',
  resolveChild({ name: 'פאר אסתר עומייסי' },
    idx('פאר אסתר עומייסי', kid('פאר אסתר עומייסי', '2025-03-10')), MISSING_DOB).child,
  null);

console.log('\nהרשימה עצמה');
check('שישה מיפויים בלבד', NAME_ALIASES.length, 6);
check('כל אחד נושא סניף, מקור, יעד ות. לידה',
  NAME_ALIASES.every(a => a.branch && a.from && a.to && typeof a.db_birth_date === 'string'), true);
check('אין מקור כפול', new Set(NAME_ALIASES.map(a => `${a.branch}|${a.from}`)).size, NAME_ALIASES.length);
check('ארבעה למשה דיין', aliasesFor('כפר סבא - משה דיין').size, 4);
check('ושניים לקפלן', aliasesFor('כפר סבא - קפלן').size, 2);
check('סניף אחר לא מקבל כלום', aliasesFor('הרצליה הרצוג').size, 0);
check('"אלה צרור" אינה ברשימה — דומה בשם ואינה אותה ילדה',
  NAME_ALIASES.some(a => a.from === 'אלה צרור'), false);

// --- The two exports disagree ---------------------------------------------

console.log('\nטלפון — ארבע צורות, מספר אחד');
check('משה דיין: מספר, האפס המוביל אבד', H.normalizePhone(523221102), '0523221102');
check('קפלן: מחרוזת, האפס נשמר', H.normalizePhone('0528810181'), '0528810181');
check('קפלן: מספר עם אפס חסר', H.normalizePhone(544611229), '0544611229');
check('ההיסטוריה של קפלן: E.164 בלי פלוס', H.normalizePhone('972546390903'), '0546390903');
check('E.164 עם פלוס', H.normalizePhone('+972-52-881-0181'), '0528810181');
check('בלי טלפון זה לגיטימי, לא שגיאה', H.normalizePhone(null), '');
check('שתי הצורות של אותו מספר מתלכדות',
  H.normalizePhone('972528810181'), H.normalizePhone('0528810181'));

console.log('\nעמודת התאריך — מחרוזת, serial, וזבל');
check('משה דיין: מחרוזת', H.normalizeDateKey('2026-01-17'), '2026-01-17');
check('קפלן: serial 46035 → 2026-01-13', H.normalizeDateKey(46035), '2026-01-13');
check('serial עם שבר יממה מתעגל כלפי מטה ליום', H.normalizeDateKey(46035.9), '2026-01-13');
check('"Unknown Date" נדחה, לא מנוחש', H.normalizeDateKey('Unknown Date'), '');
check('מספר שאינו תאריך סביר נדחה', H.normalizeDateKey(7), '');
check('מחרוזת ריקה נדחית', H.normalizeDateKey(''), '');

console.log('\nחותמת זמן — גם מחרוזת וגם serial');
check('serial של קפלן נקרא', H.parseTimestamp(46035.18352839121) > 0, true);
check('serial מוקדם יותר קטן יותר',
  H.parseTimestamp(46035.18352839121) < H.parseTimestamp(46035.196123761576), true);
check('serial ומחרוזת מדורגים באותו סולם',
  H.parseTimestamp(46035) < H.parseTimestamp('14/01/2026 | 08:24'), true);
check('זבל עדיין 0', H.parseTimestamp('Unknown Date'), 0);

console.log('\nשורש ה-JSON — שתי צורות באותו קובץ');
check('מערך חשוף הוא הרשימה', H.historyChildren([{ name: 'א' }]), [{ name: 'א' }]);
check('אובייקט עם children', H.historyChildren({ children: [{ name: 'ב' }], menu: {} }), [{ name: 'ב' }]);
check('מערך ריק הוא יום ריק, לא שגיאה', H.historyChildren([]), []);
let threw = null;
try { H.historyChildren({ kids: [] }); } catch (e) { threw = e.message; }
check('אובייקט בלי children זורק ולא מחזיר ריק בשקט', /שורש JSON לא מוכר/.test(threw || ''), true);
try { threw = null; H.historyChildren(null); } catch (e) { threw = e.message; }
check('null זורק', /שורש JSON לא מוכר/.test(threw || ''), true);
check('למערך חשוף אין תפריט', H.historyMenu([{ name: 'א' }]), null);
check('לאובייקט יש', H.historyMenu({ children: [], menu: { selected: {} } }), { selected: {} });
check('הניקוד קורא את שתי הצורות',
  H.snapshotScore([{ data: { a: 'x', b: '' } }]), H.snapshotScore({ children: [{ data: { a: 'x', b: '' } }] }));
check('שורש שבור מנקד 0 ולא מפיל את הבחירה', H.snapshotScore({ kids: [] }), 0);

console.log('\nסט שדות לא אחיד — 17 מול 18');
const seventeen = { ...DAY };
delete seventeen['הערת הורים'];
const short = H.dailyLogSet(seventeen);
check('שדה חסר הוא חסר, לא שגיאה', short.unmapped, []);
check('ולא נכתב', 'home.parent_note' in short.set, false);
check('ושאר 17 השדות נכתבים', Object.keys(short.set).length, Object.keys(day.set).length - 1);

// --- The real file, when it is here ---------------------------------------

/**
 * Both exports, when they are here. Neither is the reference the other has to
 * match: Moshe Dayan is one shape throughout and Kaplan changes shape three
 * days in, so a parser built against either one alone is a parser that loses
 * the other.
 *
 *   NURSERY_EXPORT_XLSX=<משה דיין> NURSERY_EXPORT_KAPLAN_XLSX=<קפלן> node ...
 */
function readWholeExport(file) {
  const parsed = H.readWorkbook(file);
  let unmapped = 0, rejected = 0, childDays = 0, filled = 0, shapeErrors = 0;
  const names = new Set(), ids = new Set();
  for (const snapshots of parsed.history.byDate.values()) {
    for (const s of snapshots) {
      let children;
      try { children = H.historyChildren(s.payload); } catch { shapeErrors += 1; continue; }
      for (const c of children) {
        childDays += 1;
        names.add(c.name);
        if (c.accessId) ids.add(c.accessId);
        const r = H.dailyLogSet(c.data);
        unmapped += r.unmapped.length;
        rejected += r.rejected.length;
        if (Object.keys(r.set).length) filled += 1;
      }
    }
  }
  return { parsed, unmapped, rejected, childDays, filled, shapeErrors, names, ids };
}

for (const [label, envVar] of [['משה דיין', 'NURSERY_EXPORT_XLSX'], ['קפלן', 'NURSERY_EXPORT_KAPLAN_XLSX']]) {
  const file = process.env[envVar];
  if (!file || !fs.existsSync(file)) {
    console.log(`\n(${envVar} לא הוגדר — הבדיקות מול הייצוא של ${label} דולגו)`);
    continue;
  }
  console.log(`\nהייצוא האמיתי — ${label}`);
  const r = readWholeExport(file);
  const dates = [...r.parsed.history.byDate.keys()];

  check('חמישה גיליונות', r.parsed.sheets.length, 5);
  check('הרוסטר נקרא', r.parsed.children.length > 0, true);
  check('ההיסטוריה נקראה', dates.length > 0, true);
  check('כל שורה שנקלטה היא בצורה שהפרסר מכיר', r.shapeErrors, 0);
  check('אף שדה לא נשאר בלי מיפוי', r.unmapped, 0);
  check('אף ערך לא נפסל', r.rejected, 0);
  check('כל תאריך שנקלט הוא YYYY-MM-DD', dates.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)), true);
  check('אין ימי-ילד שאבדו בשקט', r.childDays > 0 && r.filled > 0, true);

  const roster = r.parsed.children;
  check('לכל ילד ברוסטר יש AccessID', roster.every(c => /^[0-9a-f-]{36}$/.test(c.access_id)), true);
  check('כל טלפון ברוסטר מנורמל או ריק',
    roster.every(c => c.phone === '' || /^0\d{9}$/.test(c.phone)), true);

  console.log(`  · ${dates.length} ימים, ${r.childDays} ימי-ילד (${r.filled} עם נתונים), `
    + `${r.names.size} שמות, ${r.ids.size} accessIds, ${roster.length} ברוסטר, `
    + `${r.parsed.history.broken.length} שורות פגומות`);
}

// The two traps Kaplan adds, asserted against the file itself rather than
// against a fixture — a fixture would only prove that the fixture is right.
const KAPLAN = process.env.NURSERY_EXPORT_KAPLAN_XLSX;
if (KAPLAN && fs.existsSync(KAPLAN)) {
  console.log('\nמה שקפלן מוסיף, מול הקובץ עצמו');
  const parsed = H.readWorkbook(KAPLAN);

  const shapes = new Set();
  let serialDates = 0, serialStamps = 0, arrayRoots = 0;
  for (const [date, snapshots] of parsed.history.byDate) {
    for (const s of snapshots) {
      shapes.add(Array.isArray(s.payload) ? 'array' : 'object');
      if (Array.isArray(s.payload)) arrayRoots += 1;
      if (typeof s.timestamp === 'number') serialStamps += 1;
      if (date === '2026-01-13') serialDates += 0;
    }
  }
  check('שתי צורות שורש באותו קובץ', [...shapes].sort(), ['array', 'object']);
  check('שורשי מערך נקלטו ולא אבדו', arrayRoots > 0, true);
  check('חותמות serial נקלטו', serialStamps > 0, true);

  // "Unknown Date" is the only thing this file has that cannot be imported,
  // and it must appear in the report by name.
  const unknown = parsed.history.broken.filter(b => b.raw === 'Unknown Date');
  check('"Unknown Date" מדווח ולא מנוחש', unknown.length > 0, true);
  check('ולא נשאר תאריך פגום אחר', parsed.history.broken.length, unknown.length);

  // 2026-01-13 was archived forty times while the branch was being set up, and
  // the last of them is empty. This is the same trap as Moshe Dayan's
  // 2026-01-17 and it is worse: latest scores 0 against richest's 26.
  const jan13 = parsed.history.byDate.get('2026-01-13');
  check('2026-01-13 אורכב יותר מפעם אחת', jan13.length > 1, true);
  const rich = H.chooseSnapshot(jan13, 'richest');
  const late = H.chooseSnapshot(jan13, 'latest');
  check('richest בוחר יום שיש בו משהו', rich.chosen.score > 0, true);
  check('latest היה מייבא יום ריק', late.chosen.score, 0);

  // One child, two spellings, one token.
  const byId = new Map();
  for (const snapshots of parsed.history.byDate.values()) {
    for (const s of snapshots) {
      for (const c of H.historyChildren(s.payload)) {
        if (!c.accessId) continue;
        if (!byId.has(c.accessId)) byId.set(c.accessId, new Set());
        byId.get(c.accessId).add(c.name);
      }
    }
  }
  const twoNames = [...byId.values()].filter(s => s.size > 1);
  check('accessId אחד נושא שני איותים', twoNames.length > 0, true);
  check('והם איתן חכמון/חרמון', [...twoNames[0]].sort(), ['איתן חכמון', 'איתן חרמון']);
}

console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
