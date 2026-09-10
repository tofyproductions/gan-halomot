import { createContext, useContext, useState, useCallback, useMemo } from 'react';

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

/**
 * The year the intake screens work on — the one families are being enrolled
 * INTO, and the only one רישום לאמונה ever shows.
 *
 * It is not `current` and not `next`, because both of those move on 10 August
 * and the intake cycle does not: the ministry opens registration on 1 February
 * for the year that starts that September, publishes its approvals in July,
 * and the gan fills the rooms in August. Every one of those months belongs to
 * the year beginning on the coming 1 September — which, for any date in the
 * calendar year Y, is simply Y..Y+1. In February 2027 the screen moves to
 * תשפ״ח on its own, on the day the new registration opens.
 *
 * Older years are never deleted; they are simply not something anyone works on
 * from that screen. The same rule lives on the server, in
 * services/academic-year.service.js.
 */
export function getEnrollmentYear() {
  const y = new Date().getFullYear();
  return `${y}-${y + 1}`;
}

export function getAcademicYears() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const isAfterCutoff = month > 8 || (month === 8 && day >= 10);
  const startYear = isAfterCutoff ? year : year - 1;

  return {
    // The just-ended year. Kept reachable because its records still matter
    // after the 10-August rollover — August's SALARY is settled in September,
    // from a month that belongs to the year that just closed.
    previous: {
      value: startYear - 1,
      label: formatAcademicYear(`${startYear - 1}-${startYear}`),
      hebrew: getHebrewYearFromStart(startYear - 1),
      range: `${startYear - 1}-${startYear}`,
    },
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

/**
 * The school year is a property of the APP, not of each screen.
 *
 * `useAcademicYear` was a plain hook holding its own `useState`, which means
 * every screen that called it got its own private year and its own selector to
 * change it. Six screens did — גבייה, ארכיון, גאנט, חופשות, סניפים, מחירון —
 * so moving from גבייה to ארכיון silently moved you back to the default year,
 * and nothing on either screen said the two disagreed. A gan can be looking at
 * תשפ״ז collections and תשפ״ו archive at the same moment and be told nothing.
 *
 * It is a context now, mounted beside BranchProvider in App.jsx, because it is
 * the same kind of fact: WHICH GAN and WHICH YEAR are the two things every
 * number on every screen is implicitly about. Both live in the rail, above
 * everything they qualify.
 *
 * Persistence copies the branch: localStorage, so it survives a reload and the
 * next morning. `?year=` on the URL wins over it on arrival, so a link can
 * carry a year — which is the whole point of the address-bar work — without
 * that link permanently changing what the recipient sees afterwards.
 *
 * NOT for the intake screens. רישום חיצוני and רישום לאמונה work on the year
 * families are being enrolled INTO — `getEnrollmentYear()`, which is a rule,
 * not a preference, and moves on 1 February on its own. Putting those under a
 * picker would let somebody file a child into last year by leaving a dropdown
 * where it was.
 */
const AcademicYearContext = createContext(null);

const YEAR_KEY = 'selectedAcademicYear';

export function AcademicYearProvider({ children }) {
  const years = getAcademicYears();
  const valid = [years.previous.range, years.current.range, years.next.range];

  const [selectedYear, setSelected] = useState(() => {
    // A year in the address bar is somebody handing you a link. It wins on
    // arrival, and only on arrival.
    try {
      const fromUrl = new URLSearchParams(window.location.search).get('year');
      if (fromUrl && valid.includes(fromUrl)) return fromUrl;
      const stored = localStorage.getItem(YEAR_KEY);
      // A stored year ages out: last August's choice is not a year this app
      // still offers, and silently showing a year that is not in the picker is
      // worse than starting from the current one.
      if (stored && valid.includes(stored)) return stored;
    } catch {
      // Private window, cleared site data, storage blocked. The current year is
      // the right answer, not a crash before the app renders.
    }
    return years.current.range;
  });

  const setSelectedYear = useCallback((range) => {
    setSelected(range);
    try { localStorage.setItem(YEAR_KEY, range); } catch { /* see above */ }
  }, []);

  const value = useMemo(
    () => ({ years, selectedYear, setSelectedYear, isCurrentYear: selectedYear === years.current.range }),
    // `years` is recomputed from the clock on every render and is only ever
    // read for its three ranges, which change once a year.
    [selectedYear, setSelectedYear, years.current.range] // eslint-disable-line react-hooks/exhaustive-deps
  );

  return <AcademicYearContext.Provider value={value}>{children}</AcademicYearContext.Provider>;
}

export function useAcademicYear() {
  const ctx = useContext(AcademicYearContext);
  if (!ctx) throw new Error('useAcademicYear must be used within AcademicYearProvider');
  return ctx;
}
