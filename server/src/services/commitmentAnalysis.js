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
function analyzeCommitment(commitment, punches, monthYM) {
  if (!commitment) {
    return {
      committed_dates: [], off_dates: [], worked_dates: [], absent_dates: [],
      off_day_workdays: [], net_absent: 0, has_commitment: false,
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

  const committed = [];
  const off = [];
  for (const day of datesInMonth(monthYM)) {
    // Saturday (weekday=6) is never a work day in Israel — skip.
    if (day.weekday === 6) continue;
    const cd = byWeekday.get(day.weekday);
    if (!cd) {
      // Day not configured: treat as off (no commitment)
      continue;
    }
    if (cd.is_off) off.push(day.ymd);
    else committed.push(day.ymd);
  }

  const worked = [...workedSet].sort();
  const absent = committed.filter(d => !workedSet.has(d));
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
    has_commitment: true,
  };
}

module.exports = { analyzeCommitment, israelDayInfo, datesInMonth };
