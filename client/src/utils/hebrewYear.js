/**
 * Client-side Hebrew/Israeli utility functions
 */

const HEBREW_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

const HEBREW_YEAR_MAP = {
  5784: 'תשפ״ד', 5785: 'תשפ״ה', 5786: 'תשפ״ו',
  5787: 'תשפ״ז', 5788: 'תשפ״ח', 5789: 'תשפ״ט',
  5790: 'תש״צ', 5791: 'תשצ״א', 5792: 'תשצ״ב',
};

/**
 * Convert a Gregorian date to the Hebrew academic year string.
 * Cutoff is Aug 10 (matches kindergarten contract end-of-year).
 * Dates on/after Aug 10 belong to the next academic year.
 */
export function getHebrewYear(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return 'לא ידוע';
  const gYear = d.getFullYear();
  const month = d.getMonth() + 1; // 1-12
  const day = d.getDate();
  const isAfterCutoff = month > 8 || (month === 8 && day >= 10);
  const hebrewYearNum = gYear + (isAfterCutoff ? 3761 : 3760);
  return HEBREW_YEAR_MAP[hebrewYearNum] || `תש״${hebrewYearNum % 100}`;
}

/**
 * Academic year range string (e.g. "2026-2027") from a Gregorian date.
 * Matches the server's normalizeYear / getAcademicYearStr.
 */
export function getAcademicYearRange(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return null;
  const gYear = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const isAfterCutoff = month > 8 || (month === 8 && day >= 10);
  const startYear = isAfterCutoff ? gYear : gYear - 1;
  return `${startYear}-${startYear + 1}`;
}

/**
 * Format a date in Hebrew-friendly format: "DD בMONTH YYYY"
 */
export function formatDateHebrew(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const day = d.getDate();
  const month = HEBREW_MONTHS[d.getMonth()];
  const year = d.getFullYear();
  return `${day} ב${month} ${year}`;
}

/**
 * Validate an Israeli ID number (9 digits, Luhn-like algorithm).
 */
export function isValidIsraeliID(id) {
  if (!id) return false;
  const str = String(id).trim();
  // Pad to 9 digits
  const padded = str.padStart(9, '0');
  if (padded.length !== 9 || !/^\d{9}$/.test(padded)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let digit = parseInt(padded[i], 10);
    // Multiply odd-positioned digits (0-indexed: positions 1,3,5,7) by 2
    if (i % 2 !== 0) {
      digit *= 2;
    }
    // If result > 9, subtract 9 (same as adding digits)
    if (digit > 9) {
      digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * Format a number as Israeli currency string
 */
export function formatCurrency(amount) {
  if (amount == null || isNaN(amount)) return '₪0';
  return new Intl.NumberFormat('he-IL', {
    style: 'currency',
    currency: 'ILS',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}
