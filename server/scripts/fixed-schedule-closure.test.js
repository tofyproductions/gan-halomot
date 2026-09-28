#!/usr/bin/env node
/**
 * A clock-free employee's standing hours must not be invented on a day the
 * gan itself does not open. לידור כהן / אורלי מור style: "שעות קבועות"
 * materializes a full work day from the weekly pattern alone — with no
 * reference at all to the gan's own vacation calendar (Holiday.kind ===
 * 'closure'), a closure week still filled every weekday with punches and a
 * full salary, the same overpayment bug already fixed for דמי מחלה.
 *
 * An explicit per-employee exception still wins over the closure (a person
 * who genuinely works through a break) — only the WEEKLY PATTERN's default
 * is what a closure now turns off.
 *
 *   node scripts/fixed-schedule-closure.test.js
 */

/* Nothing may read server/.env — stub dotenv before config/env loads it. */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const assert = require('assert');

let passed = 0;
const ok = (label) => { console.log('  ✓ ' + label); passed += 1; };

console.log('closureDateSet / plannedHoursFor — pure logic, no DB');
{
  const { closureDateSet, plannedHoursFor, datesInRange } = require('../src/services/fixedSchedule');

  {
    const days = datesInRange('2026-09-06', '2026-09-08');
    assert.deepStrictEqual(days, ['2026-09-06', '2026-09-07', '2026-09-08']);
    ok('datesInRange — inclusive of both ends');
  }

  const branchA = 'branchA';
  const holidays = [
    { branch_id: branchA, kind: 'closure', start_date: new Date('2026-09-06'), end_date: new Date('2026-09-08') },
    { branch_id: branchA, kind: 'short_day', start_date: new Date('2026-09-10'), end_date: new Date('2026-09-10') },
    { branch_id: 'branchB', kind: 'closure', start_date: new Date('2026-09-06'), end_date: new Date('2026-09-08') },
  ];

  {
    const set = closureDateSet(holidays, branchA);
    assert.ok(set.has('2026-09-06') && set.has('2026-09-07') && set.has('2026-09-08'));
    assert.ok(!set.has('2026-09-10'), 'short_day is NOT a closure — the gan runs, just shorter');
    ok('closureDateSet — only kind:closure, only the matching branch');
  }

  {
    const set = closureDateSet(holidays, 'branchB');
    assert.ok(set.has('2026-09-06'), 'a different branch has its OWN closure window');
    ok('closureDateSet is scoped per branch');
  }

  const schedule = { days: [{ weekday: 0, in: '08:00', out: '16:00' }] }; // 2026-09-06 is a Sunday
  const closed = closureDateSet(holidays, branchA);

  {
    const planned = plannedHoursFor(schedule, '2026-09-06', closed);
    assert.strictEqual(planned, null, 'the gan is closed — no hours invented');
    ok('a closure day yields no planned hours from the weekly pattern');
  }

  {
    const nextSunday = plannedHoursFor(schedule, '2026-09-13', closed); // outside the closure window
    assert.ok(nextSunday && nextSunday.in === '08:00', 'a Sunday outside the closure still follows the pattern');
    ok('a normal weekday outside any closure is unaffected');
  }

  {
    // An explicit exception for a closure date still wins — office staff who
    // genuinely works through the break.
    const scheduleWithException = {
      days: schedule.days,
      exceptions: [{ date: '2026-09-06', in: '09:00', out: '13:00' }],
    };
    const planned = plannedHoursFor(scheduleWithException, '2026-09-06', closed);
    assert.ok(planned && planned.in === '09:00' && planned.from_exception === true,
      'an explicit per-day exception overrides the closure, same as it overrides the weekly pattern');
    ok('an explicit exception still wins over a closure day');
  }
}

console.log('materializeMonth — end to end, against an isolated in-memory DB');
{
  (async () => {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const mongod = await MongoMemoryServer.create({ instance: { dbName: 'fixed_schedule_closure_test' } });
    process.env.MONGODB_URI = mongod.getUri();
    process.env.JWT_SECRET = 'x';
    process.env.DISABLE_JOBS = '1';

    const mongoose = require('mongoose');
    await mongoose.connect(process.env.MONGODB_URI);

    const { Branch, Employee, Punch, Holiday } = require('../src/models');
    const { materializeMonth } = require('../src/services/fixedSchedule');

    const branch = await Branch.create({ name: 'סניף בדיקה', address: 'כתובת' });

    // 2026-09-06 is a Sunday, part of a 3-day gan closure (חג/חופשה).
    await Holiday.create({
      branch_id: branch._id, academic_year: '2026-2027', name: 'חופשה לבדיקה',
      start_date: new Date('2026-09-06'), end_date: new Date('2026-09-08'), kind: 'closure',
    });

    const emp = await Employee.create({
      full_name: 'עובדת שעות קבועות לבדיקה',
      israeli_id: '999777888',
      branch_id: branch._id,
      is_active: true,
      receives_salary: true,
      start_date: new Date('2024-01-01'),
      fixed_schedule: {
        enabled: true,
        days: [
          { weekday: 0, in: '08:00', out: '16:00' }, // Sunday
          { weekday: 1, in: '08:00', out: '16:00' }, // Monday
        ],
      },
    });

    // Materialize a month entirely in the past relative to "today" isn't
    // possible without mocking the clock — use a month that is clearly
    // historical from the test's own fixed date isn't available either
    // (Date.now() must not be trusted). Instead pick 2026-09 and only assert
    // on dates that are always <= "today" is irrelevant here: materializeMonth
    // itself caps at today, so assert only on days it actually attempted —
    // both target dates (the Sunday inside the closure, and the following
    // Sunday) are early enough in the month to be covered whenever this runs
    // in in 2026 or later.
    const result = await materializeMonth('2026-09', {});

    const punchDates = (await Punch.find({ employee_id: emp._id }).select('timestamp').lean())
      .map(p => new Date(p.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }));
    const uniqueDates = [...new Set(punchDates)].sort();

    assert.ok(!uniqueDates.includes('2026-09-06'), `no punches on the closed Sunday — got: ${uniqueDates.join(',')}`);
    assert.ok(uniqueDates.includes('2026-09-13'), `the following Sunday (outside the closure) DOES get punches — got: ${uniqueDates.join(',')}`);
    ok(`materializeMonth skips every date inside the gan's closure (created ${result.created} punches, dates: ${uniqueDates.join(', ')})`);

    await mongoose.disconnect();
    await mongod.stop();

    console.log(`\nAll fixed-schedule-closure tests passed (${passed} checks).`);
  })().catch((e) => { console.error(e); process.exit(1); });
}
