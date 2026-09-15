/**
 * The closed lists the whole board is filtered by.
 *
 * Areas and roles are NOT free text, and that is the decision the filters rest
 * on: "שכר טוב למתאימות" cannot be filtered and annoys the person reading it.
 * A gan picks from these or does not publish.
 *
 * Deliberately short. Six areas rather than thirty cities, because a filter
 * that scatters twelve jobs across thirty tabs shows an empty board in every
 * one of them. Split an area into cities when that area fills up — the value
 * here is the list, and adding to it is a one-line change plus a migration
 * note for jobs already published under the wider name.
 */

const AREAS = [
  { id: 'sharon',    label: 'שרון' },
  { id: 'gush_dan',  label: 'גוש דן' },
  { id: 'shfela',    label: 'שפלה' },
  { id: 'jerusalem', label: 'ירושלים והסביבה' },
  { id: 'north',     label: 'חיפה והצפון' },
  { id: 'south',     label: 'דרום' },
];

const ROLES = [
  { id: 'ganenet',        label: 'גננת' },
  { id: 'sayaat',         label: 'סייעת' },
  { id: 'metapelet',      label: 'מטפלת' },
  { id: 'manager',        label: 'מנהלת גן' },
  { id: 'cook',           label: 'טבחית' },
  { id: 'transport',      label: 'מלווה הסעות' },
  { id: 'sayaat_shiluv',  label: 'סייעת שילוב' },
];

/** How the salary range is quoted. Both are gross; the ad says which. */
const SALARY_UNITS = [
  { id: 'hourly',  label: 'לשעה' },
  { id: 'monthly', label: 'לחודש' },
];

const SCOPES = [
  { id: 'full',    label: 'משרה מלאה' },
  { id: 'partial', label: 'משרה חלקית' },
  { id: 'hours',   label: 'שעתי / לפי צורך' },
];

const AREA_IDS = AREAS.map(a => a.id);
const ROLE_IDS = ROLES.map(r => r.id);
const SALARY_UNIT_IDS = SALARY_UNITS.map(u => u.id);
const SCOPE_IDS = SCOPES.map(s => s.id);

const labelOf = (list, id) => (list.find(x => x.id === id) || {}).label || id;

/**
 * Wording a gan may not use, and why it is stopped rather than allowed.
 *
 * חוק שוויון ההזדמנויות בעבודה forbids requiring or preferring on these
 * grounds, and liability for a discriminatory ad can reach whoever published
 * it, not only the employer. Most gan managers do not know that — the phrasing
 * below is what they write today in Facebook groups without a thought.
 *
 * So a match does NOT reject the ad. It shows the gan what was caught, says
 * plainly that it is not allowed, and lets them fix it before publishing. That
 * teaches rather than punishes, and it is a thing a Facebook group will never
 * do for them.
 *
 * ⚠️ This list is a starting point written by a developer. It must be reviewed
 * by a lawyer before launch — both for what is missing and for what it catches
 * wrongly.
 */
/**
 * ⚠️ `\b` DOES NOT WORK HERE, and the first version of this file shipped
 * broken because of it. JavaScript defines a word boundary against `\w`,
 * which is [A-Za-z0-9_] — Hebrew letters are not in it, so `\bגיל\b` matches
 * in places nobody expects and fails in the places that matter. "דרושה גננת
 * עד גיל 35" went straight through. So boundaries here are written against
 * the Hebrew block itself.
 */
const H = '\\u0590-\\u05FF';
const B = (body) => new RegExp(`(?<![${H}])(?:${body})(?![${H}])`);

const FORBIDDEN_PATTERNS = [
  {
    ground: 'גיל',
    re: B('(עד|מתחת ל|מעל|מגיל)\\s*גיל\\s*\\d{1,2}|גיל\\s*\\d{1,2}\\s*(עד|ומעלה|ומטה)|עד\\s*\\d{2}\\s*(שנה|שנים)|צעיר(ה|ות)?|מבוגר(ת|ות)?'),
  },
  {
    ground: 'מצב משפחתי',
    re: B('רווק(ה|ות)?|נשוי|נשואה|נשואות|גרוש(ה|ות)?|ללא\\s*(ילדים|משפחה)|לא\\s*נשואה'),
  },
  {
    ground: 'הריון והורות',
    re: B('לא\\s*בהריון|ללא\\s*תינוק(ות)?|ללא\\s*ילדים\\s*קטנים|לא\\s*מתכננת\\s*הריון'),
  },
  {
    ground: 'דת',
    re: B('דתי(ה|ות)?|חילוני(ת|ות)?|חרדי(ת|ות)?|מסורתי(ת|ות)?|שומר(ת|ות)?\\s*(שבת|מסורת|כשרות)'),
  },
  {
    ground: 'מוצא ולאום',
    re: B('ילידת\\s*הארץ|עברית\\s*שפת\\s*אם|יהודי(ה|ות)?|ערבי(ה|ות)?|רוסי(ה|ות)?|אתיופי(ת|ות)?'),
  },
  {
    ground: 'מין',
    re: B('(גברים|נשים)\\s*בלבד|רק\\s*(גברים|נשים)|לגברים\\s*בלבד|לנשים\\s*בלבד'),
  },
];

/**
 * Returns the grounds this text trips, or an empty array.
 *
 * Matched on the REQUIREMENT, not on the ground's name. "גיל הילדים בגן" is a
 * fact about the children and must pass; "עד גיל 35" is a requirement about
 * the applicant and must not. Getting that apart is the whole difficulty, and
 * it is why the patterns look for the demand rather than for the word.
 */
function screenText(text) {
  const s = String(text || '');
  return [...new Set(FORBIDDEN_PATTERNS.filter(p => p.re.test(s)).map(p => p.ground))];
}

module.exports = {
  AREAS, ROLES, SALARY_UNITS, SCOPES,
  AREA_IDS, ROLE_IDS, SALARY_UNIT_IDS, SCOPE_IDS,
  labelOf, screenText, FORBIDDEN_PATTERNS,
};
