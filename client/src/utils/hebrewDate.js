// Hebrew weekday for a YYYY-MM-DD string — "יום א׳" … "יום ו׳", "שבת".
// Parsed in UTC so the name never shifts across the local midnight boundary.
const HEB_DAY_LETTERS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳'];

export function hebDayName(ymd) {
  if (!ymd) return '';
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 6 ? 'שבת' : `יום ${HEB_DAY_LETTERS[wd]}`;
}
