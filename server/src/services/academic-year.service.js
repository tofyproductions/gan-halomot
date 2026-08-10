/**
 * Academic Year & Hebrew Calendar Service
 * Ported from GAS: getHebrewYear(), getHebrewMonthName(), etc.
 */

/**
 * The Hebrew year in letters, computed rather than looked up.
 *
 * Both the server and the client carried a hand-written map that stopped at
 * 5792 and fell back to `תש״87` — digits where letters belong. It also had
 * 5790 as תשצ״י, which is not a number: 790 is ת+ש+צ, so the year is תש״ץ.
 * Gematria is a rule, so it is written as one and never runs out.
 */
const GEMATRIA = [
  [400, 'ת'], [300, 'ש'], [200, 'ר'], [100, 'ק'],
  [90, 'צ'], [80, 'פ'], [70, 'ע'], [60, 'ס'], [50, 'נ'],
  [40, 'מ'], [30, 'ל'], [20, 'כ'], [10, 'י'],
  [9, 'ט'], [8, 'ח'], [7, 'ז'], [6, 'ו'], [5, 'ה'], [4, 'ד'], [3, 'ג'], [2, 'ב'], [1, 'א'],
];
const FINALS = { כ: 'ך', מ: 'ם', נ: 'ן', פ: 'ף', צ: 'ץ' };

function hebrewYearLetters(hebrewYear) {
  let n = hebrewYear % 1000;            // 5787 -> 787; the millennium is implied
  let out = '';
  for (const [v, letter] of GEMATRIA) {
    // 15 and 16 are written טו / טז — never יה / יו, which spell the Name.
    if (n === 15) { out += 'טו'; n = 0; break; }
    if (n === 16) { out += 'טז'; n = 0; break; }
    while (n >= v) { out += letter; n -= v; }
  }
  if (out.length < 2) return out;
  // A final form on the last letter, and the gershayim before it.
  const last = out.slice(-1);
  return `${out.slice(0, -1)}״${FINALS[last] || last}`;
}

/** The Hebrew year a gan year starting in `gregorianStartYear` belongs to. */
function hebrewYearForStart(gregorianStartYear) {
  return hebrewYearLetters(gregorianStartYear + 3761);
}

/**
 * "2026-2027 תשפ״ז" — how the year is actually referred to.
 *
 * The gan year runs September to August, so it straddles two Gregorian years
 * and exactly one Hebrew one. Showing only the Gregorian range asks everyone
 * to translate; showing only the Hebrew one hides which calendar year a date
 * falls in. Both, always.
 */
function formatAcademicYear(range) {
  if (!range) return '';
  const startYear = Number(String(range).split('-')[0]);
  if (!Number.isFinite(startYear)) return String(range);
  return `${range} ${hebrewYearForStart(startYear)}`;
}

const HEBREW_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

// Academic year months in order: Sept(9)..Dec(12), Jan(1)..Aug(8)
const ACADEMIC_MONTHS = [9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8];

// קייטנה — the August camp, billed as a thirteenth column after אוג׳. Not a
// calendar month: it never comes out of the prorated monthly fee, and it only
// exists for branches that actually run one (models/SummerCamp.js).
const CAMP_MONTH = 13;

/**
 * Get Hebrew year string from a date.
 * Cutoff: Aug 10th -> if on or after, belongs to NEXT Hebrew year.
 */
function getHebrewYear(dateStr) {
  if (!dateStr) return 'לא ידוע';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'לא ידוע';

  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();

  const isAfterCutoff = month > 8 || (month === 8 && day >= 10);
  const hYear = isAfterCutoff ? year + 3761 : year + 3760;

  return hebrewYearLetters(hYear);
}

/**
 * Get academic year string from a date (e.g. "2025-2026")
 */
function getAcademicYearStr(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;

  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();

  const isAfterCutoff = month > 8 || (month === 8 && day >= 10);
  const startYear = isAfterCutoff ? year : year - 1;

  return `${startYear}-${startYear + 1}`;
}

/**
 * Get current and next academic years
 */
function getAcademicYears() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();

  const isAfterCutoff = month > 8 || (month === 8 && day >= 10);
  const currentStartYear = isAfterCutoff ? year : year - 1;

  return {
    current: {
      value: currentStartYear,
      label: formatAcademicYear(`${currentStartYear}-${currentStartYear + 1}`),
      hebrew: getHebrewYearFromStart(currentStartYear),
      range: `${currentStartYear}-${currentStartYear + 1}`,
    },
    next: {
      value: currentStartYear + 1,
      label: formatAcademicYear(`${currentStartYear + 1}-${currentStartYear + 2}`),
      hebrew: getHebrewYearFromStart(currentStartYear + 1),
      range: `${currentStartYear + 1}-${currentStartYear + 2}`,
    },
  };
}

function getHebrewYearFromStart(gregorianStartYear) {
  return hebrewYearForStart(gregorianStartYear);
}

function getHebrewMonthName(monthIndex) {
  return HEBREW_MONTHS[monthIndex] || '';
}

/**
 * Normalize academic year string to standardized form "YYYY-YYYY"
 */
function normalizeYear(y) {
  if (!y) return '';
  const clean = String(y).trim();
  if (/^\d{4}-\d{4}$/.test(clean)) return clean;

  // A Hebrew year, with or without gershayim and with or without a final form.
  // Derived from the same gematria that renders it, so the two can never drift
  // the way a hand-written map did — the old one covered five years and
  // silently passed anything else straight through.
  const strip = (v) => String(v).replace(/[״"'׳]/g, '')
    .replace(/ך/g, 'כ').replace(/ם/g, 'מ').replace(/ן/g, 'נ')
    .replace(/ף/g, 'פ').replace(/ץ/g, 'צ');
  const want = strip(clean);
  for (let start = 2015; start <= 2060; start += 1) {
    if (strip(hebrewYearForStart(start)) === want) return `${start}-${start + 1}`;
  }
  return clean;
}

/**
 * The year a registration is filed under.
 *
 * `academic_year` is the answer whenever it is set. start_date is only the
 * fallback, for rows written before the field existed — and it is a fallback,
 * not a second opinion: once the field is set it wins, which is what makes a
 * registration movable between years at all.
 */
function academicYearOf(reg) {
  if (!reg) return null;
  if (reg.academic_year) return normalizeYear(reg.academic_year);
  return getAcademicYearStr(reg.start_date);
}

/** 1 September → 31 August of "YYYY-YYYY". */
function academicYearBounds(range) {
  const [y1, y2] = normalizeYear(range).split('-').map(Number);
  if (!Number.isFinite(y1)) return null;
  return { start: new Date(Date.UTC(y1, 8, 1)), end: new Date(Date.UTC(y2, 7, 31)) };
}

/**
 * A child's name reduced to what two people typing it would agree on.
 *
 * Duplicate detection compares names, and names are typed: double spaces,
 * a trailing space, gershayim, a maqaf where a space belongs. None of those
 * make it a different child.
 */
function normalizeChildName(name) {
  return String(name || '')
    .replace(/[״"'׳`]/g, '')
    .replace(/[-־–]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

module.exports = {
  getHebrewYear,
  academicYearOf,
  academicYearBounds,
  normalizeChildName,
  hebrewYearLetters,
  hebrewYearForStart,
  formatAcademicYear,
  getAcademicYearStr,
  getAcademicYears,
  getHebrewMonthName,
  normalizeYear,
  ACADEMIC_MONTHS,
  CAMP_MONTH,
  HEBREW_MONTHS,
};
