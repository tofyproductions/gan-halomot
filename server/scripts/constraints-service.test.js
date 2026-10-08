#!/usr/bin/env node
/**
 * אילוצים against an in-memory database: submitting (window, validation,
 * files), swaps (colleague, broadcast, volunteers, pick), deciding (reason,
 * far future, EmployeeRequest), cancelling, and what each side may see.
 *
 *   node scripts/constraints-service.test.js
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
async function throws(fn, status, message, label) {
  try { await fn(); eq('no throw', status, label); } catch (e) { eq([e.status, message ? e.message : undefined], [status, message], label); }
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const M = require('../src/models');
  const svc = require('../src/services/shifts/constraints.service');

  const NOW = new Date('2026-10-07T09:00:00Z'); // Wed, next week = 2026-10-11..16
  const LATE = new Date('2026-10-08T16:00:00Z'); // Thu 19:00 IL
  const branch = await M.Branch.create({ name: 'כפר סבא - קפלן' });
  const other = await M.Branch.create({ name: 'הרצליה הרצוג' });
  let idn = 100000000;
  const mkUser = (role, extra = {}) => M.User.create({ full_name: role, id_number: String(idn++), email: `${idn}@x.l`, password_hash: 'x', role, is_active: true, ...extra });
  const mgrUser = await mkUser('branch_manager', { managed_branch_ids: [branch._id], branch_id: branch._id });
  const manager = { id: String(mgrUser._id), role: 'branch_manager', managed_branch_ids: [String(branch._id)], full_name: 'מנהלת' };
  const admin = { id: String((await mkUser('system_admin'))._id), role: 'system_admin', full_name: 'אדמין' };
  const accountant = { id: String((await mkUser('accountant'))._id), role: 'accountant', full_name: 'הנה״ח' };
  const mkEmp = async (name, b = branch) => {
    const u = await mkUser('teacher', { branch_id: b._id });
    return M.Employee.create({ full_name: name, israeli_id: String(idn++), branch_id: b._id, user_id: u._id, is_active: true });
  };
  const dana = await mkEmp('דנה'); const ruth = await mkEmp('רות'); const noa = await mkEmp('נועה'); const far = await mkEmp('זרה', other);

  console.log('\nהגשה');
  const c1 = await svc.createConstraint({ employee: dana, body: { type: 'day_off', date: '2026-10-13', details: 'חתונה' }, files: [], now: NOW });
  eq([c1.status, c1.week_start, c1.employee_name], ['open', '2026-10-11', 'דנה'], 'יום חופש לשבוע הבא — פתוח');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'day_off', date: '2026-10-13', details: 'x' }, files: [], now: LATE }), 400, 'ההגשה לשבוע הבא נסגרה ביום חמישי ב-18:00', 'אחרי חמישי 18:00 — חסום');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'day_off', date: '2026-10-13', details: '' }, files: [], now: NOW }), 400, 'יש לכתוב סיבה או פירוט', 'בלי פירוט — חסום');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'partial', date: '2026-10-13', from_hhmm: '12:00', to_hhmm: '10:00', details: 'רופא' }, files: [], now: NOW }), 400, 'שעת הסיום חייבת להיות אחרי שעת ההתחלה', 'טווח שעות הפוך — חסום');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'move_day', date: '2026-10-13' }, files: [], now: NOW }), 400, 'חסר היום שבו תעבדי במקום', 'העברת יום בלי יום יעד — חסום');
  const withFile = await svc.createConstraint({ employee: dana, body: { type: 'sick_expected', date: '2026-10-21', details: 'ניתוח' }, files: [{ originalname: 'a.pdf', mimetype: 'application/pdf', size: 3, buffer: Buffer.from('abc') }], now: LATE });
  const storedFile = (await M.ShiftConstraint.findById(withFile._id).lean()).files[0];
  eq([withFile.files.length, withFile.files[0].name, !!storedFile.file_data], [1, 'a.pdf', true], 'מסמך נשמר; שבוע רחוק פתוח גם אחרי חמישי');
  eq([withFile.files[0].file_data, withFile.files[0].storage_key], [undefined, undefined], 'ההחזרה למגישה בלי תוכן הקובץ');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'day_off', date: 'abc', details: 'x' }, files: [], now: NOW }), 400, 'תאריך לא תקין', 'תאריך לא תקין');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'move_day', date: '2026-10-13', target_date: '2026-10-20' }, files: [], now: NOW }), 400, 'שני הימים צריכים להיות באותו שבוע', 'העברת יום לשבוע אחר — חסום');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'swap', swap_mode: 'mutual', date: '2026-10-14', target_date: '2026-10-21', colleague_id: String(ruth._id) }, files: [], now: NOW }), 400, 'שני הימים צריכים להיות באותו שבוע', 'החלפה הדדית בין שבועות — חסום');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'day_off', date: '2026-10-13', details: 'שוב' }, files: [], now: NOW }), 409, 'כבר הגשת אילוץ כזה לתאריך הזה', 'אותו אילוץ פעמיים — חסום');
  const otherType = await svc.createConstraint({ employee: dana, body: { type: 'other', date: '2026-10-13', details: 'הערה' }, files: [], now: NOW });
  eq(otherType.status, 'open', 'סוג אחר באותו תאריך — מותר');
  await M.ShiftConstraint.updateOne({ _id: otherType._id }, { $set: { status: 'cancelled' } });
  const again = await svc.createConstraint({ employee: dana, body: { type: 'other', date: '2026-10-13', details: 'שוב' }, files: [], now: NOW });
  eq(again.status, 'open', 'אחרי ביטול — אפשר להגיש שוב');
  await M.ShiftConstraint.updateOne({ _id: again._id }, { $set: { status: 'cancelled' } });
  await throws(() => svc.createConstraint({ employee: { _id: dana._id, full_name: 'דנה', branch_id: null }, body: { type: 'day_off', date: '2026-10-12', details: 'x' }, files: [], now: NOW }), 400, 'לכרטיס העובדת לא מוגדר סניף', 'עובדת בלי סניף — חסום');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'other', date: '2026-10-21', details: 'x' }, files: [{ originalname: 'a.exe', mimetype: 'application/x-msdownload', size: 3, buffer: Buffer.from('a') }], now: NOW }), 400, 'אפשר לצרף רק PDF או תמונה (JPG/PNG)', 'סוג קובץ לא מורשה');

  console.log('\nהחלפה עם עובדת שנבחרה');
  const sw = await svc.createConstraint({ employee: dana, body: { type: 'swap', swap_mode: 'handover', date: '2026-10-14', colleague_id: String(ruth._id) }, files: [], now: NOW });
  eq(sw.status, 'pending_colleague', 'ממתינה לעובדת השנייה');
  eq(await M.NotificationEvent.countDocuments({ type: 'swap_request' }), 1, 'רות קיבלה התראה');
  await throws(() => svc.createConstraint({ employee: dana, body: { type: 'swap', swap_mode: 'handover', date: '2026-10-14', colleague_id: String(far._id) }, files: [], now: NOW }), 400, 'העובדת לא נמצאה בסניף שלך', 'עובדת מסניף אחר — חסום');
  await throws(() => svc.respondColleague({ employee: noa, id: String(sw._id), accept: true, now: NOW }), 403, 'הבקשה לא מיועדת לך', 'עובדת אחרת לא יכולה לענות');
  const swOpen = await svc.respondColleague({ employee: ruth, id: String(sw._id), accept: true, now: NOW });
  eq(swOpen.status, 'open', 'רות הסכימה — עובר למנהלת');
  eq((swOpen.files || []).some(f => f.file_data || f.storage_key), false, 'תשובת העובדת השנייה בלי תוכן קבצים');
  const swLate = await svc.createConstraint({ employee: ruth, body: { type: 'swap', swap_mode: 'handover', date: '2026-10-12', colleague_id: String(noa._id) }, files: [], now: NOW });
  await throws(() => svc.respondColleague({ employee: noa, id: String(swLate._id), accept: true, now: new Date('2026-10-12T06:00:00Z') }), 409, 'הבקשה כבר לא רלוונטית', 'תשובה כשהשבוע כבר התחיל — חסום');
  eq((await M.ShiftConstraint.findById(swLate._id).lean()).status, 'pending_colleague', 'והבקשה לא השתנתה');
  const swPub = await svc.createConstraint({ employee: ruth, body: { type: 'swap', swap_mode: 'handover', date: '2026-10-26', colleague_id: String(noa._id) }, files: [], now: NOW });
  await M.ShiftWeek.create({ branch_id: branch._id, week_start: '2026-10-25', published_at: new Date() });
  await throws(() => svc.respondColleague({ employee: noa, id: String(swPub._id), accept: true, now: NOW }), 409, 'הבקשה כבר לא רלוונטית', 'תשובה אחרי שהסידור פורסם — חסום');

  console.log('\nהצעה לכל הסניף');
  const bc = await svc.createConstraint({ employee: dana, body: { type: 'swap', swap_mode: 'handover', date: '2026-10-15', broadcast: true }, files: [], now: NOW });
  eq(bc.status, 'pending_broadcast', 'ממתינה לאישור המנהלת לפני שליחה');
  await throws(() => svc.volunteer({ employee: ruth, id: String(bc._id) }), 409, 'ההצעה עוד לא נשלחה', 'אי אפשר להתנדב לפני שליחה');
  await svc.approveBroadcast({ user: manager, id: String(bc._id) });
  eq(await M.NotificationEvent.countDocuments({ type: 'swap_offer' }), 2, 'רות ונועה קיבלו הצעה (לא דנה, לא סניף אחר)');
  await svc.volunteer({ employee: ruth, id: String(bc._id) });
  await svc.volunteer({ employee: noa, id: String(bc._id) });
  const mineDana = await svc.listMine({ employee: dana });
  const bcMine = mineDana.mine.find(x => String(x._id) === String(bc._id));
  eq([bcMine.volunteer_count, bcMine.volunteers], [2, undefined], 'המבקשת רואה רק כמה — לא מי');
  const mineRuth = await svc.listMine({ employee: ruth });
  eq(mineRuth.offers.map(o => [String(o._id), o.i_volunteered, o.volunteer_count]), [[String(bc._id), true, undefined]], 'מתנדבת רואה שסימנה — בלי ספירה');
  const picked = await svc.pickVolunteer({ user: manager, id: String(bc._id), employeeId: String(noa._id) });
  eq([picked.status, String(picked.colleague_id)], ['accepted', String(noa._id)], 'המנהלת בחרה את נועה');
  const bc3 = await svc.createConstraint({ employee: dana, body: { type: 'swap', swap_mode: 'handover', date: '2026-10-19', broadcast: true }, files: [], now: NOW });
  await svc.approveBroadcast({ user: manager, id: String(bc3._id) });
  await svc.volunteer({ employee: ruth, id: String(bc3._id) });
  await svc.volunteer({ employee: noa, id: String(bc3._id) });
  await M.Employee.updateOne({ _id: noa._id }, { $set: { is_active: false } });
  await throws(() => svc.pickVolunteer({ user: manager, id: String(bc3._id), employeeId: String(noa._id) }), 400, 'העובדת לא פעילה בסניף', 'מתנדבת שעזבה לא נבחרת');
  await M.Employee.updateOne({ _id: noa._id }, { $set: { is_active: true, branch_id: other._id } });
  await throws(() => svc.pickVolunteer({ user: manager, id: String(bc3._id), employeeId: String(noa._id) }), 400, 'העובדת לא פעילה בסניף', 'מתנדבת שעברה סניף לא נבחרת');
  await M.Employee.updateOne({ _id: noa._id }, { $set: { branch_id: branch._id } });
  eq((await svc.pickVolunteer({ user: manager, id: String(bc3._id), employeeId: String(ruth._id) })).status, 'accepted', 'מתנדבת פעילה בסניף — נבחרת');

  console.log('\nהחלפה — גם העובדת השנייה שומעת');
  const swA = await svc.createConstraint({ employee: dana, body: { type: 'swap', swap_mode: 'handover', date: '2026-10-20', colleague_id: String(ruth._id) }, files: [], now: NOW });
  await svc.respondColleague({ employee: ruth, id: String(swA._id), accept: true, now: NOW });
  await svc.decide({ user: manager, id: String(swA._id), accept: true, confirmFar: true, now: NOW });
  eq(await M.NotificationEvent.countDocuments({ type: 'constraint_decision', ref_id: swA._id }), 2, 'אישור החלפה — התראה למבקשת ולעובדת השנייה');
  eq(await M.NotificationEvent.countDocuments({ type: 'constraint_decision', ref_id: swA._id, recipient_id: ruth.user_id, title: 'ההחלפה אושרה' }), 1, 'רות קיבלה "ההחלפה אושרה"');
  const swR = await svc.createConstraint({ employee: dana, body: { type: 'swap', swap_mode: 'handover', date: '2026-10-21', colleague_id: String(ruth._id) }, files: [], now: NOW });
  await svc.respondColleague({ employee: ruth, id: String(swR._id), accept: true, now: NOW });
  await svc.decide({ user: manager, id: String(swR._id), accept: false, reason: 'אין כיסוי', now: NOW });
  eq(await M.NotificationEvent.countDocuments({ type: 'constraint_decision', ref_id: swR._id }), 2, 'דחיית החלפה — התראה לשתיהן');
  eq(await M.NotificationEvent.countDocuments({ type: 'constraint_decision', ref_id: swR._id, recipient_id: ruth.user_id, title: 'ההחלפה לא אושרה' }), 1, 'רות קיבלה "ההחלפה לא אושרה"');
  eq(await M.NotificationEvent.countDocuments({ type: 'swap_response', ref_id: swA._id, recipient_id: ruth.user_id }), 0, 'לפני ביטול — לרות אין התראת ביטול');
  await svc.cancelConstraint({ employee: dana, id: String(swA._id) });
  eq(await M.NotificationEvent.countDocuments({ type: 'swap_response', ref_id: swA._id, recipient_id: ruth.user_id, title: 'דנה ביטלה את בקשת ההחלפה' }), 1, 'ביטול החלפה מאושרת — רות מקבלת הודעה');

  console.log('\nהחלטת מנהלת');
  await throws(() => svc.decide({ user: manager, id: String(c1._id), accept: false, reason: ' ', now: NOW }), 400, 'יש לכתוב סיבה לדחייה', 'דחייה בלי סיבה');
  await throws(() => svc.decide({ user: accountant, id: String(c1._id), accept: true, now: NOW }), 403, 'רק מנהלת הסניף עורכת את הסידור', 'הנה״ח לא מחליטה');
  const acc = await svc.decide({ user: manager, id: String(c1._id), accept: true, now: NOW });
  const er = await M.EmployeeRequest.findById(acc.employee_request_id).lean();
  eq([acc.status, er.type, er.status, er.from_date, er.to_date, String(er.employee_id)], ['accepted', 'vacation', 'pending_accountant', '2026-10-13', '2026-10-13', String(dana._id)], 'אושר → בקשת חופשה להנה״ח');
  eq(await M.NotificationEvent.countDocuments({ type: 'constraint_decision', ref_id: c1._id }), 1, 'דנה קיבלה התראה');
  await throws(() => svc.decide({ user: manager, id: String(withFile._id), accept: true, now: NOW }), 409, 'אילוץ לשבוע רחוק — יש לאשר שהפעולה סופית', 'שבוע רחוק בלי אישור סופי');
  const accFar = await svc.decide({ user: manager, id: String(withFile._id), accept: true, confirmFar: true, now: NOW });
  const sickEr = await M.EmployeeRequest.findById(accFar.employee_request_id).lean();
  eq(sickEr.type, 'sick', 'מחלה צפויה → בקשת מחלה');
  eq([sickEr.medical_file_name, sickEr.medical_file_data], ['a.pdf', Buffer.from('abc').toString('base64')], 'המסמך הרפואי עובר לבקשת המחלה');
  eq([accFar.files.length, accFar.files.some(f => f.file_data || f.storage_key)], [1, false], 'החלטת מנהלת — בלי תוכן קבצים');
  await throws(() => svc.decide({ user: manager, id: String(c1._id), accept: false, reason: 'x', now: NOW }), 409, 'האילוץ כבר טופל', 'החלטה כפולה');

  console.log('\nביטול');
  const er2 = await svc.cancelConstraint({ employee: dana, id: String(c1._id) });
  eq([er2.constraint.status, (await M.EmployeeRequest.findById(acc.employee_request_id).lean()).status], ['cancelled', 'rejected'], 'ביטול אילוץ מאושר מבטל גם את בקשת החופשה הממתינה');
  await M.EmployeeRequest.updateOne({ _id: accFar.employee_request_id }, { $set: { status: 'approved' } });
  await throws(() => svc.cancelConstraint({ employee: dana, id: String(withFile._id) }), 409, 'הבקשה כבר אושרה בהנהלת החשבונות — פני למשרד', 'בקשה שאושרה בהנה״ח — לא מבוטלת כאן');
  await throws(() => svc.cancelConstraint({ employee: ruth, id: String(withFile._id) }), 403, 'זה לא האילוץ שלך', 'עובדת אחרת לא מבטלת');
  await M.ShiftWeek.create({ branch_id: branch._id, week_start: '2026-10-11', published_at: new Date() });
  const late = await svc.cancelConstraint({ employee: dana, id: String(swOpen._id) });
  eq([late.after_publish, late.constraint.cancelled_after_publish], [true, true], 'ביטול אחרי פרסום — מסומן');
  eq(await M.NotificationEvent.countDocuments({ type: 'constraint_cancelled', recipient_id: mgrUser._id }), 1, 'המנהלת קיבלה התראה');
  eq(await M.NotificationEvent.countDocuments({ type: 'swap_response', ref_id: swOpen._id, recipient_id: ruth.user_id }), 1, 'ביטול החלפה פתוחה — גם רות מקבלת הודעה');
  eq(await M.NotificationEvent.countDocuments({ type: 'swap_response', ref_id: bc._id }), 0, 'הצעה לכל הסניף בלי עובדת שנייה — אין התראת ביטול');

  const bc2 = await svc.createConstraint({ employee: dana, body: { type: 'swap', swap_mode: 'handover', date: '2026-10-16', broadcast: true }, files: [], now: NOW });
  await svc.approveBroadcast({ user: manager, id: String(bc2._id) });
  await svc.volunteer({ employee: ruth, id: String(bc2._id) });
  const bc2c = await svc.cancelConstraint({ employee: dana, id: String(bc2._id) });
  eq(['volunteers' in bc2c.constraint, bc2c.constraint.volunteer_count], [false, 1], 'ביטול אחרי התנדבות — בלי רשימת מתנדבות, עם ספירה');

  console.log('\nקבצים והרשאות צפייה');
  const file = await svc.readFile({ employee: dana, id: String(withFile._id), index: 0 });
  eq([file.name, file.buffer.toString()], ['a.pdf', 'abc'], 'הבעלים מוריד');
  const fileMgr = await svc.readFile({ user: manager, id: String(withFile._id), index: 0 });
  eq(fileMgr.buffer.toString(), 'abc', 'המנהלת מורידה');
  await throws(() => svc.readFile({ employee: ruth, id: String(withFile._id), index: 0 }), 403, 'אין הרשאה לקובץ', 'עובדת אחרת לא מורידה');

  console.log('\nאילוצים עתידיים ולוח');
  const future = await svc.listFuture({ user: manager, branchId: String(branch._id), now: NOW });
  eq(future.map(f => String(f._id)), [], 'אין עתידיים פתוחים (הרחוק אושר)');
  const board = await svc.forBoard({ branchId: String(branch._id), dates: ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'], entries: [{ employee_id: String(ruth._id), date: '2026-10-15', start_hhmm: '07:00', end_hhmm: '15:00' }] });
  eq(board.map(b => b.type).sort(), ['swap'], 'בלוח: רק אילוצים פעילים או מאושרים של השבוע');
  eq(board[0].volunteers.map(v => [v.full_name, v.free_that_day]), [['רות', false], ['נועה', true]], 'המנהלת רואה מתנדבות ומי פנויה');

  console.log('\nאישור מיישם את האילוץ בסידור');
  const W = '2026-10-18';
  const mkEntry = (emp, date, start = '07:00', end = '16:30') => ({
    employee_id: emp._id, employee_name: emp.full_name, date, area: 'floater', start_hhmm: start, end_hhmm: end,
  });
  const wk = await M.ShiftWeek.create({
    branch_id: branch._id, week_start: W,
    entries: [mkEntry(dana, '2026-10-19'), mkEntry(dana, '2026-10-20'), mkEntry(dana, '2026-10-21')],
  });
  const entriesNow = async () => (await M.ShiftWeek.findById(wk._id).lean()).entries
    .map(e => [String(e.employee_id) === String(dana._id) ? 'דנה' : 'רות', e.date, `${e.start_hhmm}-${e.end_hhmm}`]).sort();

  const dayOff = await svc.createConstraint({ employee: dana, body: { type: 'day_off', date: '2026-10-20', details: 'חתונה' }, files: [], now: NOW });
  const dayOffAcc = await svc.decide({ user: manager, id: String(dayOff._id), accept: true, confirmFar: true, now: NOW });
  eq([dayOffAcc.applied.applied, dayOffAcc.applied.removed], [true, 1], 'יום חופש אושר — השיבוץ של אותו יום הוסר');
  eq((await entriesNow()).some(e => e[1] === '2026-10-20'), false, 'ובסידור אין יותר שיבוץ ב-20.10');

  const move = await svc.createConstraint({ employee: dana, body: { type: 'move_day', date: '2026-10-21', target_date: '2026-10-22' }, files: [], now: NOW });
  const moveAcc = await svc.decide({ user: manager, id: String(move._id), accept: true, confirmFar: true, now: NOW });
  eq(moveAcc.applied.moved, 1, 'העברת יום אושרה — השיבוץ עבר ליום החדש');
  eq((await entriesNow()).filter(e => e[1] === '2026-10-22').length, 1, 'השיבוץ יושב על 22.10');

  const partial = await svc.createConstraint({ employee: dana, body: { type: 'partial', date: '2026-10-22', from_hhmm: '14:00', to_hhmm: '16:00', details: 'רופא' }, files: [], now: NOW });
  const partialAcc = await svc.decide({ user: manager, id: String(partial._id), accept: true, confirmFar: true, now: NOW });
  eq(partialAcc.applied.trimmed, 1, 'היעדרות זמנית בסוף היום — השיבוץ קוצר');
  eq((await entriesNow()).find(e => e[1] === '2026-10-22')[2], '07:00-14:00', 'השעות נחתכו לשעת תחילת ההיעדרות');

  const swapApply = await svc.createConstraint({ employee: dana, body: { type: 'swap', swap_mode: 'handover', date: '2026-10-19', colleague_id: String(ruth._id) }, files: [], now: NOW });
  await svc.respondColleague({ employee: ruth, id: String(swapApply._id), accept: true, now: NOW });
  const swapAcc = await svc.decide({ user: manager, id: String(swapApply._id), accept: true, confirmFar: true, now: NOW });
  eq(swapAcc.applied.reassigned, 1, 'מסירת משמרת אושרה — השיבוץ עבר למחליפה');
  eq((await entriesNow()).find(e => e[1] === '2026-10-19')[0], 'רות', 'ובסידור 19.10 רשום על רות');

  await new Promise(r => setTimeout(r, 300));
  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
