/**
 * Academic Year & Hebrew Calendar Service
 * Ported from GAS: getHebrewYear(), getHebrewMonthName(), etc.
 */

const HEBREW_YEAR_MAP = {
  5784: 'תשפ״ד', 5785: 'תשפ״ה', 5786: 'תשפ״ו',
  5787: 'תשפ״ז', 5788: 'תשפ״ח', 5789: 'תשפ״ט',
  5790: 'תשצ״י', 5791: 'תשצ״א', 5792: 'תשצ״ב',
};

const HEBREW_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

// Academic year months in order: Sept(9)..Dec(12), Jan(1)..Aug(8)
const ACADEMIC_MONTHS = [9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8];

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

  return HEBREW_YEAR_MAP[hYear] || `תש״${hYear % 100}`;
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
      label: getHebrewYearFromStart(currentStartYear),
      range: `${currentStartYear}-${currentStartYear + 1}`,
    },
    next: {
      value: currentStartYear + 1,
      label: getHebrewYearFromStart(currentStartYear + 1),
      range: `${currentStartYear + 1}-${currentStartYear + 2}`,
    },
  };
}

function getHebrewYearFromStart(gregorianStartYear) {
  const hYearNum = gregorianStartYear + 3761;
  return HEBREW_YEAR_MAP[hYearNum] || `תש״${hYearNum % 100}`;
}

function getHebrewMonthName(monthIndex) {
  return HEBREW_MONTHS[monthIndex] || '';
}

/**
 * Normalize academic year string to standardized form "YYYY-YYYY"
 */
function normalizeYear(y) {
  if (!y) return '';
  const hMap = {
    'תשפ״ד': '2023-2024', 'תשפד': '2023-2024',
    'תשפ״ה': '2024-2025', 'תשפה': '2024-2025',
    'תשפ״ו': '2025-2026', 'תשפו': '2025-2026',
    'תשפ״ז': '2026-2027', 'תשפז': '2026-2027',
    'תשפ״ח': '2027-2028', 'תשפח': '2027-2028',
  };
  const clean = String(y).trim();
  return hMap[clean] || clean;
}

module.exports = {
  getHebrewYear,
  getAcademicYearStr,
  getAcademicYears,
  getHebrewMonthName,
  normalizeYear,
  ACADEMIC_MONTHS,
  HEBREW_MONTHS,
};
