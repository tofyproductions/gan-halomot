#!/usr/bin/env node
/**
 * Yesterday's rota against yesterday's punches: absent, late > 30, fine;
 * fixed-schedule staff skipped; the 07:00 job runs once a day, never on Sunday
 * about Saturday.
 *
 *   node scripts/attendance-report.test.js
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
  const { attendanceVsRota } = require('../src/services/shifts/attendanceReport.service');
  const { tick } = require('../src/services/shiftAttendanceReportJob');
  const { ilDateTime } = require('../src/services/fixedSchedule');

  const b = await M.Branch.create({ name: 'כפר סבא - קפלן', is_active: true });
  await M.User.create({ full_name: 'מנהלת', id_number: '444000001', email: 'm@x.l', password_hash: 'x', role: 'branch_manager', is_active: true, managed_branch_ids: [b._id] });
  await M.User.create({ full_name: 'הנה״ח', id_number: '444000002', email: 'a@x.l', password_hash: 'x', role: 'accountant', is_active: true });
  const mk = (name, extra = {}) => M.Employee.create({ full_name: name, israeli_id: String(Math.floor(Math.random() * 1e9)), branch_id: b._id, is_active: true, ...extra });
  const onTime = await mk('בזמן'); const late = await mk('מאחרת'); const absent = await mk('נעדרת'); const fixed = await mk('קבועה', { fixed_schedule: { enabled: true, days: [] } });
  const D = '2026-10-12'; // Monday
  const E = (emp, s) => ({ employee_id: emp._id, employee_name: emp.full_name, date: D, area: 'floater', start_hhmm: s, end_hhmm: '15:00' });
  await M.ShiftWeek.create({ branch_id: b._id, week_start: '2026-10-11', published_at: new Date(), published: [E(onTime, '07:00'), E(late, '07:00'), E(absent, '07:30'), E(fixed, '07:00')] });
  let sn = 0;
  const punch = (emp, hhmm, extra = {}) => M.Punch.create({ branch_id: b._id, employee_id: emp._id, israeli_id: emp.israeli_id, device_user_sn: 1000 + sn++, timestamp: ilDateTime(D, hhmm), approval_status: 'auto', ...extra });
  await punch(onTime, '07:10'); await punch(late, '07:45'); await punch(absent, '07:20', { ignored: true });

  const rep = await attendanceVsRota({ branchId: String(b._id), date: D });
  eq(rep.rows.map(r => [r.employee_name, r.kind, r.minutes || null]), [['מאחרת', 'late', 45], ['נעדרת', 'absent', null]], 'איחור 45 ונעדרת (החתמה מבוטלת לא נספרת); קבועה מדולגת');

  // M4: no ת"ז → an unlinked punch with an empty ת"ז is not hers; an inactive employee is skipped.
  const D2 = '2026-10-13';
  const noId = await M.Employee.create({ full_name: 'בלי תז', israeli_id: '', branch_id: b._id, is_active: true });
  const gone = await mk('לא פעילה', { is_active: false });
  await M.ShiftWeek.updateOne({ branch_id: b._id, week_start: '2026-10-11' }, { $push: { published: { $each: [{ ...E(noId, '07:00'), date: D2 }, { ...E(gone, '07:00'), date: D2 }] } } });
  await M.Punch.collection.insertOne({ branch_id: b._id, employee_id: null, israeli_id: '', device_user_sn: 5000, timestamp: ilDateTime(D2, '07:05'), approval_status: 'auto' });
  const rep2 = await attendanceVsRota({ branchId: String(b._id), date: D2 });
  eq(rep2.rows.map(r => [r.employee_name, r.kind]), [['בלי תז', 'absent']], 'M4: בלי ת"ז — החתמה לא משויכת לא נספרת לה; לא פעילה מדולגת');
  // M4: an invalid branch id is a 404, not a crash.
  const ctl = require('../src/controllers/shifts.controller');
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b2) { this.body = b2; return this; } };
  await ctl.attendanceReport({ query: { branch: 'bad', date: D }, user: { role: 'system_admin' } }, res, (err) => { res.code = 500; res.body = String(err); });
  eq([res.code, res.body && res.body.error], [404, 'סניף לא נמצא'], 'M4: מזהה סניף לא תקין — 404');

  console.log('\nשעות בפועל על הסידור (actualWeek)');
  {
    const { actualWeek } = require('../src/services/shifts/attendanceReport.service');
    // Last week relative to now, so every date passes the "already happened" filter.
    const il = new Date(`${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' })}T12:00:00Z`);
    il.setUTCDate(il.getUTCDate() - il.getUTCDay() - 7);
    const WS = il.toISOString().slice(0, 10);
    const mon = new Date(`${WS}T12:00:00Z`); mon.setUTCDate(mon.getUTCDate() + 1);
    const DM = mon.toISOString().slice(0, 10);
    await punch(onTime, '', { timestamp: ilDateTime(DM, '07:12') });
    await punch(onTime, '', { timestamp: ilDateTime(DM, '12:00') });
    await punch(onTime, '', { timestamp: ilDateTime(DM, '16:58') });
    await punch(late, '', { timestamp: ilDateTime(DM, '08:01') });
    const act = await actualWeek({ branchId: String(b._id), weekStart: WS });
    eq(act[String(onTime._id)][DM], { in: '07:12', out: '16:58' }, 'כניסה ראשונה ויציאה אחרונה — האמצעית לא מבלבלת');
    eq(act[String(late._id)][DM], { in: '08:01', out: null }, 'החתמה בודדת — כניסה בלי יציאה');
  }

  eq((await tick(new Date('2026-10-13T03:00:00Z'))).skipped, 'not 07:00 yet', '06:00 — עוד לא');
  const r1 = await tick(new Date('2026-10-13T04:30:00Z')); // Tue 07:30 IL → about Monday
  eq([r1.date, r1.branches], [D, 1], '07:30 — דוח על אתמול');
  eq(await M.NotificationEvent.countDocuments({ type: 'shift_attendance_report' }), 1, 'מנהלת הסניף קיבלה');
  eq(await M.NotificationEvent.countDocuments({ type: 'shift_attendance_report_office' }), 1, 'המשרד קיבל סיכום');
  eq((await tick(new Date('2026-10-13T06:00:00Z'))).skipped, 'already ran', 'פעם אחת ביום');
  eq((await tick(new Date('2026-10-18T05:00:00Z'))).skipped, 'yesterday was Saturday', 'ראשון בבוקר — אין דוח על שבת');

  await new Promise(r => setTimeout(r, 300));
  await mongoose.disconnect(); await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
