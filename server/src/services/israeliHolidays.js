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
function computeHolidayPay({ employee, monthYM, punches, commitment, hourlyRate, avgDailyHours, ganClosedDates }) {
  const ganClosed = ganClosedDates instanceof Set ? ganClosedDates : new Set(ganClosedDates || []);
  const result = {
    eligible_days: [],
    ineligible_days: [],
    total_days: 0,
    total_pay: 0,
    blocking_reason: null, // populated when whole employee disqualified (global / no tenure)
    calc: {
      hourly_rate: Number(hourlyRate) || 0,
      avg_daily_hours: Math.round((Number(avgDailyHours) || 8) * 100) / 100,
      daily_rate: Math.round(((Number(hourlyRate) || 0) * (Number(avgDailyHours) || 8)) * 100) / 100,
    },
  };

  const monthHolidays = getHolidaysInMonth(monthYM);
  if (monthHolidays.length === 0) {
    result.blocking_reason = 'אין חגים בחודש זה';
    return result;
  }

  // Rule 1: hourly only — global is paid for holidays via the salary itself
  if (employee.salary_type !== 'hourly') {
    result.blocking_reason = 'עובד גלובלי — לא זכאי לדמי חגים בנפרד';
    for (const h of monthHolidays) {
      result.ineligible_days.push({ date: h.date, name: h.name, reasons: ['עובד גלובלי'] });
    }
    return result;
  }

  // Rule 2: tenure ≥ 3 months
  if (!employee.start_date) {
    result.blocking_reason = 'תאריך תחילת עבודה לא הוגדר בכרטיס העובד';
    for (const h of monthHolidays) {
      result.ineligible_days.push({ date: h.date, name: h.name, reasons: ['חסר תאריך תחילת עבודה — הוסף בכרטיס העובד'] });
    }
    return result;
  }
  const start = new Date(employee.start_date);
  const [my, mm] = monthYM.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(my, mm, 0));
  const tenureMs = monthEnd - start;
  const tenureDays = tenureMs / (24 * 3600 * 1000);
  if (tenureDays < 90) {
    result.blocking_reason = `ותק ${Math.floor(tenureDays)} ימים בלבד (נדרשים 90)`;
    for (const h of monthHolidays) {
      result.ineligible_days.push({ date: h.date, name: h.name, reasons: [`ותק לא מספיק (${Math.floor(tenureDays)} ימים, נדרשים 90)`] });
    }
    return result;
  }

  // Worked-day set from punches (YMD in Israel)
  const workedSet = new Set();
  for (const p of punches || []) {
    const wd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(p.timestamp));
    workedSet.add(wd);
  }

  // Commitment: weekdays she is OFF, and weekdays she is REQUIRED to work.
  // A guard day disqualifies only when the commitment explicitly REQUIRES work
  // that day (is_off === false) and she didn't show up. Off days — and days not
  // listed in the commitment at all — never disqualify, since she wasn't
  // expected to work them.
  const offWeekdays = new Set();
  const requiredWeekdays = new Set();
  const hasCommitment = !!(commitment && Array.isArray(commitment.days) && commitment.days.length);
  if (hasCommitment) {
    for (const d of commitment.days) {
      if (d.is_off) offWeekdays.add(d.day);
      else requiredWeekdays.add(d.day);
    }
  }
  // True when a missed adjacent (guard) weekday should NOT disqualify.
  const guardRelaxed = (wd) => {
    if (wd === 6) return true;                       // Saturday — no one works
    if (hasCommitment) return !requiredWeekdays.has(wd); // off or unconfigured → relaxed
    return false;                                    // no commitment → strict (must have worked)
  };

  const dailyRate = (Number(hourlyRate) || 0) * (Number(avgDailyHours) || 8);

  for (const h of monthHolidays) {
    const wd = weekdayLocal(h.date);
    const reasons = [];

    // Rule 3: not Saturday
    if (wd === 6) reasons.push('יום החג בשבת');

    // Rule 4: the holiday must fall on a day she was supposed to WORK. With a
    // commitment, that means a required weekday (not an off-day and not a weekday
    // she isn't committed to) — she's not paid for a holiday on a non-work day.
    if (hasCommitment && !requiredWeekdays.has(wd)) reasons.push('יום החג אינו יום עבודה של העובד');

    // Rule 5: guard days (day before AND day after). She is disqualified ONLY
    // if her commitment REQUIRES work on that adjacent day and she didn't show
    // up (see guardRelaxed). Saturday, her off-days, and days her commitment
    // doesn't require — never disqualify, since she wasn't expected to work.
    const prev = shiftYmd(h.date, -1);
    const next = shiftYmd(h.date, +1);
    const prevWd = weekdayLocal(prev);
    const nextWd = weekdayLocal(next);
    // The guard day also doesn't disqualify if the gan was CLOSED that day — she
    // couldn't have worked because there was no work that day.
    const prevWorked = workedSet.has(prev) || guardRelaxed(prevWd) || ganClosed.has(prev);
    const nextWorked = workedSet.has(next) || guardRelaxed(nextWd) || ganClosed.has(next);
    // Per the commitment rule: only a REQUIRED-but-missed guard day disqualifies.
    if (!prevWorked) reasons.push(`חויב לעבוד יום לפני החג ולא עבד (${prev})`);
    if (!nextWorked) reasons.push(`חויב לעבוד יום אחרי החג ולא עבד (${next})`);

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
