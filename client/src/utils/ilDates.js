/**
 * Israel-local "today", and day-counts a Hebrew reader can trust.
 *
 * `toISOString()` is UTC: between midnight and 02:00/03:00 Israel time it
 * still says YESTERDAY — the payroll screens opened on the previous month on
 * the 1st, the missing-punch dialog defaulted to the wrong day, and a birth
 * recorded after midnight got yesterday's date. The one honest source is the
 * clock in Asia/Jerusalem, and en-CA formats it as YYYY-MM-DD directly.
 *
 * `pluralDays` because "1 ימים" reads as a bug to every Hebrew speaker.
 */
export const todayIL = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

export const monthIL = () => todayIL().slice(0, 7);

export const pluralDays = (n) => {
  if (n === 1) return 'יום אחד';
  if (n === 0.5) return 'חצי יום';
  return `${n} ימים`;
};
