/**
 * Israeli statutory holidays — for "דמי חגים" (holiday pay) auto-calc.
 *
 * Rules per Histadrut collective agreement:
 *   1. Only hourly employees are eligible (global salary covers them already)
 *   2. Tenure ≥ 3 months at the employer
 *   3. Holiday must NOT fall on Saturday
 *   4. Holiday must NOT fall on the employee's regular off-day
 *      (e.g. she doesn't work Wednesdays, holiday on Wednesday → no pay)
 *   5. Employee must have worked the day before AND the day after the holiday
 *      (the "guard-day" rule). Worked = has a punch that day.
 *
 * Dates are stored as YYYY-MM-DD strings in Asia/Jerusalem.
 * Each holiday has `name` for display.
 */

const HOLIDAYS = [
  // תשפ"ו (2025-2026)
  { date: '2025-09-23', name: 'ראש השנה א\'' },
  { date: '2025-09-24', name: 'ראש השנה ב\'' },
  { date: '2025-10-02', name: 'יום כיפור' },
  { date: '2025-10-07', name: 'סוכות א\'' },
  { date: '2025-10-14', name: 'שמיני עצרת / שמחת תורה' },
  { date: '2026-04-02', name: 'פסח א\'' },
  { date: '2026-04-08', name: 'שביעי של פסח' },
  { date: '2026-04-22', name: 'יום העצמאות' },
  { date: '2026-05-22', name: 'שבועות' },

  // תשפ"ז (2026-2027)
  { date: '2026-09-12', name: 'ראש השנה א\'' },     // Saturday → not eligible
  { date: '2026-09-13', name: 'ראש השנה ב\'' },
  { date: '2026-09-21', name: 'יום כיפור' },
  { date: '2026-09-26', name: 'סוכות א\'' },        // Saturday → not eligible
  { date: '2026-10-03', name: 'שמיני עצרת / שמחת תורה' }, // Saturday → not eligible
  { date: '2027-04-22', name: 'פסח א\'' },
  { date: '2027-04-28', name: 'שביעי של פסח' },
  { date: '2027-05-12', name: 'יום העצמאות' },
  { date: '2027-06-11', name: 'שבועות' },
];

function ymdToDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function weekdayLocal(ymd) {
  // 0=Sun..6=Sat, in Asia/Jerusalem. Constructing midday UTC avoids DST off-by-ones.
  const d = ymdToDate(ymd);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' }).format(d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

function shiftYmd(ymd, deltaDays) {
  const d = ymdToDate(ymd);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function getHolidaysInMonth(monthYM) {
  return HOLIDAYS.filter(h => h.date.startsWith(monthYM));
}

/**
 * Compute holiday-pay eligibility for one (hourly) employee in one month.
 *
 * @param {Object} args
 * @param {Object} args.employee  — Employee doc (needs start_date)
 * @param {String} args.monthYM
 * @param {Array}  args.punches   — punches for the month (countable)
 * @param {Object} args.commitment — EmployeeCommitment doc (or null)
 * @param {Number} args.hourlyRate — employee hourly rate
 * @param {Number} args.avgDailyHours — typical working hours/day (for daily pay calc); default 8
 * @returns {{ eligible_days: Array, total_days: Number, total_pay: Number, ineligible_days: Array }}
 */
function computeHolidayPay({ employee, monthYM, punches, commitment, hourlyRate, avgDailyHours }) {
  const result = {
    eligible_days: [],
    ineligible_days: [],
    total_days: 0,
    total_pay: 0,
  };

  // Rule 1: hourly only
  if (employee.salary_type !== 'hourly') {
    return result;
  }

  // Rule 2: tenure ≥ 3 months
  if (!employee.start_date) {
    return result;
  }
  const start = new Date(employee.start_date);
  const [my, mm] = monthYM.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(my, mm, 0));
  const tenureMs = monthEnd - start;
  const tenureDays = tenureMs / (24 * 3600 * 1000);
  if (tenureDays < 90) {
    return result;
  }

  const monthHolidays = getHolidaysInMonth(monthYM);
  if (monthHolidays.length === 0) return result;

  // Worked-day set from punches (YMD in Israel)
  const workedSet = new Set();
  for (const p of punches || []) {
    const wd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(p.timestamp));
    workedSet.add(wd);
  }

  // Commitment: which weekdays is she expected to work?
  const offWeekdays = new Set();
  if (commitment && Array.isArray(commitment.days)) {
    for (const d of commitment.days) {
      if (d.is_off) offWeekdays.add(d.day);
    }
  }

  const dailyRate = (Number(hourlyRate) || 0) * (Number(avgDailyHours) || 8);

  for (const h of monthHolidays) {
    const wd = weekdayLocal(h.date);
    const reasons = [];

    // Rule 3: not Saturday
    if (wd === 6) reasons.push('יום החג בשבת');

    // Rule 4: not employee's off-day. weekday 6=Sat (already filtered),
    // commitment uses 0..5 same convention.
    if (wd <= 5 && offWeekdays.has(wd)) reasons.push('יום החג ביום החופש השבועי של העובד');

    // Rule 5: worked day before AND day after (skipping Saturdays/holidays).
    // Find the nearest working calendar day before the holiday — if THAT was
    // a Saturday, we relax the rule for that side.
    const prev = shiftYmd(h.date, -1);
    const next = shiftYmd(h.date, +1);
    const prevWd = weekdayLocal(prev);
    const nextWd = weekdayLocal(next);
    const prevWorked = workedSet.has(prev) || prevWd === 6;
    const nextWorked = workedSet.has(next) || nextWd === 6;
    if (!prevWorked) reasons.push(`לא עבד יום לפני החג (${prev})`);
    if (!nextWorked) reasons.push(`לא עבד יום אחרי החג (${next})`);

    if (reasons.length === 0) {
      result.eligible_days.push({
        date: h.date,
        name: h.name,
        amount: Math.round(dailyRate * 100) / 100,
      });
    } else {
      result.ineligible_days.push({ date: h.date, name: h.name, reasons });
    }
  }

  result.total_days = result.eligible_days.length;
  result.total_pay = Math.round(result.eligible_days.reduce((s, d) => s + d.amount, 0) * 100) / 100;

  return result;
}

module.exports = {
  HOLIDAYS,
  getHolidaysInMonth,
  computeHolidayPay,
  weekdayLocal,
};
