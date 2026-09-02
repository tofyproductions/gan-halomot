/**
 * Dates hiding in document names.
 *
 * The office uploads certificates as free-form employee documents whose NAME
 * carries the date — "הדר שם טוב-אישור ביקור רופא 06.08.26", "אישור בדיקת
 * הריון 2026-07-06" — and the pregnancy-exam tracker needs to find the file
 * that belongs to a given exam date without a human re-reading the list.
 *
 * This is deliberately conservative: only unambiguous full dates match
 * (day+month+year). "08.26" (month.year, no day) matches nothing, and digit
 * runs that happen to sit inside a תעודת זהות or a phone number are rejected
 * by the boundary guards. A wrong auto-attachment is worse than none.
 *
 * Pure — no database — so scripts/doc-date-match.test.js can require it as-is.
 */

const pad2 = (n) => String(n).padStart(2, '0');

function toYmd(y, m, d) {
  const yy = Number(y); const mm = Number(m); const dd = Number(d);
  const year = yy < 100 ? 2000 + yy : yy;
  if (year < 2000 || year > 2099) return null;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${year}-${pad2(mm)}-${pad2(dd)}`;
}

/**
 * Every unambiguous date found in `text`, as 'YYYY-MM-DD', deduped.
 * Recognized shapes: 2026-08-06 · 06.08.2026 · 06.08.26 · 06/08/2026 · 06/08/26
 * (Israeli order: day first.)
 */
function datesInText(text) {
  const s = String(text || '');
  const out = new Set();
  // ISO: YYYY-MM-DD (also matches inside longer strings, guarded by \D)
  for (const m of s.matchAll(/(?<!\d)(20\d{2})-(\d{2})-(\d{2})(?!\d)/g)) {
    const ymd = toYmd(m[1], m[2], m[3]);
    if (ymd) out.add(ymd);
  }
  // Israeli: DD.MM.YY / DD.MM.YYYY / DD/MM/YY / DD/MM/YYYY
  for (const m of s.matchAll(/(?<!\d)(\d{1,2})[./](\d{1,2})[./](\d{2}|20\d{2})(?![\d./])/g)) {
    const ymd = toYmd(m[3], m[2], m[1]);
    if (ymd) out.add(ymd);
  }
  return [...out];
}

/**
 * The single document that carries exactly `ymd` in its name (or original
 * filename). Ambiguity — none or more than one — returns null: attaching the
 * wrong certificate silently is the failure mode this whole file exists to
 * avoid. `docs` need only {name, file_name} here; fetch the payload after.
 */
function findDocumentForDate(docs, ymd) {
  const matches = (docs || []).filter(doc =>
    datesInText(`${doc.name || ''} ${doc.file_name || ''}`).includes(ymd));
  return matches.length === 1 ? matches[0] : null;
}

module.exports = { datesInText, findDocumentForDate };
