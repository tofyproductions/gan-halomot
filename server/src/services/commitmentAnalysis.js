/**
 * Cross-reference an employee's contracted weekly schedule (EmployeeCommitment)
 * with their actual punches for a month. Returns a count of days they were
 * committed to work and were absent, OFFSET by days where they showed up on
 * what should have been their day off.
 *
 * Israeli week: Sunday(0) … Friday(5). Day index used both by Date#getDay
 * (which returns 0=Sun) and EmployeeCommitment.days[].day.
 */

const IL_TZ = 'Asia/Jerusalem';

function israelDayInfo(date) {
  // Compute YYYY-MM-DD and weekday (0..6) in Israel timezone.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IL_TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const ymd = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find(p => p.type === 'weekday').value);
  return { ymd, weekday: wd };
}

function datesInMonth(monthYM) {
  const [y, m] = monthYM.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= last; d++) {
    const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const info = israelDayInfo(probe);
    out.push(info);
  }
  return out;
}

/**
 * @param {Object} commitment  EmployeeCommitment doc (with days[])
 * @param {Array}  punches     Punch records (countable only — already approved)
 * @param {String} monthYM     'YYYY-MM'
 * @returns {Object} {
 *   committed_dates: [ymd…],
 *   off_dates: [ymd…],
 *   worked_dates: [ymd…],
 *   absent_dates: [ymd…],          // committed minus worked
 *   off_day_workdays: [ymd…],      // worked-on-her-day-off offsets
 *   net_absent: number,
 *   has_commitment: boolean,
 * }
 */
function analyzeCommitment(commitment, punches, monthYM, excludeDates) {
  // excludeDates: Set of YYYY-MM-DD that must NOT count as absences (kindergarten
  // holidays, approved vacation/sick). The gan was closed or the absence is
  // already accounted for — she is not "absent" on those days.
  const skip = excludeDates instanceof Set ? excludeDates : new Set(excludeDates || []);
  if (!commitment) {
    return {
      committed_dates: [], off_dates: [], worked_dates: [], absent_dates: [],
      off_day_workdays: [], net_absent: 0, committed_hours: 0,
      committed_weighted_hours: 0, has_commitment: false,
    };
  }

  // Build a per-weekday map: weekday(0..5) → { is_off, start, end }
  const byWeekday = new Map();
  for (const d of commitment.days || []) {
    byWeekday.set(d.day, d);
  }

  // Punches → set of dates worked (Israeli local)
  const workedSet = new Set();
  for (const p of punches) {
    const { ymd } = israelDayInfo(new Date(p.timestamp));
    workedSet.add(ymd);
  }

  const hhmmToHours = (s) => {
    if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return 0;
    const [h, m] = s.split(':').map(Number);
    return (h || 0) + (m || 0) / 60;
  };

  // A committed day's OT-WEIGHTED hours: the agreed standard salary (שכר תקן) is
  // a basket that already includes the premium for the OT built into the regular
  // schedule (e.g. a 8.5h day = 8 regular + 0.5 at 125%). To get a base hourly
  // value that doesn't manufacture a phantom "excess" when she works exactly her
  // schedule, the OT portion of each committed day must be weighted by its
  // premium here — mirroring splitDayOvertime() in payrollCalc.js (8h reg, next
  // 2h ×1.25, above 10h ×1.5).
  const weightedDayHours = (h) => {
    const reg = Math.min(h, 8);
    const after8 = Math.max(0, h - 8);
    const ot125 = Math.min(after8, 2);
    const ot150 = Math.max(0, after8 - 2);
    return reg + ot125 * 1.25 + ot150 * 1.5;
  };

  // Alternating day (e.g. "Friday every other week" — שישי לסירוגין): she is
  // committed HALF the time, so we count half its hours and never flag it as an
  // absence or as an off-day-worked offset (we can't know which specific week).
  const altDay = (commitment.is_alternating_off && commitment.alternating_day != null)
    ? commitment.alternating_day : null;

  const committed = [];
  const off = [];
  let committed_hours = 0;          // total contracted CLOCK hours this month (for display)
  let committed_weighted_hours = 0; // same hours but OT-weighted (for the teken hourly value)
  for (const day of datesInMonth(monthYM)) {
    // Saturday (weekday=6) is never a work day in Israel — skip.
    if (day.weekday === 6) continue;
    const cd = byWeekday.get(day.weekday);
    if (!cd) {
      // Day not configured: treat as off (no commitment)
      continue;
    }
    const dayHours = Math.max(0, hhmmToHours(cd.end_hhmm) - hhmmToHours(cd.start_hhmm));
    if (altDay != null && day.weekday === altDay) {
      committed_hours += 0.5 * dayHours;                       // half-time alternating day
      committed_weighted_hours += 0.5 * weightedDayHours(dayHours);
      continue;                                                // not absence-flagged, not an offset
    }
    if (cd.is_off) off.push(day.ymd);
    else {
      committed.push(day.ymd);
      committed_hours += dayHours;
      committed_weighted_hours += weightedDayHours(dayHours);
    }
  }

  const worked = [...workedSet].sort();
  // A committed day with no punch is an absence — UNLESS it's a holiday/vacation
  // day (the gan was closed or it's already accounted for elsewhere).
  const absent = committed.filter(d => !workedSet.has(d) && !skip.has(d));
  const offDayWorkdays = off.filter(d => workedSet.has(d));

  // Offset: every off-day she still worked cancels one absent day.
  // Cap at zero so the number never goes negative.
  const net_absent = Math.max(0, absent.length - offDayWorkdays.length);

  return {
    committed_dates: committed,
    off_dates: off,
    worked_dates: worked,
    absent_dates: absent,
    off_day_workdays: offDayWorkdays,
    net_absent,
    committed_hours: Math.round(committed_hours * 100) / 100,
    committed_weighted_hours: Math.round(committed_weighted_hours * 100) / 100,
    has_commitment: true,
  };
}

/**
 * The weekdays (0=Sun … 5=Fri) an employee actually works. Prefers the
 * EmployeeCommitment schedule (non-off days) — the authoritative weekly
 * schedule — and falls back to Employee.work_days, then Sun–Thu. Used by sick /
 * leave day counting so a day she really works (e.g. Friday) isn't dropped just
 * because the coarse work_days field is stale.
 */
function workingWeekdays(commitment, fallbackWorkDays) {
  if (commitment && Array.isArray(commitment.days) && commitment.days.length) {
    const w = commitment.days.filter(d => !d.is_off).map(d => Number(d.day));
    if (w.length) return w;
  }
  if (Array.isArray(fallbackWorkDays) && fallbackWorkDays.length) return fallbackWorkDays.map(Number);
  return [0, 1, 2, 3, 4];
}

module.exports = { analyzeCommitment, israelDayInfo, datesInMonth, workingWeekdays };
