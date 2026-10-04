#!/usr/bin/env node
/**
 * Where an employee's card places her on the rota: kitchen / floater, one
 * class, or two classes split by weekday — in a new week's seed, and on the
 * "ללא כיתה" entries of weeks that were opened before the card was set
 * (משה דיין, 10.2026: the week was opened first, the classes chosen after,
 * and nobody moved).
 *
 *   node scripts/shifts-placement.test.js
 */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
const eq = (a, b, l) => {
  const g = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${g ? '✅' : '❌'} ${l}${g ? '' : ` (${JSON.stringify(a)} ≠ ${JSON.stringify(b)})`}`);
  if (!g) failures++;
};
async function throwsStatus(fn, status, label) {
  try { await fn(); eq('no throw', status, label); } catch (e) { eq(e.status, status, label); }
}

/** The Sunday a week from now (Israel), so the "open weeks from now on" rule holds whenever this runs. */
function nextSunday() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay() + 7);
  return d.toISOString().slice(0, 10);
}
function schoolYear(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  return m >= 9 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

(async () => {
  const { placementFor } = require('../src/services/shifts/seed');
  console.log('\nסדר עדיפויות (ללא מסד)');
  {
    const active = new Set(['A', 'B']);
    eq(placementFor({ shift_area: 'kitchen', primary_classroom_id: 'A' }, 0, '', active), { area: 'kitchen', classroom_id: null }, 'עובדת מטבח גוברת על כיתה');
    const split = { primary_classroom_id: 'A', shift_day_classrooms: [{ day: 2, classroom_id: 'B' }] };
    eq(placementFor(split, 2, '', active), { area: 'class', classroom_id: 'B' }, 'יום שממופה לכיתה השנייה');
    eq(placementFor(split, 1, '', active), { area: 'class', classroom_id: 'A' }, 'יום שלא ממופה → הראשית');
    eq(placementFor({ primary_classroom_id: 'A', shift_day_classrooms: [{ day: 2, classroom_id: 'C' }] }, 2, '', active), { area: 'class', classroom_id: 'A' }, 'כיתה שנייה סגורה → הראשית');
    eq(placementFor({}, 0, 'מחליפה', active), { area: 'floater', classroom_id: null }, 'בלי כרטיס — טקסט ההתחייבות');
    eq(placementFor({}, 0, '', active), { area: 'unassigned', classroom_id: null }, 'בלי כלום — ללא כיתה');
  }

  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const M = require('../src/models');
  const svc = require('../src/services/shifts/shiftWeek.service');

  const WEEK = nextSunday();
  const YEAR = schoolYear(WEEK);
  const branch = await M.Branch.create({ name: 'תל אביב - משה דיין' });
  const other = await M.Branch.create({ name: 'הרצליה' });
  const managerUser = await M.User.create({ full_name: 'מנהלת', id_number: '123456789', email: 'm@x.l', password_hash: 'x', role: 'branch_manager', is_active: true, managed_branch_ids: [branch._id], branch_id: branch._id });
  const manager = { id: String(managerUser._id), role: 'branch_manager', managed_branch_ids: [String(branch._id)], full_name: 'מנהלת' };
  const infants = await M.Classroom.create({ name: 'תינוקייה 20', category: 'תינוקייה', academic_year: YEAR, branch_id: branch._id });
  const older = await M.Classroom.create({ name: 'בוגרים 30', category: 'בוגרים', academic_year: YEAR, branch_id: branch._id });
  const foreignRoom = await M.Classroom.create({ name: 'אחר', category: 'בוגרים', academic_year: YEAR, branch_id: other._id });

  const mkEmp = async (name, id, text) => {
    const e = await M.Employee.create({ full_name: name, israeli_id: id, branch_id: branch._id, is_active: true });
    await M.EmployeeCommitment.create({ employee_id: e._id, branch_id: branch._id, classroom: text, days: [0, 1, 2, 3, 4].map(day => ({ day, start_hhmm: '07:00', end_hhmm: '15:00' })) });
    return e;
  };
  const cook = await mkEmp('ארנון לירון', '111111111', '');
  const split = await mkEmp('מתחלקת', '222222222', '');
  const single = await mkEmp('רגילה', '333333333', '');

  console.log('\nשבוע שנפתח לפני שנבחרו כיתות');
  const week = await svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: WEEK });
  eq(week.entries.every(e => e.area === 'unassigned'), true, 'כולן ללא כיתה');
  let board = await svc.getBoard({ user: manager, branchId: String(branch._id), weekStart: WEEK });
  eq(board.pending_primary.length, 3, 'שלושתן מחכות לבחירה');

  // The manager also placed one of split's days herself — that stays.
  const fresh = await M.ShiftWeek.findById(week._id);
  const manual = fresh.entries.find(e => String(e.employee_id) === String(split._id) && e.date === board.dates[4]);
  manual.area = 'floater';
  await fresh.save();

  const r1 = await svc.setShiftPlacement({ user: manager, employeeId: String(cook._id), area: 'kitchen' });
  eq(r1.placed, 5, 'המבשלת: 5 משמרות עברו למטבח');
  const r2 = await svc.setShiftPlacement({
    user: manager, employeeId: String(split._id), area: 'class',
    classroomId: String(infants._id), secondClassroomId: String(older._id),
    dayClassrooms: { 0: String(infants._id), 1: String(older._id), 3: String(older._id) },
  });
  eq(r2.placed, 4, 'המתחלקת: 4 ימים שובצו (היום שהמנהלת שיבצה לא זז)');
  await svc.setPrimaryClassroom({ user: manager, employeeId: String(single._id), classroomId: String(infants._id) });

  const after = await M.ShiftWeek.findById(week._id).lean();
  const of = (emp) => after.entries.filter(e => String(e.employee_id) === String(emp._id)).sort((a, b) => a.date.localeCompare(b.date));
  eq(of(cook).map(e => e.area), ['kitchen', 'kitchen', 'kitchen', 'kitchen', 'kitchen'], 'מטבח כל השבוע');
  eq(of(split).map(e => e.area === 'class' ? String(e.classroom_id) : e.area),
    [String(infants._id), String(older._id), String(infants._id), String(older._id), 'floater'], 'כיתה לפי יום, וידני נשאר');
  eq(of(single).every(e => String(e.classroom_id) === String(infants._id)), true, 'כיתה אחת — כל הימים');
  const card = await M.Employee.findById(split._id).lean();
  eq(card.extra_classroom_ids.map(String), [String(older._id)], 'הכיתה השנייה בכרטיס — לא תסומן "כיתה חדשה"');

  board = await svc.getBoard({ user: manager, branchId: String(branch._id), weekStart: WEEK });
  eq(board.pending_primary.length, 0, 'אף אחת לא נשאלת שוב (גם לא המבשלת)');
  eq(board.employees.find(e => e._id === String(cook._id)).shift_area, 'kitchen', 'הלוח מחזיר את השיבוץ הקבוע');

  console.log('\nשבוע חדש נפתח לפי הכרטיסים');
  const next = new Date(`${WEEK}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 7);
  const WEEK2 = next.toISOString().slice(0, 10);
  const w2 = await svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: WEEK2 });
  const of2 = (emp) => w2.entries.filter(e => String(e.employee_id) === String(emp._id)).sort((a, b) => a.date.localeCompare(b.date));
  eq(of2(cook).every(e => e.area === 'kitchen'), true, 'מבשלת במטבח');
  eq(of2(split).map(e => String(e.classroom_id)), [String(infants._id), String(older._id), String(infants._id), String(older._id), String(infants._id)], 'מתחלקת לפי המפה, שאר הימים בראשית');

  console.log('\nשיבוץ אוטומטי לשבוע קיים');
  await M.ShiftWeek.updateOne({ _id: w2._id }, { $set: { 'entries.$[].area': 'unassigned', 'entries.$[].classroom_id': null } });
  const r3 = await svc.autoPlaceWeek({ user: manager, weekId: String(w2._id) });
  eq(r3.placed, 15, 'כל 15 המשמרות שובצו מחדש');

  console.log('\nבדיקות קלט');
  await throwsStatus(() => svc.setShiftPlacement({ user: manager, employeeId: String(single._id), area: 'class', classroomId: String(foreignRoom._id) }), 400, 'כיתה מסניף אחר נדחית');
  await throwsStatus(() => svc.setShiftPlacement({ user: manager, employeeId: String(single._id), area: 'class', classroomId: String(infants._id), secondClassroomId: String(infants._id) }), 400, 'כיתה שנייה זהה נדחית');
  await throwsStatus(() => svc.setShiftPlacement({ user: manager, employeeId: String(single._id), area: 'class', classroomId: String(infants._id), secondClassroomId: String(older._id), dayClassrooms: { 1: String(foreignRoom._id) } }), 400, 'מפה עם כיתה שלישית נדחית');
  await throwsStatus(() => svc.setShiftPlacement({ user: manager, employeeId: String(single._id), area: 'boss' }), 400, 'שיבוץ לא מוכר נדחה');
  const otherManager = { id: String(new mongoose.Types.ObjectId()), role: 'branch_manager', managed_branch_ids: [String(other._id)] };
  await throwsStatus(() => svc.setShiftPlacement({ user: otherManager, employeeId: String(single._id), area: 'kitchen' }), 403, 'מנהלת סניף אחר לא משנה');
  await throwsStatus(() => svc.autoPlaceWeek({ user: otherManager, weekId: String(w2._id) }), 403, 'ולא משבצת שבוע של סניף אחר');

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
