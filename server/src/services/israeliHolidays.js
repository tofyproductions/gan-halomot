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

  // תשפ"ח (2027-2028) — verified against hebcal.com (Israel calendar), 26.09.2026
  { date: '2027-10-02', name: 'ראש השנה א\'' },     // Saturday → not eligible
  { date: '2027-10-03', name: 'ראש השנה ב\'' },
  { date: '2027-10-11', name: 'יום כיפור' },
  { date: '2027-10-16', name: 'סוכות א\'' },        // Saturday → not eligible
  { date: '2027-10-23', name: 'שמיני עצרת / שמחת תורה' }, // Saturday → not eligible
  { date: '2028-04-11', name: 'פסח א\'' },
  { date: '2028-04-17', name: 'שביעי של פסח' },
  { date: '2028-05-02', name: 'יום העצמאות' },
  { date: '2028-05-31', name: 'שבועות' },

  // תשפ"ט (2028-2029) — verified against hebcal.com (Israel calendar), 26.09.2026
  { date: '2028-09-21', name: 'ראש השנה א\'' },
  { date: '2028-09-22', name: 'ראש השנה ב\'' },
  { date: '2028-09-30', name: 'יום כיפור' },        // Saturday → not eligible
  { date: '2028-10-05', name: 'סוכות א\'' },
  { date: '2028-10-12', name: 'שמיני עצרת / שמחת תורה' },
  { date: '2029-03-31', name: 'פסח א\'' },          // Saturday → not eligible
  { date: '2029-04-06', name: 'שביעי של פסח' },
  { date: '2029-04-19', name: 'יום העצמאות' },
  { date: '2029-05-20', name: 'שבועות' },

  // תש"ץ (2029-2030) — verified against hebcal.com (Israel calendar), 26.09.2026
  { date: '2029-09-10', name: 'ראש השנה א\'' },
  { date: '2029-09-11', name: 'ראש השנה ב\'' },
  { date: '2029-09-19', name: 'יום כיפור' },
  { date: '2029-09-24', name: 'סוכות א\'' },
  { date: '2029-10-01', name: 'שמיני עצרת / שמחת תורה' },
  { date: '2030-04-18', name: 'פסח א\'' },
  { date: '2030-04-24', name: 'שביעי של פסח' },
  { date: '2030-05-08', name: 'יום העצמאות' },
  { date: '2030-06-07', name: 'שבועות' },
];

// The last month the table knows about. When a payroll month falls beyond
// this, holiday pay isn't "zero" — it is UNKNOWN, and the difference must be
// shouted, not defaulted: the previous edition of this table ended quietly in
// June 2027, and from the following September every hourly employee would
// simply have lost her דמי חגים with no sign anything was missing.
const COVERAGE_END_YM = HOLIDAYS[HOLIDAYS.length - 1].date.slice(0, 7);
function tableCoversMonth(monthYM) {
  return String(monthYM) <= COVERAGE_END_YM;
}

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
function computeHolidayPay({ employee, monthYM, punches, commitment, hourlyRate, avgDailyHours, ganClosedDates, dayRates }) {
  const ganClosed = ganClosedDates instanceof Set ? ganClosedDates : new Set(ganClosedDates || []);
  // What a day of חג is worth: EXACTLY what a day of חופשה is worth — a full
  // day from her own twelve-month history, times her מקדם (her scope against a
  // full post, capped at 1). See services/hourlyDayRates.js.
  //
  // It used to be rate × her average worked hours per day, which prices a
  // part-timer's day as though she held a full post on the days she works:
  // אילנה שימחי (58 ₪/h, 8.15 h a day, a מקדם near 0.3) was paid ₪472.57 for
  // יום כיפור on 09.2026, against ₪148.04 for a day of her own leave on the
  // same payslip.
  //
  // rate × average hours stays only as the fallback for an employee with no
  // history yet — a new employee is not one whose day is worth nothing.
  const vacationDay = Number(dayRates?.vacation_day) || 0;
  const fallbackDaily = Math.round(((Number(hourlyRate) || 0) * (Number(avgDailyHours) || 8)) * 100) / 100;
  const result = {
    eligible_days: [],
    ineligible_days: [],
    total_days: 0,
    total_pay: 0,
    blocking_reason: null, // populated when whole employee disqualified (global / no tenure)
    calc: {
      hourly_rate: Number(hourlyRate) || 0,
      avg_daily_hours: Math.round((Number(avgDailyHours) || 8) * 100) / 100,
      basis: vacationDay > 0 ? 'vacation_day' : 'hourly_x_hours',
      full_day: vacationDay > 0 ? Number(dayRates.full_day) || 0 : null,
      coefficient: vacationDay > 0 ? Number(dayRates.coefficient) || 0 : null,
      months: vacationDay > 0 ? Number(dayRates.months) || 0 : null,
      daily_rate: vacationDay > 0 ? vacationDay : fallbackDaily,
    },
  };

  const monthHolidays = getHolidaysInMonth(monthYM);
  if (monthHolidays.length === 0) {
    // "No holidays" and "the table ran out" must not read the same — the
    // second one is a bug about to underpay every hourly employee.
    result.blocking_reason = tableCoversMonth(monthYM)
      ? 'אין חגים בחודש זה'
      : `לוח החגים במערכת מסתיים ב-${COVERAGE_END_YM} — יש לעדכן אותו (israeliHolidays.js) לפני חישוב דמי חגים לחודש זה`;
    if (!tableCoversMonth(monthYM)) result.table_exhausted = true;
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

  const dailyRate = result.calc.daily_rate;

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

/**
 * The holidays an HOURLY employee was not paid for this month, and why — one
 * line the accountant can check against the payslip ("ראש השנה א' 12.09 — יום
 * החג בשבת"). Both the שקלולית notes sheet and the accountant PDF print this
 * same sentence, so the two cannot tell her different stories.
 *
 * Null when there is nothing to check: a תקן employee (holidays are inside her
 * salary), a month with no holidays, or every holiday paid.
 *
 * @param {object} holidayPayAuto  the row's holiday_pay_auto block
 * @param {string} salaryType      'hourly' | 'global'
 * @param {number} [manualPay=0]   manual.holiday_pay — the office paid anyway
 */
function unpaidHolidaysText(holidayPayAuto, salaryType, manualPay = 0) {
  if (salaryType !== 'hourly' || !holidayPayAuto) return null;
  const fmt = (ymd) => { const p = String(ymd).split('-'); return p.length === 3 ? `${p[2]}.${p[1]}` : String(ymd); };
  // The payroll row renames computeHolidayPay's ineligible_days to ineligible.
  const raw = holidayPayAuto.ineligible || holidayPayAuto.ineligible_days;
  const list = Array.isArray(raw) ? raw : [];
  let text = null;
  if (list.length) {
    text = list.map((d) => `${d.name} ${fmt(d.date)} — ${(d.reasons || []).join('; ') || 'לא זכאי/ת'}`).join(' · ');
  } else if (holidayPayAuto.blocking_reason && holidayPayAuto.blocking_reason !== 'אין חגים בחודש זה') {
    // The holiday table running out is the one blocking reason with no days
    // attached — and it is the one that underpays everybody at once.
    text = holidayPayAuto.blocking_reason;
  }
  if (!text) return null;
  return Number(manualPay) > 0 ? `${text} (הוזן סכום ידני לדמי חגים: ${Number(manualPay)} ₪)` : text;
}

module.exports = {
  HOLIDAYS,
  getHolidaysInMonth,
  computeHolidayPay,
  unpaidHolidaysText,
  weekdayLocal,
  tableCoversMonth,
  COVERAGE_END_YM,
};
