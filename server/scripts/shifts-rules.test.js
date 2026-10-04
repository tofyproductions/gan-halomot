#!/usr/bin/env node
/**
 * The rota's rules that need no database: what a fresh week looks like, when
 * a class is short-staffed, when two entries collide, who must be told about
 * a re-publish, and which class to suggest as an employee's primary one.
 *
 *   node scripts/shifts-rules.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};
const assert = require('assert');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

const { defaultRatios, effectiveRatios, ratioWarnings } = require('../src/services/shifts/ratio');
const { buildSeedEntries, areaFromCommitmentText } = require('../src/services/shifts/seed');
const { weekDays, isSunday, findOverlaps, affectedEmployeeIds, suggestPrimary, needsPrimaryPrompt } = require('../src/services/shifts/rules');

const DATES = weekDays('2026-10-11');

console.log('\nweekDays');
check('Sunday to Friday, six dates', () => assert.deepStrictEqual(DATES, ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']));
check('isSunday', () => { assert.ok(isSunday('2026-10-11')); assert.ok(!isSunday('2026-10-12')); assert.ok(!isSunday('bad')); });

console.log('\nratios');
check('Kfar Saba defaults', () => assert.deepStrictEqual(defaultRatios('כפר סבא - קפלן'), { infants: 5, young: 7, older: 9 }));
check('other cities', () => assert.deepStrictEqual(defaultRatios('הרצליה הרצוג'), { infants: 5, young: 8, older: 10 }));
check('branch override wins per key, blanks fall back', () => assert.deepStrictEqual(
  effectiveRatios({ name: 'תל אביב', staff_ratios: { infants: 4, young: null, older: 0 } }),
  { infants: 4, young: 8, older: 10 },
));
check('14 infants at 1/5 need 3; 2 placed → one warning', () => {
  const entries = [
    { employee_id: 'a', date: DATES[0], area: 'class', classroom_id: 'r1' },
    { employee_id: 'b', date: DATES[0], area: 'class', classroom_id: 'r1' },
    { employee_id: 'b', date: DATES[0], area: 'class', classroom_id: 'r1' }, // same person twice counts once
  ];
  const w = ratioWarnings({ entries, classrooms: [{ _id: 'r1', category: 'תינוקייה', enrolled: 14 }], dates: [DATES[0]], closedDates: new Set(), ratios: { infants: 5, young: 7, older: 9 } });
  assert.deepStrictEqual(w, [{ date: DATES[0], classroom_id: 'r1', enrolled: 14, staff: 2, needed: 3 }]);
});
check('closed day, empty class and uncategorised class never warn', () => {
  const w = ratioWarnings({
    entries: [],
    classrooms: [{ _id: 'r1', category: 'בוגרים', enrolled: 20 }, { _id: 'r2', category: 'צעירים', enrolled: 0 }, { _id: 'r3', category: null, enrolled: 9 }],
    dates: [DATES[0]], closedDates: new Set([DATES[0]]), ratios: { infants: 5, young: 7, older: 9 },
  });
  assert.deepStrictEqual(w, []);
});

console.log('\nseed');
check('areaFromCommitmentText', () => {
  assert.strictEqual(areaFromCommitmentText('מטבח'), 'kitchen');
  assert.strictEqual(areaFromCommitmentText('מחליפה'), 'floater');
  assert.strictEqual(areaFromCommitmentText('תינוקייה'), null);
});
check('commitment days become entries; off days, closed days skipped; alternating flagged', () => {
  const entries = buildSeedEntries({
    dates: DATES,
    employees: [{ _id: 'e1', full_name: 'דנה', primary_classroom_id: 'r1' }, { _id: 'e2', full_name: 'רות', primary_classroom_id: null }],
    commitments: [
      { employee_id: 'e1', classroom: 'תינוקייה', is_alternating_off: true, alternating_day: 2,
        days: [{ day: 0, start_hhmm: '07:00', end_hhmm: '15:00' }, { day: 1, is_off: true }, { day: 2, start_hhmm: '07:00', end_hhmm: '13:00' }, { day: 3, start_hhmm: '08:00', end_hhmm: '16:00' }] },
      { employee_id: 'e2', classroom: 'מטבח', days: [{ day: 0, start_hhmm: '06:30', end_hhmm: '14:00' }] },
    ],
    activeClassroomIds: new Set(['r1']),
    closedDates: new Set([DATES[3]]),
  });
  assert.deepStrictEqual(entries.map(e => [e.employee_id, e.date, e.area, e.classroom_id, e.start_hhmm, e.end_hhmm, e.alternating]), [
    ['e1', DATES[0], 'class', 'r1', '07:00', '15:00', false],
    ['e1', DATES[2], 'class', 'r1', '07:00', '13:00', true],
    ['e2', DATES[0], 'kitchen', null, '06:30', '14:00', false],
  ]);
  assert.strictEqual(entries[0].employee_name, 'דנה');
});
check('primary class that is no longer active → ללא כיתה', () => {
  const [e] = buildSeedEntries({
    dates: DATES,
    employees: [{ _id: 'e1', full_name: 'דנה', primary_classroom_id: 'gone' }],
    commitments: [{ employee_id: 'e1', classroom: '', days: [{ day: 0, start_hhmm: '07:00', end_hhmm: '15:00' }] }],
    activeClassroomIds: new Set(['r1']), closedDates: new Set(),
  });
  assert.strictEqual(e.area, 'unassigned');
  assert.strictEqual(e.classroom_id, null);
});

console.log('\noverlaps');
check('same employee, same day, touching is fine, overlapping is not', () => {
  const base = { employee_id: 'e1', employee_name: 'דנה', date: DATES[0] };
  assert.deepStrictEqual(findOverlaps([{ ...base, start_hhmm: '07:00', end_hhmm: '13:00' }, { ...base, start_hhmm: '13:00', end_hhmm: '16:00' }]), []);
  assert.deepStrictEqual(findOverlaps([{ ...base, start_hhmm: '07:00', end_hhmm: '13:30' }, { ...base, start_hhmm: '13:00', end_hhmm: '16:00' }]), [{ employee_id: 'e1', employee_name: 'דנה', date: DATES[0] }]);
});
check('entries without hours are not compared', () => {
  const base = { employee_id: 'e1', employee_name: 'דנה', date: DATES[0] };
  assert.deepStrictEqual(findOverlaps([{ ...base, start_hhmm: '', end_hhmm: '' }, { ...base, start_hhmm: '07:00', end_hhmm: '16:00' }]), []);
});

console.log('\nwho is told on re-publish');
check('first publish: everybody on the rota', () => {
  const next = [{ employee_id: 'a', date: DATES[0], area: 'class', classroom_id: 'r1', start_hhmm: '07:00', end_hhmm: '15:00' }, { employee_id: 'b', date: DATES[0], area: 'kitchen', classroom_id: null, start_hhmm: '07:00', end_hhmm: '15:00' }];
  assert.deepStrictEqual([...affectedEmployeeIds([], next)].sort(), ['a', 'b']);
});
check('later publish: only employees whose own entries changed (incl. removed)', () => {
  const a = { employee_id: 'a', date: DATES[0], area: 'class', classroom_id: 'r1', start_hhmm: '07:00', end_hhmm: '15:00' };
  const b = { employee_id: 'b', date: DATES[0], area: 'class', classroom_id: 'r1', start_hhmm: '07:00', end_hhmm: '15:00' };
  const c = { employee_id: 'c', date: DATES[1], area: 'class', classroom_id: 'r1', start_hhmm: '07:00', end_hhmm: '15:00' };
  const next = [{ ...a, _id: 'x1' }, { ...b, end_hhmm: '16:00' }];
  assert.deepStrictEqual([...affectedEmployeeIds([a, b, c], next)].sort(), ['b', 'c']);
});

console.log('\nprimary class suggestion');
const rooms = [{ _id: 'r1', name: 'תינוקייה 20', category: 'תינוקייה' }, { _id: 'r2', name: 'צעירים א', category: 'צעירים' }, { _id: 'r3', name: 'צעירים ב', category: 'צעירים' }];
check('exact class name', () => assert.deepStrictEqual(suggestPrimary({ commitmentText: 'תינוקייה 20', classrooms: rooms }), { suggestion: 'r1', candidates: ['r1'] }));
check('category with one class', () => assert.deepStrictEqual(suggestPrimary({ commitmentText: 'תינוקייה', classrooms: rooms }), { suggestion: 'r1', candidates: ['r1'] }));
check('category with two classes → no suggestion, both candidates', () => assert.deepStrictEqual(suggestPrimary({ commitmentText: 'צעירים', classrooms: rooms }), { suggestion: null, candidates: ['r2', 'r3'] }));
check('unknown text → every class is a candidate', () => assert.deepStrictEqual(suggestPrimary({ commitmentText: '', classrooms: rooms }), { suggestion: null, candidates: ['r1', 'r2', 'r3'] }));
check('needsPrimaryPrompt', () => {
  assert.strictEqual(needsPrimaryPrompt({ primary_classroom_id: null }, { classroom: 'צעירים' }), true);
  assert.strictEqual(needsPrimaryPrompt({ primary_classroom_id: 'r1' }, { classroom: 'צעירים' }), false);
  assert.strictEqual(needsPrimaryPrompt({ primary_classroom_id: null }, { classroom: 'מטבח' }), false);
  assert.strictEqual(needsPrimaryPrompt({ primary_classroom_id: null }, null), false);
});

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
