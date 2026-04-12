import { useState, useEffect } from 'react';
import api from '../api/client';

const HEBREW_YEAR_MAP = {
  5784: 'תשפ״ד', 5785: 'תשפ״ה', 5786: 'תשפ״ו',
  5787: 'תשפ״ז', 5788: 'תשפ״ח', 5789: 'תשפ״ט',
};

export function getHebrewYearFromStart(gregorianStartYear) {
  const hYearNum = gregorianStartYear + 3761;
  return HEBREW_YEAR_MAP[hYearNum] || `תש״${hYearNum % 100}`;
}

export function getAcademicYears() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const isAfterCutoff = month > 8 || (month === 8 && day >= 10);
  const startYear = isAfterCutoff ? year : year - 1;

  return {
    current: { value: startYear, label: getHebrewYearFromStart(startYear), range: `${startYear}-${startYear + 1}` },
    next: { value: startYear + 1, label: getHebrewYearFromStart(startYear + 1), range: `${startYear + 1}-${startYear + 2}` },
  };
}

export function useAcademicYear() {
  const years = getAcademicYears();
  const [selectedYear, setSelectedYear] = useState(years.current.range);

  return { years, selectedYear, setSelectedYear };
}
