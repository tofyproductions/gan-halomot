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
async function throwsStatus(fn, status, label, message) {
  try { await fn(); eq('no throw', status, label); } catch (e) { eq(message === undefined ? e.status : [e.status, e.message], message === undefined ? status : [status, message], label); }
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

  // Last year's class, still active with its children — must not reach the rota.
  const oldRoom = await M.Classroom.create({ name: 'תינוקייה 20', category: 'תינוקייה', academic_year: '2025-2026', branch_id: branch._id });
  await M.Child.create({ registration_id: reg._id, child_name: 'ילד ישן', academic_year: '2025-2026', classroom_id: oldRoom._id, is_active: true });

  console.log('\nלוח לפני פתיחה');
  let board = await svc.getBoard({ user: manager, branchId: String(branch._id), weekStart: WEEK });
  eq(board.week, null, 'אין שבוע עדיין');
  eq(board.preview.length, 5, 'תצוגה מקדימה: 4 ימים של דנה (שלישי סגור) + יום של רות');
  eq(board.pending_primary.map(p => p.full_name), ['רות'], 'רות בלי כיתה ראשית — נשאלת');
  eq(board.pending_primary[0].suggestion, String(young._id), 'הצעה: הכיתה היחידה בקטגוריה');
  eq(board.ratios, { infants: 5, young: 7, older: 9 }, 'יחסי כפר סבא');
  eq(board.classrooms.map(c => c._id).includes(String(oldRoom._id)), false, 'כיתה משנה קודמת לא מופיעה בלוח');
  eq(board.classrooms.length, 2, 'רק כיתות השנה של השבוע');
  eq(board.ratio_overrides, { infants: '', young: '', older: '' }, 'בלי יחס סניף — הכל ריק (ברירת מחדל עירונית)');

  console.log('\nפתיחת שבוע');
  const week = await svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: WEEK });
  eq(week.entries.length, 5, 'נזרע מההתחייבות');
  await throwsStatus(() => svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: WEEK }), 409, 'פתיחה כפולה נדחית');
  await throwsStatus(() => svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: '2026-10-12' }), 400, 'שבוע חייב להתחיל בראשון');
  await throwsStatus(() => svc.createWeek({ user: admin, branchId: String(branch._id), weekStart: '2026-10-18' }), 403, 'אדמין לא פותח');
  await M.ShiftWeek.init();
  const realExists = M.ShiftWeek.exists;
  M.ShiftWeek.exists = async () => null; // two clicks racing past the pre-check
  await throwsStatus(() => svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: WEEK }), 409, 'מרוץ פתיחה: מפתח כפול → 409', 'הסידור לשבוע הזה כבר נפתח');
  M.ShiftWeek.exists = realExists;

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
  const reversed = saved.entries.map(e => e.toObject());
  const danaFirst = reversed.find(e => String(e.employee_id) === String(dana._id));
  danaFirst.start_hhmm = '16:00'; danaFirst.end_hhmm = '07:00';
  await throwsStatus(() => svc.saveEntries({ user: manager, weekId: String(week._id), entries: reversed }), 400, 'סיום לפני התחלה נדחה', `דנה — שעת הסיום לפני שעת ההתחלה ב-${danaFirst.date}`);
  const unpadded = saved.entries.map(e => e.toObject());
  const danaPad = unpadded.find(e => String(e.employee_id) === String(dana._id));
  danaPad.start_hhmm = '7:00';
  saved = await svc.saveEntries({ user: manager, weekId: String(week._id), entries: unpadded });
  eq(saved.entries.find(e => String(e._id) === String(danaPad._id)).start_hhmm, '07:00', "שעה '7:00' נשמרת כ-'07:00' ולא נמחקת");

  console.log('\nיחס חניכה');
  board = await svc.getBoard({ user: manager, branchId: String(branch._id), weekStart: WEEK });
  eq(board.warnings.length, 4, '6 תינוקות ב-1/5 צריכים 2: ראשון יש 2; שני/רביעי/חמישי רק דנה; שישי אף אחת');

  console.log('\nסגירת יום');
  saved = await svc.setClosedDay({ user: manager, weekId: String(week._id), date: '2026-10-15', closed: true });
  eq(saved.entries.some(e => e.date === '2026-10-15'), false, 'סגירת יום מוחקת את השיבוצים בו');
  eq(saved.closed_days, ['2026-10-15'], 'ונשמרת');

  console.log('\nפרסום');
  let pub = await svc.publishWeek({ user: manager, weekId: String(week._id), now: new Date('2026-10-08T16:00:00Z') });
  eq(pub.notified, 1, 'פרסום ראשון: דנה (לרות אין משתמש)');
  eq(await M.NotificationEvent.countDocuments({ type: 'shift_published', recipient_id: empUser._id }), 1, 'התראה לדנה');
  const again = pub.week.entries.map(e => e.toObject());
  again.find(e => String(e.employee_id) === String(ruth._id)).end_hhmm = '15:00';
  await svc.saveEntries({ user: manager, weekId: String(week._id), entries: again });
  pub = await svc.publishWeek({ user: manager, weekId: String(week._id), now: new Date('2026-10-08T16:00:00Z') });
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

  console.log('\nבקשה מול סידור שהשתנה אחריה');
  const base3 = afterApprove.entries.map(e => e.toObject());
  const danaLate = base3.find(e => String(e.employee_id) === String(dana._id));
  const proposed3 = base3.map(e => (String(e._id) === String(danaLate._id) ? { ...e, end_hhmm: '14:00' } : e));
  const stale = await svc.createEditRequest({ user: admin, weekId: String(week._id), entries: proposed3 });
  eq(stale.changed_names, ['דנה'], 'הבקשה יודעת אצל מי השינוי');
  eq(new Date(stale.week_version).getTime(), afterApprove.updated_at.getTime(), 'ועל איזו גרסה של הסידור היא נשלחה');
  await new Promise(r => setTimeout(r, 5));
  const managerEdit = base3.map(e => (String(e._id) === String(danaLate._id) ? { ...e, start_hhmm: '08:00' } : e));
  await svc.saveEntries({ user: manager, weekId: String(week._id), entries: managerEdit });
  await throwsStatus(() => svc.decideEditRequest({ user: manager, requestId: String(stale._id), approve: true }), 409, 'אישור אחרי שהמנהלת שינתה — 409', 'הסידור השתנה מאז שהבקשה נשלחה — יש לדחות ולבקש מחדש');
  eq((await M.ShiftWeek.findById(week._id)).entries.find(e => String(e._id) === String(danaLate._id)).start_hhmm, '08:00', 'והשינוי של המנהלת לא נדרס');
  const staleRejected = await svc.decideEditRequest({ user: manager, requestId: String(stale._id), approve: false, reason: 'הסידור השתנה' });
  eq([staleRejected.status, staleRejected.reject_reason], ['rejected', 'הסידור השתנה'], 'דחייה עם סיבה עדיין אפשרית');

  console.log('\nסניף בלי מנהלת');
  const orphanWeek = await M.ShiftWeek.create({ branch_id: other._id, week_start: WEEK, entries: [] });
  const before = await M.ShiftEditRequest.countDocuments({});
  await throwsStatus(() => svc.createEditRequest({ user: admin, weekId: String(orphanWeek._id), entries: [] }), 409, 'בקשה לסניף בלי מנהלת נדחית', 'לסניף אין מנהלת — אין מי שיאשר את הבקשה');
  eq(await M.ShiftEditRequest.countDocuments({}), before, 'ולא נוצרה בקשה');

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
  eq(board.ratio_overrides, { infants: 4, young: '', older: 10 }, 'והערכים הגולמיים של הסניף חוזרים לטופס');

  console.log('\nגבול סניף ושדות שהשרת קובע');
  const foreignEmp = await M.Employee.create({ full_name: 'זרה', israeli_id: '333333333', branch_id: other._id, is_active: true });
  const foreignRoom = await M.Classroom.create({ name: 'אחר', category: 'צעירים', academic_year: '2026-2027', branch_id: other._id });
  const WEEK2 = '2026-10-25';
  const w2 = await svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: WEEK2 });
  const base2 = () => w2.entries.map(e => e.toObject());
  const foreignEntry = { employee_id: foreignEmp._id, date: '2026-10-26', area: 'floater', start_hhmm: '08:00', end_hhmm: '12:00' };
  await throwsStatus(() => svc.saveEntries({ user: manager, weekId: String(w2._id), entries: [...base2(), foreignEntry] }), 400, 'עובדת מסניף אחר נדחית', 'זרה לא שייכת לסניף הזה');
  eq((await M.Employee.findById(foreignEmp._id)).extra_classroom_ids.length, 0, 'ולא נכתב דבר לכרטיס שלה');
  const isDana = e => String(e.employee_id) === String(dana._id);
  const danaE = base2().find(isDana);
  const swapRoom = base2().map(e => (isDana(e) && e.date === danaE.date ? { ...e, area: 'class', classroom_id: foreignRoom._id } : e));
  eq(swapRoom.length, w2.entries.length, 'הכיתה הזרה מחליפה את השורה, בלי כפילות');
  await throwsStatus(() => svc.saveEntries({ user: manager, weekId: String(w2._id), entries: swapRoom }), 400, 'כיתה מסניף אחר נדחית', 'הכיתה לא שייכת לסניף');
  await throwsStatus(() => svc.createEditRequest({ user: admin, weekId: String(w2._id), entries: [...base2(), foreignEntry] }), 400, 'בקשת משרד עם עובדת זרה נדחית', 'זרה לא שייכת לסניף הזה');

  const spoof = base2().map(e => (isDana(e) && e.date === danaE.date ? { ...e, employee_name: 'מזויף' } : e));
  eq(spoof.find(e => e.employee_name === 'מזויף') !== undefined, true, 'השם המזויף אכן נשלח');
  let s2 = await svc.saveEntries({ user: manager, weekId: String(w2._id), entries: spoof });
  eq(s2.entries.filter(e => e.employee_name === 'מזויף').length, 0, 'שם מזויף לא נשמר');
  eq(s2.entries.find(e => isDana(e) && e.date === danaE.date).employee_name, 'דנה', 'ובמקומו השם האמיתי');

  const moveDana = (room) => s2.entries.map(e => e.toObject()).map(e => (String(e.employee_id) === String(dana._id) && e.date === danaE.date ? { ...e, area: 'class', classroom_id: room._id, new_class: false } : e));
  const danaOn = (w) => w.entries.find(e => String(e.employee_id) === String(dana._id) && e.date === danaE.date);
  s2 = await svc.saveEntries({ user: manager, weekId: String(w2._id), entries: moveDana(young) });
  eq(danaOn(s2).new_class, true, 'כיתה חדשה מסומנת בשרת');
  s2 = await svc.saveEntries({ user: manager, weekId: String(w2._id), entries: moveDana(young) });
  eq(danaOn(s2).new_class, true, 'ונשארת מסומנת בשמירה שנייה');
  s2 = await svc.saveEntries({ user: manager, weekId: String(w2._id), entries: moveDana(infants) });
  eq(danaOn(s2).new_class, false, 'וחוזרת לריקה אחרי חזרה לכיתה הראשית');

  const rej = await svc.createEditRequest({ user: admin, weekId: String(w2._id), entries: s2.entries.map(e => e.toObject()) });
  const rejected = await svc.decideEditRequest({ user: manager, requestId: String(rej._id), approve: false, reason: 'לא מתאים' });
  eq([rejected.status, rejected.reject_reason], ['rejected', 'לא מתאים'], 'דחייה עם סיבה נשמרת');
  await throwsStatus(() => svc.decideEditRequest({ user: manager, requestId: String(rej._id), approve: true }), 409, 'החלטה שנייה נדחית');
  await throwsStatus(() => svc.getBoard({ user: manager, branchId: 'bad', weekStart: WEEK }), 404, 'מזהה סניף לא תקין — 404');

  console.log('\nאילוצים בסידור');
  const NEXT = '2026-10-18';
  const wk2 = await svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: NEXT });
  const accepted = await M.ShiftConstraint.create({ employee_id: dana._id, employee_name: 'דנה', branch_id: branch._id, type: 'day_off', date: '2026-10-19', week_start: NEXT, details: 'x', status: 'accepted' });
  const blockedEntries = wk2.entries.map(e => e.toObject()).filter(e => !(String(e.employee_id) === String(dana._id) && e.date === '2026-10-19'));
  blockedEntries.push({ employee_id: dana._id, date: '2026-10-19', area: 'class', classroom_id: infants._id, start_hhmm: '07:00', end_hhmm: '15:00' });
  await throwsStatus(() => svc.saveEntries({ user: manager, weekId: String(wk2._id), entries: blockedEntries }), 400, 'שיבוץ על אילוץ מאושר נדחה');
  const boardC = await svc.getBoard({ user: manager, branchId: String(branch._id), weekStart: NEXT });
  eq(boardC.constraints.map(c => String(c._id)), [String(accepted._id)], 'הלוח מחזיר את אילוצי השבוע');
  const openRespected = await M.ShiftConstraint.create({ employee_id: ruth._id, employee_name: 'רות', branch_id: branch._id, type: 'day_off', date: '2026-10-22', week_start: NEXT, details: 'x', status: 'open' });
  const openOther = await M.ShiftConstraint.create({ employee_id: ruth._id, employee_name: 'רות', branch_id: branch._id, type: 'other', date: '2026-10-20', week_start: NEXT, details: 'x', status: 'open' });
  await throwsStatus(() => svc.publishWeek({ user: manager, weekId: String(wk2._id), now: new Date('2026-10-14T09:00:00Z') }), 409, 'פרסום לפני סגירת חלון ההגשה נחסם', 'אי אפשר לסגור את הסידור לפני שהגשת האילוצים נסגרת (יום חמישי ב-18:00)');
  eq((await M.ShiftConstraint.findById(openRespected._id)).status, 'open', 'ולא אישר כלום כשהחלון פתוח');
  const AFTER = new Date('2026-10-15T16:00:00Z');
  await throwsStatus(() => svc.publishWeek({ user: manager, weekId: String(wk2._id), now: AFTER }), 409, 'פרסום נחסם כשיש אילוץ לא מטופל');
  eq((await M.ShiftConstraint.findById(openRespected._id)).status, 'open', 'ולא אישר כלום בינתיים');
  await M.ShiftConstraint.updateOne({ _id: openOther._id }, { $set: { status: 'rejected', reject_reason: 'x' } });
  // The week was opened before Dana's day off was accepted, so the seed still has her on 2026-10-19.
  eq(wk2.entries.some(e => String(e.employee_id) === String(dana._id) && e.date === '2026-10-19'), true, 'השבוע נפתח לפני האישור — דנה עדיין משובצת ב-19/10');
  await throwsStatus(() => svc.publishWeek({ user: manager, weekId: String(wk2._id), now: AFTER }), 409, 'פרסום נחסם כשמישהי משובצת על אילוץ מאושר', 'דנה משובצת ב-2026-10-19 למרות אילוץ מאושר — יש להסיר את השיבוץ לפני הסגירה');
  eq([(await M.ShiftWeek.findById(wk2._id)).published_at, (await M.ShiftConstraint.findById(openRespected._id)).status], [null, 'open'], 'ולא פורסם ולא אושר כלום');
  const withoutDanaOff = (await M.ShiftWeek.findById(wk2._id)).entries.map(e => e.toObject()).filter(e => !(String(e.employee_id) === String(dana._id) && e.date === '2026-10-19'));
  await svc.saveEntries({ user: manager, weekId: String(wk2._id), entries: withoutDanaOff });
  const pub2 = await svc.publishWeek({ user: manager, weekId: String(wk2._id), now: AFTER });
  eq([pub2.auto_accepted, (await M.ShiftConstraint.findById(openRespected._id)).status, (await M.ShiftConstraint.findById(openRespected._id)).decided_auto], [1, 'accepted', true], 'מה שהסידור כבר מכבד — מתקבל אוטומטית בפרסום');
  eq(pub2.week.published.some(e => String(e.employee_id) === String(dana._id) && e.date === '2026-10-19'), false, 'הסידור שפורסם מכבד את האילוץ המאושר');

  console.log('\nפתיחת שבוע מול אילוץ מאושר');
  const WEEK_NOV = '2026-11-01';
  await M.ShiftConstraint.create({ employee_id: dana._id, employee_name: 'דנה', branch_id: branch._id, type: 'day_off', date: '2026-11-02', week_start: WEEK_NOV, details: 'x', status: 'accepted' });
  const boardNov = await svc.getBoard({ user: manager, branchId: String(branch._id), weekStart: WEEK_NOV });
  eq(boardNov.preview.some(e => String(e.employee_id) === String(dana._id) && e.date === '2026-11-02'), false, 'התצוגה המקדימה לא משבצת על אילוץ מאושר');
  eq(boardNov.preview.filter(e => String(e.employee_id) === String(dana._id)).length, 4, 'ושאר הימים של דנה נזרעים');
  const wkNov = await svc.createWeek({ user: manager, branchId: String(branch._id), weekStart: WEEK_NOV });
  eq(wkNov.entries.some(e => String(e.employee_id) === String(dana._id) && e.date === '2026-11-02'), false, 'פתיחת שבוע לא זורעת שיבוץ על אילוץ מאושר');
  eq(wkNov.entries.filter(e => String(e.employee_id) === String(dana._id)).length, 4, 'ושאר הימים שלה נזרעים');

  console.log('\nשבוע שעבר');
  const pubPast = await svc.publishWeek({ user: manager, weekId: String(week._id), now: new Date('2026-11-01T09:00:00Z') });
  eq(!!pubPast.week.published_at, true, 'שבוע שעבר עדיין אפשר לסגור');

  await new Promise(r => setTimeout(r, 500)); // let in-flight notification pushes settle
  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
