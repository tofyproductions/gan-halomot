#!/usr/bin/env node
/**
 * A published week becomes the fixed-schedule employee's hours: rota days,
 * days off, the branch of the day; manual exceptions untouched; generated
 * punches of those days removed so they regenerate.
 *
 *   node scripts/rota-pay.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
let failures = 0;
const eq = (a, b, l) => { const g = JSON.stringify(a) === JSON.stringify(b); console.log(`  ${g ? '✅' : '❌'} ${l}${g ? '' : ` (${JSON.stringify(a)} ≠ ${JSON.stringify(b)})`}`); if (!g) failures++; };

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const M = require('../src/models');
  const { applyRotaToFixedSchedules } = require('../src/services/shifts/rotaPay.service');
  const fixedSchedule = require('../src/services/fixedSchedule');

  const home = await M.Branch.create({ name: 'כפר סבא - קפלן' });
  const host = await M.Branch.create({ name: 'כפר סבא - משה דיין' });
  const fixed = await M.Employee.create({
    full_name: 'לידור', israeli_id: '555000001', branch_id: home._id, is_active: true,
    fixed_schedule: { enabled: true, days: [0, 1, 2, 3, 4].map(weekday => ({ weekday, in: '07:00', out: '15:00' })), exceptions: [{ date: '2026-10-15', off: true, note: 'יום אישי', source: 'manual' }] },
  });
  const regular = await M.Employee.create({ full_name: 'רגילה', israeli_id: '555000002', branch_id: home._id, is_active: true });
  // Generated punches already exist for Sunday (a past day in the test's "today").
  await M.Punch.create([
    { branch_id: home._id, employee_id: fixed._id, israeli_id: '555000001', device_user_sn: 901, timestamp: fixedSchedule.ilDateTime('2026-10-11', '07:03'), timestamp_source: 'fixed_schedule', approval_status: 'approved' },
    { branch_id: home._id, employee_id: fixed._id, israeli_id: '555000001', device_user_sn: 902, timestamp: fixedSchedule.ilDateTime('2026-10-11', '15:02'), timestamp_source: 'fixed_schedule', approval_status: 'approved' },
  ]);
  const E = (emp, date, s, t, branch) => ({ employee_id: emp._id, date, start_hhmm: s, end_hhmm: t, branch_id: branch });
  const week = {
    branch_id: home._id, week_start: '2026-10-11',
    published: [E(fixed, '2026-10-11', '08:00', '14:00'), E(fixed, '2026-10-15', '07:00', '15:00'), E(regular, '2026-10-11', '07:00', '15:00')],
  };
  // Monday the 12th she works at the host branch (its own published week).
  await M.ShiftWeek.create({ branch_id: host._id, week_start: '2026-10-11', published_at: new Date(), published: [{ employee_id: fixed._id, employee_name: 'לידור', date: '2026-10-12', area: 'floater', start_hhmm: '09:00', end_hhmm: '13:00', cross_branch: true, cross_status: 'approved' }] });

  const res = await applyRotaToFixedSchedules({ week, closedDates: new Set(['2026-10-13']), today: '2026-10-12' });
  const ex = (await M.Employee.findById(fixed._id).lean()).fixed_schedule.exceptions;
  const byDate = Object.fromEntries(ex.map(e => [e.date, e]));
  eq([byDate['2026-10-11'].in, byDate['2026-10-11'].out, byDate['2026-10-11'].source], ['08:00', '14:00', 'rota'], 'ראשון: שעות הסידור');
  eq([byDate['2026-10-12'].in, String(byDate['2026-10-12'].branch_id)], ['09:00', String(host._id)], 'שני: עבדה בסניף אחר — השעות והסניף משם');
  eq(byDate['2026-10-13'], undefined, 'יום סגור — לא נכתב חריג');
  eq([byDate['2026-10-14'].off, byDate['2026-10-14'].source], [true, 'rota'], 'רביעי: לא בסידור — יום חופש');
  eq([byDate['2026-10-15'].off, byDate['2026-10-15'].source], [true, 'manual'], 'חריג ידני לא נדרס');
  eq(res.employees, 1, 'רק עובדות עם שעות קבועות');
  eq(await M.Punch.countDocuments({ employee_id: fixed._id, timestamp_source: 'fixed_schedule' }), 0, 'החתמות שנוצרו לימים האלה נמחקו כדי להיווצר מחדש');
  // Republish with a change replaces the rota exception.
  week.published[0] = E(fixed, '2026-10-11', '09:00', '14:00');
  await applyRotaToFixedSchedules({ week, closedDates: new Set(['2026-10-13']), today: '2026-10-12' });
  const ex2 = (await M.Employee.findById(fixed._id).lean()).fixed_schedule.exceptions.filter(e => e.date === '2026-10-11');
  eq([ex2.length, ex2[0].in], [1, '09:00'], 'פרסום חוזר מעדכן את אותו חריג');
  eq(fixedSchedule.plannedHoursFor({ exceptions: [{ date: '2026-10-12', in: '09:00', out: '13:00', branch_id: host._id }] }, '2026-10-12').branch_id, String(host._id), 'plannedHoursFor מחזיר את הסניף');

  await mongoose.disconnect(); await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
