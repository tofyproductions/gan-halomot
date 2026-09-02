#!/usr/bin/env node
/**
 * בונוס אוגוסט, מקצה לקצה — the promise checked against the REAL salary engine.
 *
 * The unit test (august-bonus.test.js) proves applyBonusSplit's arithmetic in
 * isolation. This one proves the promise the accountant actually cares about,
 * through the same pipeline the payroll table runs: real punches into
 * payrollCalc.calculateMonthlySalary (the genuine engine, no database), then
 * the controller's carve sequence replicated step for step —
 *
 *   A global (תקן) employee whose summer-vacation days (16–31.8) are ALL
 *   approved as bonus ends the month at EXACTLY her agreed salary. Not one
 *   shekel more, not one less — a normal month's total, only split into real
 *   worked hours + בונוס אוגוסט. Fewer approvals = exactly the unapproved
 *   days' value less. Generous day pricing can never push past 100%.
 *
 * The scenario: salary ₪10,000, committed Sun–Thu 08:00–16:00. She worked
 * 1–15.8 normally; the gan closed 16–31.8 (12 committed days inside the
 * window).
 *
 *   node scripts/august-bonus-e2e.test.js
 */

const { calculateMonthlySalary } = require('../src/services/payrollCalc');
const { analyzeCommitment, weightedDayHours } = require('../src/services/commitmentAnalysis');
const { augustBonusWindow, candidateDays, applyBonusSplit } = require('../src/services/augustBonus');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}
const r2 = (n) => Math.round(n * 100) / 100;
const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;
const ILS = (n) => `₪${r2(n).toLocaleString('en-US')}`;

// ---------------------------------------------------------------- fixtures
const MONTH = '2026-08';
const SALARY = 10000;
const BRANCH = 'branch-1';

const employee = {
  _id: 'emp-1',
  full_name: 'עובדת גלובלית לדוגמה',
  salary_type: 'global',
  branch_id: BRANCH,
  amuta_distribution: [{ amuta_id: 'amuta-1', global_salary: SALARY }],
  // The engine adds ₪16/day travel by default (per real day worked; bonus days
  // rightly add none). Zeroed here so the assertions isolate the SALARY math.
  travel_per_day: 0,
};

// Sun–Thu 08:00–16:00 (8h/day), Friday off.
const commitment = {
  days: [0, 1, 2, 3, 4].map(day => ({ day, is_off: false, start_hhmm: '08:00', end_hhmm: '16:00' })),
};

const weekdayOf = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
const committedDatesOfMonth = [];
for (let d = 1; d <= 31; d++) {
  const date = `${MONTH}-${String(d).padStart(2, '0')}`;
  const wd = weekdayOf(date);
  if (wd >= 0 && wd <= 4) committedDatesOfMonth.push(date);
}
const WINDOW = augustBonusWindow(MONTH);
const windowCandidates = candidateDays(commitment, MONTH); // the 12 closure days
const preWindowDates = committedDatesOfMonth.filter(d => d < WINDOW.start); // worked 1–15

// Israel is UTC+3 in August.
function punchPair(date, startHHMM, endHHMM, source) {
  const common = { branch_id: BRANCH, approval_status: 'approved' };
  if (source) common.timestamp_source = source;
  return [
    { ...common, timestamp: `${date}T${startHHMM}:00+03:00`, state: 0 },
    { ...common, timestamp: `${date}T${endHHMM}:00+03:00`, state: 1 },
  ];
}

/**
 * The controller's exact sequence for one scenario (payrollMonth.controller.js
 * getMonth): engine → price closure punches at tb.hourly_value → find the
 * unapproved candidates → applyBonusSplit → adjust components and the total.
 */
function runMonth({ realDays, closureDays }) {
  const punches = [
    ...realDays.flatMap(d => punchPair(d.date, d.start, d.end)),
    ...closureDays.flatMap(d => punchPair(d.date, d.start, d.end, 'closure_completion')),
  ];
  const commitmentInfo = analyzeCommitment(commitment, punches, MONTH);
  const breakdown = calculateMonthlySalary(employee, punches, MONTH, {
    include_salary_completion: true,
    required_hours_override: commitmentInfo.committed_hours,
    committed_weighted_override: commitmentInfo.committed_weighted_hours,
  });
  const tb = breakdown.components.teken_breakdown;

  // -- controller carve, replicated --
  const hourlyValue = Number(tb.hourly_value || 0);
  const byClosureDate = new Map();
  for (const p of punches.filter(p => p.timestamp_source === 'closure_completion')) {
    const d = p.timestamp.slice(0, 10);
    if (!byClosureDate.has(d)) byClosureDate.set(d, []);
    byClosureDate.get(d).push(new Date(p.timestamp).getTime());
  }
  const closureCompletionDays = [...byClosureDate.keys()].sort().map(date => {
    const t = byClosureDate.get(date).sort((a, b) => a - b);
    const hours = weightedDayHours((t[t.length - 1] - t[0]) / 3600000);
    return { date, hours: r2(hours), amount: r2(hours * hourlyValue) };
  });
  const absentSet = new Set(commitmentInfo.absent_dates);
  const unapprovedDays = candidateDays(commitment, MONTH)
    .filter(c => absentSet.has(c.date))
    .map(c => {
      const hours = weightedDayHours(c.committed_hours);
      return { date: c.date, hours: r2(hours), amount: r2(hours * hourlyValue) };
    });
  const approvedValue = closureCompletionDays.reduce((s, d) => s + d.amount, 0);
  const unapprovedValue = unapprovedDays.reduce((s, d) => s + d.amount, 0);
  let bonus = 0; let deduction = 0; let completionAfter = tb.completion || 0;
  let estimatedTotal = breakdown.estimated_total;
  if (approvedValue > 0 || unapprovedValue > 0) {
    const split = applyBonusSplit({ completion: tb.completion || 0, approvedValue, unapprovedValue });
    bonus = split.bonus; deduction = split.deduction; completionAfter = split.completion_after;
    estimatedTotal = r2(estimatedTotal - deduction);
  }
  return {
    breakdown, tb, bonus, deduction, completionAfter, estimatedTotal,
    workedValue: tb.worked_value,
    approvedCount: closureCompletionDays.length,
    unapprovedCount: unapprovedDays.length,
  };
}

const allWorked = committedDatesOfMonth.map(date => ({ date, start: '08:00', end: '16:00' }));
const workedPreWindow = preWindowDates.map(date => ({ date, start: '08:00', end: '16:00' }));
const closureAll = windowCandidates.map(c => ({ date: c.date, start: '08:00', end: '16:00' }));

// ---------------------------------------------------------------- baseline
console.log(`חודש רגיל — עבדה את כל ${committedDatesOfMonth.length} ימי ההתחייבות, בלי בונוס`);
{
  const m = runMonth({ realDays: allWorked, closureDays: [] });
  check(`the engine pays exactly the agreed salary (${ILS(SALARY)})`, m.estimatedTotal === SALARY,
    `got ${ILS(m.estimatedTotal)}`);
  check('no bonus, no deduction in a plain month', m.bonus === 0 && m.deduction === 0);
}

// ---------------------------------------------------------------- the promise
console.log(`אישור מלא — עבדה 1–15 (${preWindowDates.length} ימים), כל ${windowCandidates.length} ימי החלון אושרו כבונוס`);
{
  const m = runMonth({ realDays: workedPreWindow, closureDays: closureAll });
  check(`total is EXACTLY the agreed salary — לא יותר ולא פחות (${ILS(SALARY)})`,
    near(m.estimatedTotal, SALARY, 0.02), `got ${ILS(m.estimatedTotal)}`);
  check('the bonus line is real money, not zero', m.bonus > 0, `bonus=${ILS(m.bonus)}`);
  check('no deduction — every day was approved', m.deduction === 0 && m.unapprovedCount === 0);
  check('the split reconciles: worked hours + bonus + remaining completion = salary',
    near(m.workedValue + m.bonus + m.completionAfter, SALARY, 0.05),
    `${ILS(m.workedValue)} + ${ILS(m.bonus)} + ${ILS(m.completionAfter)}`);
  console.log(`    דוגמה: שעות בפועל ${ILS(m.workedValue)} + בונוס ${ILS(m.bonus)} + השלמה ${ILS(m.completionAfter)} = ${ILS(m.workedValue + m.bonus + m.completionAfter)}`);
}

// ---------------------------------------------------------------- not one more
console.log('אישור מלא עם תמחור נדיב — ממוצע 9 שעות ליום (מעל ההתחייבות)');
{
  // Materializer priced her days off a generous 3-month average (09:00 span →
  // 17:00). The cap must hold the month at exactly 100%.
  const generous = windowCandidates.map(c => ({ date: c.date, start: '08:00', end: '17:00' }));
  const m = runMonth({ realDays: workedPreWindow, closureDays: generous });
  check(`even generous day pricing cannot push past 100% (${ILS(SALARY)})`,
    m.estimatedTotal <= SALARY + 0.02 && near(m.estimatedTotal, SALARY, 0.02),
    `got ${ILS(m.estimatedTotal)}`);
}

// ---------------------------------------------------------------- not one less... unless he says so
console.log('אף יום לא אושר — כל ימי החלון יורדים מהשכר');
{
  const m = runMonth({ realDays: workedPreWindow, closureDays: [] });
  check('every window day is an unapproved candidate', m.unapprovedCount === windowCandidates.length);
  check('the month is the salary MINUS those days exactly',
    near(m.estimatedTotal, SALARY - m.deduction, 0.02), `got ${ILS(m.estimatedTotal)}`);
  check('the deduction is the days\' full value', m.deduction > 0 && m.estimatedTotal < SALARY);
  console.log(`    דוגמה: ${ILS(SALARY)} − ${ILS(m.deduction)} (${m.unapprovedCount} ימים) = ${ILS(m.estimatedTotal)}`);
}

// ---------------------------------------------------------------- partial
console.log('אישור חלקי — 6 מתוך 12 ימים');
{
  const half = closureAll.slice(0, 6);
  const m = runMonth({ realDays: workedPreWindow, closureDays: half });
  check('6 approved, 6 unapproved', m.approvedCount === 6 && m.unapprovedCount === 6);
  check('total sits strictly between none and all',
    m.estimatedTotal < SALARY && m.estimatedTotal > SALARY - (m.bonus + m.deduction) + m.bonus - 1);
  check('total = salary − unapproved days exactly', near(m.estimatedTotal, SALARY - m.deduction, 0.02),
    `got ${ILS(m.estimatedTotal)}`);
  check('approved and unapproved days priced alike', near(m.bonus, m.deduction, 0.05),
    `bonus=${ILS(m.bonus)} deduction=${ILS(m.deduction)}`);
  console.log(`    דוגמה: בונוס ${ILS(m.bonus)}, ניכוי ${ILS(m.deduction)}, סה״כ ${ILS(m.estimatedTotal)}`);
}

// ---------------------------------------------------------------- days she worked
console.log('ימי היערכות — עבדה 3 מימי החלון, השאר אושרו');
{
  const worked3 = windowCandidates.slice(0, 3).map(c => ({ date: c.date, start: '08:00', end: '16:00' }));
  const approvedRest = windowCandidates.slice(3).map(c => ({ date: c.date, start: '08:00', end: '16:00' }));
  const m = runMonth({ realDays: [...workedPreWindow, ...worked3], closureDays: approvedRest });
  check('a worked day is not a bonus candidate and nothing is deducted for it', m.unapprovedCount === 0);
  check(`total is still exactly the agreed salary (${ILS(SALARY)})`,
    near(m.estimatedTotal, SALARY, 0.02), `got ${ILS(m.estimatedTotal)}`);
}

// ═══════════════════════════════════════════════════════════ hourly employee
//
// An hourly employee has no salary basket and no completion to carve — her
// approved bonus days are priced like her worked days but paid as a SEPARATE
// bonus line: payrollCalc drops closure punches for everyone (office decision,
// 2026-09-02 — a gift day must not inflate ימי עבודה or שעות), and the
// controller adds their value on top. The promises: hours and days stay
// exactly what she worked, an approved day adds exactly one day's pay as
// bonus, and a fully-approved month totals what a normally-worked month would.

const RATE = 50;
const hourlyEmployee = {
  _id: 'emp-2',
  full_name: 'עובדת שעתית לדוגמה',
  salary_type: 'hourly',
  branch_id: BRANCH,
  amuta_distribution: [{ amuta_id: 'amuta-1', hourly_rate: RATE }],
  travel_per_day: 0,
};

/** The controller's hourly sequence: engine (closure punches excluded from
 * hours) + the bonus days' value added on top as a separate line. */
function runHourlyMonth({ realDays, closureDays }) {
  const punches = [
    ...realDays.flatMap(d => punchPair(d.date, d.start, d.end)),
    ...closureDays.flatMap(d => punchPair(d.date, d.start, d.end, 'closure_completion')),
  ];
  const breakdown = calculateMonthlySalary(hourlyEmployee, punches, MONTH, {});
  const bonus = r2(closureDays.reduce((s, d) => {
    const span = (Number(d.end.split(':')[0]) + Number(d.end.split(':')[1]) / 60)
      - (Number(d.start.split(':')[0]) + Number(d.start.split(':')[1]) / 60);
    return s + weightedDayHours(span) * RATE;
  }, 0));
  return {
    breakdown,
    bonus,
    estimatedTotal: r2(breakdown.estimated_total + bonus),
    hours: breakdown.hours,
  };
}

const DAY_PAY = 8 * RATE; // an 8h day, no OT
const FULL_MONTH_PAY = committedDatesOfMonth.length * DAY_PAY;

console.log(`\nשעתית, חודש רגיל — עבדה את כל ${committedDatesOfMonth.length} הימים ב-₪${RATE} לשעה`);
{
  const m = runHourlyMonth({ realDays: allWorked, closureDays: [] });
  check(`pays hours × rate exactly (${ILS(FULL_MONTH_PAY)})`, m.estimatedTotal === FULL_MONTH_PAY,
    `got ${ILS(m.estimatedTotal)}`);
}

console.log(`שעתית, אישור מלא — עבדה 1–15, כל ${windowCandidates.length} ימי החלון אושרו`);
{
  const m = runHourlyMonth({ realDays: workedPreWindow, closureDays: closureAll });
  check(`total equals a normally-worked month exactly (${ILS(FULL_MONTH_PAY)})`,
    m.estimatedTotal === FULL_MONTH_PAY, `got ${ILS(m.estimatedTotal)}`);
  check('hours stay exactly what she WORKED — bonus days add none',
    m.hours.total === preWindowDates.length * 8, `got ${m.hours.total}h`);
  check('days worked stay exactly what she worked',
    m.hours.days_worked === preWindowDates.length, `got ${m.hours.days_worked}`);
  check(`the gift arrives as a separate bonus line (${ILS(windowCandidates.length * DAY_PAY)})`,
    m.bonus === windowCandidates.length * DAY_PAY, `got ${ILS(m.bonus)}`);
  console.log(`    דוגמה: שעות ${ILS(preWindowDates.length * DAY_PAY)} + בונוס ${ILS(m.bonus)} = ${ILS(m.estimatedTotal)}`);
}

console.log('שעתית, אף יום לא אושר — ימי החלון פשוט לא משולמים');
{
  const m = runHourlyMonth({ realDays: workedPreWindow, closureDays: [] });
  const expected = preWindowDates.length * DAY_PAY;
  check(`paid only for the days she worked (${ILS(expected)})`, m.estimatedTotal === expected,
    `got ${ILS(m.estimatedTotal)}`);
  console.log(`    דוגמה: ${preWindowDates.length} ימים × 8ש׳ × ₪${RATE} = ${ILS(m.estimatedTotal)}`);
}

console.log('שעתית, אישור חלקי — 6 מתוך 12');
{
  const m = runHourlyMonth({ realDays: workedPreWindow, closureDays: closureAll.slice(0, 6) });
  const expected = (preWindowDates.length + 6) * DAY_PAY;
  check(`each approved day adds exactly one day's pay (${ILS(expected)})`, m.estimatedTotal === expected,
    `got ${ILS(m.estimatedTotal)}`);
}

console.log('שעתית, ימי היערכות — עבדה 3 מימי החלון, השאר אושרו');
{
  const worked3 = windowCandidates.slice(0, 3).map(c => ({ date: c.date, start: '08:00', end: '16:00' }));
  const approvedRest = windowCandidates.slice(3).map(c => ({ date: c.date, start: '08:00', end: '16:00' }));
  const m = runHourlyMonth({ realDays: [...workedPreWindow, ...worked3], closureDays: approvedRest });
  check(`worked + approved days together still equal a full month (${ILS(FULL_MONTH_PAY)})`,
    m.estimatedTotal === FULL_MONTH_PAY, `got ${ILS(m.estimatedTotal)}`);
}

console.log('שעתית, ממוצע נדיב — יום בונוס מוגבל ל-8 שעות, בלי שע״נ');
{
  // Her 3-month average says 9h — but a gift day pays BASE pay only (office
  // decision): the materializer writes the day at bonusDayMinutes() = 8h, so
  // the bonus line carries no overtime premium.
  const { bonusDayMinutes } = require('../src/services/augustBonus');
  const cappedMinutes = bonusDayMinutes('hourly', 9 * 60, 8 * 60);
  check('the materializer writes the day at 8h, not 9', cappedMinutes === 480);
  const endHH = `${String(8 + cappedMinutes / 60).padStart(2, '0')}:00`;
  const capped = [{ date: windowCandidates[0].date, start: '08:00', end: endHH }];
  const m = runHourlyMonth({ realDays: workedPreWindow, closureDays: capped });
  const expected = preWindowDates.length * DAY_PAY + 8 * RATE; // base pay only, no 125%
  check(`the day pays exactly 8h base pay as bonus (${ILS(expected)})`, m.estimatedTotal === expected,
    `got ${ILS(m.estimatedTotal)}`);
  check('and still adds no hours', m.hours.total === preWindowDates.length * 8);
  console.log(`    דוגמה: ממוצע 9ש׳ → בונוס 8ש׳ × ₪${RATE} = ${ILS(8 * RATE)}, בלי תוספת 125%`);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll august-bonus end-to-end checks passed.');
