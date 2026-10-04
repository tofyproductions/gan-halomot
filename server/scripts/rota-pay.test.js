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

  // ── Fix round 1 ──
  const mkFixed = (name, id) => M.Employee.create({ full_name: name, israeli_id: id, branch_id: home._id, is_active: true, fixed_schedule: { enabled: true, days: [0, 1, 2, 3, 4].map(weekday => ({ weekday, in: '07:00', out: '15:00' })) } });
  const P = (emp, sn, date, hhmm, extra = {}) => ({ branch_id: home._id, employee_id: emp._id, israeli_id: emp.israeli_id, device_user_sn: sn, timestamp: fixedSchedule.ilDateTime(date, hhmm), timestamp_source: 'fixed_schedule', approval_status: 'approved', ...extra });
  const closed = new Set(['2026-10-13']);

  // 1. A fixed employee the rota never placed keeps her fixed hours and punches.
  const unplaced = await mkFixed('לא משובצת', '555000010');
  await M.Punch.create([P(unplaced, 910, '2026-10-11', '07:00')]);
  const r1 = await applyRotaToFixedSchedules({ week, closedDates: closed, today: '2026-10-20', previousPublished: [] });
  eq([(await M.Employee.findById(unplaced._id).lean()).fixed_schedule.exceptions.length, await M.Punch.countDocuments({ employee_id: unplaced._id })], [0, 1], 'לא בסידור ולא בקודם — בלי חריגים, ההחתמה נשארה');
  eq(r1.employees, 1, 'רק מי שבסידור נספרה');

  // 2. A day with an edited generated punch keeps all its punches.
  const edited = await mkFixed('נערכה', '555000011');
  await M.Punch.create([P(edited, 911, '2026-10-11', '07:00', { schedule_edited: true }), P(edited, 912, '2026-10-11', '15:00')]);
  const weekEd = { ...week, published: [...week.published, E(edited, '2026-10-11', '08:00', '12:00')] };
  await applyRotaToFixedSchedules({ week: weekEd, closedDates: closed, today: '2026-10-20' });
  eq(await M.Punch.countDocuments({ employee_id: edited._id }), 2, 'יום עם החתמה ערוכה — שתיהן נשארו');

  // 3. markDayOff turns a rota exception manual; a republish leaves it.
  await fixedSchedule.markDayOff(fixed._id, '2026-10-11');
  await applyRotaToFixedSchedules({ week, closedDates: closed, today: '2026-10-20' });
  const d11 = (await M.Employee.findById(fixed._id).lean()).fixed_schedule.exceptions.find(e => e.date === '2026-10-11');
  eq([d11.off, d11.source, d11.branch_id], [true, 'manual', null], 'מחיקה ידנית — נשארת ידנית אחרי פרסום חוזר');

  // 4. Real punch on a rota-off day survives.
  await M.Punch.create([P(fixed, 913, '2026-10-14', '07:30', { timestamp_source: 'agent_received_at' })]);
  await applyRotaToFixedSchedules({ week, closedDates: closed, today: '2026-10-20' });
  eq(await M.Punch.countDocuments({ employee_id: fixed._id, timestamp_source: 'agent_received_at' }), 1, 'החתמה אמיתית ביום חופש מהסידור נשארה');

  // 5. A host-branch publish updates the home employee's exception with the host branch.
  const hostWeek = { branch_id: host._id, week_start: '2026-10-11', published: [E(fixed, '2026-10-14', '10:00', '12:00', String(host._id))] };
  await applyRotaToFixedSchedules({ week: hostWeek, closedDates: new Set(), today: '2026-10-20' });
  const d14 = (await M.Employee.findById(fixed._id).lean()).fixed_schedule.exceptions.find(e => e.date === '2026-10-14');
  eq([d14.in, d14.out, String(d14.branch_id), d14.source], ['10:00', '12:00', String(host._id), 'rota'], 'פרסום סניף מארח מעדכן את החריג עם הסניף המארח');

  // Foreign rota (home week not published): her other days are NOT turned off.
  const hostEmp = await mkFixed('אורחת', '555000020');
  await M.Punch.create([P(hostEmp, 920, '2026-11-02', '07:00')]);
  const hostW2 = { branch_id: host._id, week_start: '2026-11-01', published: [E(hostEmp, '2026-11-03', '09:00', '12:00', String(host._id))] };
  await applyRotaToFixedSchedules({ week: hostW2, closedDates: new Set(), today: '2026-11-20', previousPublished: [] });
  let exA = (await M.Employee.findById(hostEmp._id).lean()).fixed_schedule.exceptions;
  eq([exA.map(e => e.date), exA[0].off, await M.Punch.countDocuments({ employee_id: hostEmp._id })], [['2026-11-03'], false, 1], 'פרסום מארח בלבד: רק יום המארח נכתב; שאר הימים והחתמותיהם לא נגעו');
  // Removal from the host week: the rota exception goes, no off written.
  await applyRotaToFixedSchedules({ week: { ...hostW2, published: [] }, closedDates: new Set(), today: '2026-11-20', previousPublished: hostW2.published });
  exA = (await M.Employee.findById(hostEmp._id).lean()).fixed_schedule.exceptions;
  eq(exA.length, 0, 'הוסרה מסידור המארח: חריג הסידור נמחק, בלי יום חופש');
  // Home week published with her in it + host publish: her other open days are off.
  await M.ShiftWeek.create({ branch_id: home._id, week_start: '2026-11-01', published_at: new Date(), published: [{ ...E(hostEmp, '2026-11-02', '07:00', '15:00', home._id), employee_name: 'אורחת', area: 'floater' }] });
  await applyRotaToFixedSchedules({ week: hostW2, closedDates: new Set(), today: '2026-11-20' });
  const exC = Object.fromEntries((await M.Employee.findById(hostEmp._id).lean()).fixed_schedule.exceptions.map(e => [e.date, e]));
  eq([exC['2026-11-04'].off, exC['2026-11-04'].source, exC['2026-11-03'].in, String(exC['2026-11-02'].branch_id)], [true, 'rota', '09:00', String(home._id)], 'בית פירסם איתה + פרסום מארח: שאר הימים חופש, יום מארח וביתי נכונים');
  // Stale rota hours on a day closed at home with no entry now: removed.
  const stale = await M.Employee.create({ full_name: 'ישנה', israeli_id: '555000021', branch_id: home._id, is_active: true, fixed_schedule: { enabled: true, days: [], exceptions: [{ date: '2026-11-04', in: '08:00', out: '12:00', source: 'rota', branch_id: host._id }] } });
  await applyRotaToFixedSchedules({ week: { branch_id: home._id, week_start: '2026-11-01', published: [E(stale, '2026-11-02', '07:00', '15:00')] }, closedDates: new Set(['2026-11-04']), today: '2026-11-20' });
  const exD = (await M.Employee.findById(stale._id).lean()).fixed_schedule.exceptions;
  eq([exD.some(e => e.date === '2026-11-04'), exD.some(e => e.date === '2026-11-02')], [false, true], 'יום סגור בבית בלי שיבוץ: חריג סידור ישן הוסר');

  // ── Final review ──
  // F1: a day she is in the rota but without valid hours is not a day off.
  const blank = await mkFixed('בלי שעות', '555000030');
  const WS = '2026-12-06';
  const dayRange = (d) => { const b = fixedSchedule.ilDayBounds(d); return { $gte: b.from, $lt: b.to }; };
  await M.Punch.create([P(blank, 930, '2026-12-08', '07:00')]);
  const blankWeek = { branch_id: home._id, week_start: WS, published: [E(blank, '2026-12-07', '07:00', '15:00'), { employee_id: blank._id, date: '2026-12-08', start_hhmm: '', end_hhmm: '' }] };
  await applyRotaToFixedSchedules({ week: blankWeek, closedDates: new Set(), today: '2026-12-31' });
  let exF = Object.fromEntries((await M.Employee.findById(blank._id).lean()).fixed_schedule.exceptions.map(e => [e.date, e]));
  eq([exF['2026-12-08'], await M.Punch.countDocuments({ employee_id: blank._id, timestamp: dayRange('2026-12-08') })], [undefined, 1], 'F1: שיבוץ בלי שעות — אין חריג סידור, ההחתמה שנוצרה נשארה');
  eq([exF['2026-12-09'] && exF['2026-12-09'].off, exF['2026-12-09'] && exF['2026-12-09'].source], [true, 'rota'], 'F1: יום פתוח בלי שום שיבוץ — חופש');
  // An earlier rota exception on that day goes when the hours are blanked; the day regenerates.
  const withHours = { ...blankWeek, published: [blankWeek.published[0], E(blank, '2026-12-08', '08:00', '12:00')] };
  await applyRotaToFixedSchedules({ week: withHours, closedDates: new Set(), today: '2026-12-31' });
  await M.Punch.create([P(blank, 931, '2026-12-08', '08:00')]);
  await applyRotaToFixedSchedules({ week: blankWeek, closedDates: new Set(), today: '2026-12-31' });
  exF = Object.fromEntries((await M.Employee.findById(blank._id).lean()).fixed_schedule.exceptions.map(e => [e.date, e]));
  eq([exF['2026-12-08'], await M.Punch.countDocuments({ employee_id: blank._id, device_user_sn: 931 })], [undefined, 0], 'F1: שעות נמחקו מהשיבוץ — חריג הסידור הוסר והיום ייווצר מחדש מהשעות הקבועות');

  // M1: republishing the same rota changes nothing — no exception rewrite, no punch regeneration.
  await M.Punch.create([P(blank, 932, '2026-12-07', '07:00')]);
  const same = await applyRotaToFixedSchedules({ week: blankWeek, closedDates: new Set(), today: '2026-12-31' });
  eq([same.exceptions, await M.Punch.countDocuments({ employee_id: blank._id, device_user_sn: 932 })], [0, 1], 'M1: פרסום זהה — בלי חריגים חדשים, ההחתמה שנוצרה נשארה');

  await mongoose.disconnect(); await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
