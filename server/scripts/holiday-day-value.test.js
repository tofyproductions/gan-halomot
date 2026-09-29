#!/usr/bin/env node
/**
 * A day of חג is worth exactly what a day of חופשה is worth.
 *
 * אילנה שימחי, 09.2026: יום כיפור was paid ₪472.57 (58 ₪/h × 8.15 h, her
 * average working day) while the same payslip paid a day of her own leave at
 * ₪148.04 — a full day from her year's history × her מקדם of about 0.30.
 * A part-timer's holiday is a part-time day.
 *
 *   node scripts/holiday-day-value.test.js
 */

const assert = require('assert');
const { computeHolidayPay } = require('../src/services/israeliHolidays');
const { dayRatesFrom } = require('../src/services/hourlyDayRates');

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

// Hourly, long tenure, committed to work Mondays only — so יום כיפור (Monday
// 21.09.2026) is her work day, and the three other September holidays are not.
const ilana = { salary_type: 'hourly', start_date: '2025-12-01' };
const commitment = { days: [{ day: 1, is_off: false }, { day: 0, is_off: true }] };
const base = {
  employee: ilana, monthYM: '2026-09', punches: [], commitment,
  hourlyRate: 58, avgDailyHours: 8.1478,
};
// Her year as the accountant's summary would show it.
const history = [
  { month: '2026-06', base_salary: 3000, days_for_payslip: 6.2, paid_hours: 55 },
  { month: '2026-07', base_salary: 3100, days_for_payslip: 6.3, paid_hours: 56 },
  { month: '2026-08', base_salary: 2963, days_for_payslip: 6.1, paid_hours: 53 },
];
const rates = dayRatesFrom(history);

ok('with her history, a day of חג is her day of חופשה — to the agora', () => {
  const r = computeHolidayPay({ ...base, dayRates: rates });
  assert.strictEqual(r.total_days, 1, 'only יום כיפור falls on her work day');
  assert.strictEqual(r.eligible_days[0].date, '2026-09-21');
  assert.strictEqual(r.total_pay, rates.vacation_day);
  assert.strictEqual(r.calc.basis, 'vacation_day');
  assert.strictEqual(r.calc.coefficient, rates.coefficient);
  assert.ok(rates.coefficient < 1, 'a part-timer: the מקדם actually bites');
});
ok('the old figure — rate × her average hours — is NOT what she is paid', () => {
  const r = computeHolidayPay({ ...base, dayRates: rates });
  assert.notStrictEqual(r.total_pay, 472.57);
  assert.ok(r.total_pay < 200, `a part-time day, got ${r.total_pay}`);
});
ok('with no history yet, rate × average hours stays as the fallback', () => {
  const r = computeHolidayPay({ ...base, dayRates: null });
  assert.strictEqual(r.calc.basis, 'hourly_x_hours');
  assert.strictEqual(r.total_pay, 472.57);
});
ok('a history with nothing paid is treated as no history', () => {
  const r = computeHolidayPay({ ...base, dayRates: { vacation_day: 0 } });
  assert.strictEqual(r.calc.basis, 'hourly_x_hours');
});
ok('the eligibility rules are untouched — only the price changed', () => {
  const r = computeHolidayPay({ ...base, dayRates: rates });
  const reasons = Object.fromEntries(r.ineligible_days.map((d) => [d.date, d.reasons.join(' | ')]));
  assert.ok(/בשבת/.test(reasons['2026-09-12']), 'ראש השנה א\' is a Saturday');
  assert.ok(/אינו יום עבודה/.test(reasons['2026-09-13']), 'ראש השנה ב\' is not her work day');
  assert.ok(/בשבת/.test(reasons['2026-09-26']), 'סוכות א\' is a Saturday');
});
ok('a תקן employee is still not paid holidays separately', () => {
  const r = computeHolidayPay({ ...base, employee: { ...ilana, salary_type: 'global' }, dayRates: rates });
  assert.strictEqual(r.total_pay, 0);
});

console.log('a holiday she was not paid for is told to the accountant');
const { unpaidHolidaysText } = require('../src/services/israeliHolidays');
const { buildExportSource } = require('../src/services/payrollExport/sourceLayer');
const shkulit = require('../src/services/payrollExport/shkulitAdapter');

ok('every unpaid holiday is named, with its date and every reason', () => {
  const auto = computeHolidayPay({ ...base, dayRates: rates });
  const text = unpaidHolidaysText(auto, 'hourly');
  assert.ok(/ראש השנה א' 12\.09 — יום החג בשבת/.test(text), text);
  assert.ok(/ראש השנה ב' 13\.09 — יום החג אינו יום עבודה של העובד/.test(text), text);
  assert.ok(/סוכות א' 26\.09/.test(text), text);
  assert.ok(!/יום כיפור/.test(text), 'the paid one is not listed');
});
ok('a תקן employee gets no such line — her holidays are inside the salary', () => {
  const auto = computeHolidayPay({ ...base, employee: { ...ilana, salary_type: 'global' } });
  assert.strictEqual(unpaidHolidaysText(auto, 'global'), null);
});
ok('a month with no holidays says nothing', () => {
  const auto = computeHolidayPay({ ...base, monthYM: '2026-11' });
  assert.strictEqual(unpaidHolidaysText(auto, 'hourly'), null);
});
ok('too little tenure is itself the reason, per holiday', () => {
  const auto = computeHolidayPay({ ...base, employee: { ...ilana, start_date: '2026-08-01' } });
  assert.ok(/ותק לא מספיק/.test(unpaidHolidaysText(auto, 'hourly')));
});
ok('a manual amount the office entered anyway is mentioned beside it', () => {
  const auto = computeHolidayPay({ ...base, dayRates: rates });
  assert.ok(/סכום ידני/.test(unpaidHolidaysText(auto, 'hourly', 300)));
});
ok('the שקלולית notes sheet carries the same line', () => {
  const auto = computeHolidayPay({ ...base, dayRates: rates });
  const row = {
    employee_id: 'e16', employee_number: '16', israeli_id: '057703035', full_name: 'אילנה שימחי',
    salary_type: 'hourly', is_active: true, month: '2026-09',
    bank_number: '20', bank_branch: '647', bank_account: '155764',
    breakdown: { hours: { total: 53.95, regular: 51.08, ot_125: 2.87, ot_150: 0, days_worked: 7 },
      rates: { hourly_rate: 58 }, components: { base_salary: 3171, travel: 112 }, deductions: {}, warnings: [] },
    manual: {}, holiday_pay_auto: auto, sick_info: { pay: 0 }, partial_absence: { deduction: 0 },
  };
  const { notes } = shkulit.buildMovements(buildExportSource('2026-09', [row]));
  const n = notes.find((x) => x.subject.startsWith('דמי חגים — לא שולמו'));
  assert.ok(n, 'a note is written');
  assert.strictEqual(n.text, unpaidHolidaysText(auto, 'hourly'));
});

console.log(`\nAll holiday day-value tests passed (${passed} checks).`);
