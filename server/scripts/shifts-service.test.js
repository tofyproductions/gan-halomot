#!/usr/bin/env node
/**
 * The rota against a real (in-memory) database: opening a week, saving,
 * closing a day, publishing and who is told, the office's edit request, class
 * close/reopen, primary class, ratios, and what an employee sees.
 *
 *   node scripts/shifts-service.test.js
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

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const M = require('../src/models');
  const svc = require('../src/services/shifts/shiftWeek.service');

  const branch = await M.Branch.create({ name: 'כפר סבא - קפלן' });
  const other = await M.Branch.create({ name: 'הרצליה הרצוג' });
  const mk = (role, extra = {}) => M.User.create({ full_name: role, id_number: String(Math.random()).slice(2, 11), email: `${role}${Math.random()}@x.l`, password_hash: 'x', role, is_active: true, ...extra });
  const managerUser = await mk('branch_manager', { managed_branch_ids: [branch._id], branch_id: branch._id });
  const adminUser = await mk('system_admin');
  const empUser = await mk('teacher', { branch_id: branch._id });
  const manager = { id: String(managerUser._id), role: 'branch_manager', managed_branch_ids: [String(branch._id)], full_name: 'מנהלת' };
  const admin = { id: String(adminUser._id), role: 'system_admin', full_name: 'אדמין' };

  const infants = await M.Classroom.create({ name: 'תינוקייה 20', category: 'תינוקייה', academic_year: '2026-2027', branch_id: branch._id });
  const young = await M.Classroom.create({ name: 'צעירים א', category: 'צעירים', academic_year: '2026-2027', branch_id: branch._id });
  const reg = await M.Registration.create({ unique_id: 'r1', child_name: 'ילד', parent_name: 'הורה', monthly_fee: 1, start_date: new Date('2026-09-01'), end_date: new Date('2027-08-31') });
  for (let i = 0; i < 6; i += 1) await M.Child.create({ registration_id: reg._id, child_name: `ילד ${i}`, academic_year: '2026-2027', classroom_id: infants._id, is_active: true });

  const dana = await M.Employee.create({ full_name: 'דנה', israeli_id: '111111111', branch_id: branch._id, user_id: empUser._id, primary_classroom_id: infants._id, is_active: true });
  const ruth = await M.Employee.create({ full_name: 'רות', israeli_id: '222222222', branch_id: branch._id, is_active: true });
  await M.EmployeeCommitment.create({ employee_id: dana._id, branch_id: branch._id, classroom: 'תינוקייה', days: [0, 1, 2, 3, 4].map(day => ({ day, start_hhmm: '07:00', end_hhmm: '15:00' })) });
  await M.EmployeeCommitment.create({ employee_id: ruth._id, branch_id: branch._id, classroom: 'צעירים', days: [{ day: 0, start_hhmm: '08:00', end_hhmm: '16:00' }] });
  // Sukkot-style closure on the Tuesday of the week.
  await M.Holiday.create({ branch_id: branch._id, academic_year: '2026-2027', name: 'חג', start_date: new Date('2026-10-13T00:00:00+03:00'), end_date: new Date('2026-10-13T00:00:00+03:00'), kind: 'closure' });

  const WEEK = '2026-10-11';

  console.log('\nהרשאות');
  eq(svc.canEdit(manager, branch._id), true, 'מנהלת עורכת את הסניף שלה');
  eq(svc.canEdit(manager, other._id), false, 'ולא סניף אחר');
  eq(svc.canEdit(admin, branch._id), false, 'אדמין לא עורך ישירות');
  eq(svc.canView(admin, other._id), true, 'אבל רואה הכל');

  console.log('\nלוח לפני פתיחה');
  let board = await svc.getBoard({ user: manager, branchId: String(branch._id), weekStart: WEEK });
  eq(board.week, null, 'אין שבוע עדיין');
  eq(board.preview.length, 5, 'תצוגה מקדימה: 4 ימים של דנה (שלישי סגור) + יום של רות');
  eq(board.pending_primary.map(p => p.full_name), ['רות'], 'רות בלי כיתה ראשית — נשאלת');
  eq(board.pending_primary[0].suggestion, String(young._id), 'הצעה: הכיתה היחידה בקטגוריה');
  eq(board.ratios, { infants: 5, young: 7, older: 9 }, 'יחסי כפר סבא');

  console.log('\nפתיחת שבוע');
  const week = await svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: WEEK });
  eq(week.entries.length, 5, 'נזרע מההתחייבות');
  await throwsStatus(() => svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: WEEK }), 409, 'פתיחה כפולה נדחית');
  await throwsStatus(() => svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: '2026-10-12' }), 400, 'שבוע חייב להתחיל בראשון');
  await throwsStatus(() => svc.createWeek({ user: admin, branchId: String(branch._id), weekStart: '2026-10-18' }), 403, 'אדמין לא פותח');

  console.log('\nשמירה');
  const entries = week.entries.map(e => e.toObject());
  const ruthEntry = entries.find(e => String(e.employee_id) === String(ruth._id));
  ruthEntry.area = 'class'; ruthEntry.classroom_id = infants._id;
  let saved = await svc.saveEntries({ user: manager, weekId: String(week._id), entries });
  eq(saved.entries.find(e => String(e.employee_id) === String(ruth._id)).new_class, true, 'כיתה חדשה לרות מסומנת');
  eq((await M.Employee.findById(ruth._id)).extra_classroom_ids.map(String), [String(infants._id)], 'ונוספה לכיתות שלה לצמיתות');
  const clash = saved.entries.map(e => e.toObject());
  clash.push({ ...clash[0], _id: undefined, start_hhmm: '14:00', end_hhmm: '17:00', area: 'class', classroom_id: young._id });
  await throwsStatus(() => svc.saveEntries({ user: manager, weekId: String(week._id), entries: clash }), 400, 'חפיפה נדחית');

  console.log('\nיחס חניכה');
  board = await svc.getBoard({ user: manager, branchId: String(branch._id), weekStart: WEEK });
  eq(board.warnings.length, 4, '6 תינוקות ב-1/5 צריכים 2: ראשון יש 2; שני/רביעי/חמישי רק דנה; שישי אף אחת');

  console.log('\nסגירת יום');
  saved = await svc.setClosedDay({ user: manager, weekId: String(week._id), date: '2026-10-15', closed: true });
  eq(saved.entries.some(e => e.date === '2026-10-15'), false, 'סגירת יום מוחקת את השיבוצים בו');
  eq(saved.closed_days, ['2026-10-15'], 'ונשמרת');

  console.log('\nפרסום');
  let pub = await svc.publishWeek({ user: manager, weekId: String(week._id) });
  eq(pub.notified, 1, 'פרסום ראשון: דנה (לרות אין משתמש)');
  eq(await M.NotificationEvent.countDocuments({ type: 'shift_published', recipient_id: empUser._id }), 1, 'התראה לדנה');
  const again = pub.week.entries.map(e => e.toObject());
  again.find(e => String(e.employee_id) === String(ruth._id)).end_hhmm = '15:00';
  await svc.saveEntries({ user: manager, weekId: String(week._id), entries: again });
  pub = await svc.publishWeek({ user: manager, weekId: String(week._id) });
  eq(pub.notified, 0, 'פרסום חוזר: רק מי שהשתנה לה (רות, בלי משתמש) — דנה לא');

  console.log('\nמה העובדת רואה');
  const mine = await svc.myShifts({ employee: dana, weekStart: WEEK });
  eq(mine.published, true, 'הסידור פורסם');
  eq(mine.entries.length, pub.week.published.length, 'רואה את כל הסניף');
  eq(mine.me, String(dana._id), 'ויודעת מי היא');

  console.log('\nבקשת שינוי מהמשרד');
  const proposed = pub.week.entries.map(e => e.toObject()).filter(e => String(e.employee_id) !== String(ruth._id));
  const reqDoc = await svc.createEditRequest({ user: admin, weekId: String(week._id), entries: proposed });
  eq(reqDoc.status, 'pending', 'ממתינה');
  eq(await M.NotificationEvent.countDocuments({ type: 'shift_edit_request', recipient_id: managerUser._id }), 1, 'המנהלת קיבלה התראה');
  await throwsStatus(() => svc.decideEditRequest({ user: manager, requestId: String(reqDoc._id), approve: false, reason: '' }), 400, 'דחייה בלי סיבה נדחית');
  const decided = await svc.decideEditRequest({ user: manager, requestId: String(reqDoc._id), approve: true });
  eq(decided.status, 'approved', 'אושרה');
  const afterApprove = await M.ShiftWeek.findById(week._id);
  eq(afterApprove.entries.some(e => String(e.employee_id) === String(ruth._id)), false, 'והשינוי הוחל על העותק בעבודה');

  console.log('\nכיתות ויחסים');
  await throwsStatus(() => svc.closeClassroom({ user: manager, classroomId: String(infants._id) }), 409, 'כיתה עם ילדים לא נסגרת');
  await svc.closeClassroom({ user: manager, classroomId: String(young._id) });
  eq((await M.Classroom.findById(young._id)).is_active, false, 'כיתה ריקה נסגרת');
  await svc.reopenClassroom({ user: manager, classroomId: String(young._id) });
  eq((await M.Classroom.findById(young._id)).is_active, true, 'ונפתחת מחדש');
  await svc.setPrimaryClassroom({ user: manager, employeeId: String(ruth._id), classroomId: String(young._id) });
  eq(String((await M.Employee.findById(ruth._id)).primary_classroom_id), String(young._id), 'כיתה ראשית נשמרה בכרטיס');
  await svc.setRatios({ user: manager, branchId: String(branch._id), ratios: { infants: 4, young: '', older: 10 } });
  board = await svc.getBoard({ user: manager, branchId: String(branch._id), weekStart: WEEK });
  eq(board.ratios, { infants: 4, young: 7, older: 10 }, 'יחס סניף גובר, ריק חוזר לברירת מחדל');

  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
