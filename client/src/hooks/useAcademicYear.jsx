import { useState, useEffect } from 'react';
import api from '../api/client';

/**
 * The Hebrew year in letters, computed rather than looked up — the same rule
 * the server uses (services/academic-year.service.js). The map this replaced
 * ran out after five years and fell back to `תש״87`: digits where letters
 * belong.
 */
const GEMATRIA = [
  [400, 'ת'], [300, 'ש'], [200, 'ר'], [100, 'ק'],
  [90, 'צ'], [80, 'פ'], [70, 'ע'], [60, 'ס'], [50, 'נ'],
  [40, 'מ'], [30, 'ל'], [20, 'כ'], [10, 'י'],
  [9, 'ט'], [8, 'ח'], [7, 'ז'], [6, 'ו'], [5, 'ה'], [4, 'ד'], [3, 'ג'], [2, 'ב'], [1, 'א'],
];
const FINALS = { כ: 'ך', מ: 'ם', נ: 'ן', פ: 'ף', צ: 'ץ' };

export function hebrewYearLetters(hebrewYear) {
  let n = hebrewYear % 1000;
  let out = '';
  for (const [v, letter] of GEMATRIA) {
    // 15 and 16 are written טו / טז, never יה / יו.
    if (n === 15) { out += 'טו'; n = 0; break; }
    if (n === 16) { out += 'טז'; n = 0; break; }
    while (n >= v) { out += letter; n -= v; }
  }
  if (out.length < 2) return out;
  const last = out.slice(-1);
  return `${out.slice(0, -1)}״${FINALS[last] || last}`;
}

export function getHebrewYearFromStart(gregorianStartYear) {
  return hebrewYearLetters(gregorianStartYear + 3761);
}

/**
 * "2026-2027 תשפ״ז".
 *
 * The gan year runs September to August, so it straddles two Gregorian years
 * and exactly one Hebrew one. The Gregorian range alone asks everyone to
 * translate; the Hebrew one alone hides which calendar year a date sits in.
 */
export function formatAcademicYear(range) {
  if (!range) return '';
  const startYear = Number(String(range).split('-')[0]);
  if (!Number.isFinite(startYear)) return String(range);
  return `${range} ${getHebrewYearFromStart(startYear)}`;
}

export function getAcademicYears() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const isAfterCutoff = month > 8 || (month === 8 && day >= 10);
  const startYear = isAfterCutoff ? year : year - 1;

  return {
    current: {
      value: startYear,
      label: formatAcademicYear(`${startYear}-${startYear + 1}`),
      hebrew: getHebrewYearFromStart(startYear),
      range: `${startYear}-${startYear + 1}`,
    },
    next: {
      value: startYear + 1,
      label: formatAcademicYear(`${startYear + 1}-${startYear + 2}`),
      hebrew: getHebrewYearFromStart(startYear + 1),
      range: `${startYear + 1}-${startYear + 2}`,
    },
  };
}

export function useAcademicYear() {
  const years = getAcademicYears();
  const [selectedYear, setSelectedYear] = useState(years.current.range);

  return { years, selectedYear, setSelectedYear };
}
