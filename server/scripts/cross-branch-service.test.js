#!/usr/bin/env node
/**
 * Rate requests and cross-branch placements against an in-memory database.
 *
 *   node scripts/cross-branch-service.test.js
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
  const rates = require('../src/services/shifts/rateRequests.service');
  const cross = require('../src/services/shifts/crossBranch.service');

  const home = await M.Branch.create({ name: 'כפר סבא - קפלן' });
  const host = await M.Branch.create({ name: 'כפר סבא - משה דיין' });
  let idn = 300000000;
  const mkUser = (role, extra = {}) => M.User.create({ full_name: role, id_number: String(idn++), email: `${idn}@x.l`, password_hash: 'x', role, is_active: true, ...extra });
  const homeMgrU = await mkUser('branch_manager', { managed_branch_ids: [home._id], branch_id: home._id });
  const hostMgrU = await mkUser('branch_manager', { managed_branch_ids: [host._id], branch_id: host._id });
  const accU = await mkUser('accountant');
  const as = (u) => ({ id: String(u._id), role: u.role, managed_branch_ids: (u.managed_branch_ids || []).map(String), branch_id: u.branch_id ? String(u.branch_id) : null, full_name: u.full_name });
  const homeMgr = as(homeMgrU); const hostMgr = as(hostMgrU); const acc = as(accU);
  const dana = await M.Employee.create({ full_name: 'דנה', israeli_id: String(idn++), branch_id: home._id, is_active: true });

  console.log('\nבקשת תעריף');
  await throws(() => rates.createRateRequest({ user: homeMgr, employeeId: String(dana._id), hostBranchId: String(host._id), proposedRate: 50 }), 403, 'רק מנהלת הסניף המארח מבקשת תעריף', 'רק המארחת מבקשת');
  const rr = await rates.createRateRequest({ user: hostMgr, employeeId: String(dana._id), hostBranchId: String(host._id), proposedRate: 50 });
  eq(rr.status, 'pending_home', 'ממתין למנהלת סניף הבית');
  eq(await M.NotificationEvent.countDocuments({ type: 'rate_request', recipient_id: homeMgrU._id }), 1, 'מנהלת הבית קיבלה התראה');
  await throws(() => rates.createRateRequest({ user: hostMgr, employeeId: String(dana._id), hostBranchId: String(host._id), proposedRate: 50 }), 409, 'כבר יש בקשת תעריף פתוחה לעובדת הזו', 'בקשה כפולה');
  await throws(() => rates.decideRateRequest({ user: hostMgr, id: String(rr._id), approve: true }), 403, 'אין הרשאה להחליט בשלב הזה', 'המארחת לא מאשרת שלב בית');
  await throws(() => rates.decideRateRequest({ user: homeMgr, id: String(rr._id), approve: false, reason: '' }), 400, 'יש לכתוב סיבה לדחייה', 'דחייה בלי סיבה');
  const step2 = await rates.decideRateRequest({ user: homeMgr, id: String(rr._id), approve: true });
  eq(step2.status, 'pending_office', 'עבר למשרד');
  const list = await rates.listRateRequests({ user: acc });
  eq(list.map(r => [r.employee_name, r.can_decide]), [['דנה', true]], 'המשרד רואה את הבקשה ויכול להחליט');
  await throws(() => rates.decideRateRequest({ user: acc, id: String(rr._id), approve: true, finalRate: 0 }), 400, 'יש להזין תעריף לשעה', 'תעריף אפס');
  const done = await rates.decideRateRequest({ user: acc, id: String(rr._id), approve: true, finalRate: 48 });
  eq(done.status, 'approved', 'אושר');
  const d2 = await M.Employee.findById(dana._id).lean();
  eq(d2.branch_rates.map(r => [String(r.branch_id), r.hourly_rate]), [[String(host._id), 48]], 'התעריף נכתב לכרטיס העובדת');
  eq(await M.NotificationEvent.countDocuments({ type: 'rate_request_decision', recipient_id: hostMgrU._id }), 1, 'המבקשת עודכנה');
  eq((await rates.listRateRequests({ user: acc })).length, 0, 'אחרי אישור — יורדת מהרשימה');

  console.log('\nמועמדות מסניפים אחרים');
  const cands = await cross.foreignCandidates({ hostBranchId: String(host._id) });
  eq(cands.map(c => [c.full_name, c.has_rate, c.branch_name]), [['דנה', true, 'כפר סבא - קפלן']], 'דנה עם תעריף');

  console.log('\nשיבוץ מסניף אחר ואישור');
  const ShiftWeek = M.ShiftWeek;
  const mkWeek = (ws, entries, published = true) => ShiftWeek.create({ branch_id: host._id, week_start: ws, entries, published: published ? entries : [], published_at: published ? new Date() : null });
  const entry = (date) => ({ employee_id: dana._id, employee_name: 'דנה', date, area: 'floater', start_hhmm: '13:00', end_hhmm: '17:00', cross_branch: true, cross_status: 'approved' });
  await mkWeek('2026-09-27', [entry('2026-09-28')]);
  await mkWeek('2026-10-04', [entry('2026-10-05')]);
  const w3 = await mkWeek('2026-10-11', [{ ...entry('2026-10-12'), cross_status: 'pending' }], false);
  const pendingForHome = await cross.homePending({ branchId: String(home._id) });
  eq(pendingForHome.map(p => [p.date, p.branch_name]), [['2026-10-12', 'כפר סבא - משה דיין']], 'מנהלת הבית רואה מה ממתין לה');
  await throws(() => cross.decidePlacement({ user: hostMgr, weekId: String(w3._id), entryId: String(w3.entries[0]._id), approve: true }), 403, 'רק מנהלת סניף הבית של העובדת מאשרת', 'המארחת לא מאשרת');
  await cross.decidePlacement({ user: homeMgr, weekId: String(w3._id), entryId: String(w3.entries[0]._id), approve: true });
  eq((await ShiftWeek.findById(w3._id)).entries[0].cross_status, 'approved', 'אושר');
  eq(await M.NotificationEvent.countDocuments({ type: 'cross_placement_decision', recipient_id: hostMgrU._id, ref_id: w3._id }), 1, 'המארחת קיבלה הודעת אישור');
  const arr = await M.CrossBranchArrangement.findOne({ employee_id: dana._id }).lean();
  eq([arr && arr.status, arr && arr.weekday, arr && arr.start_hhmm], ['proposed', 1, '13:00'], 'אחרי שלוש פעמים — הוצע סידור קבוע');
  eq(await M.NotificationEvent.countDocuments({ type: 'cross_arrangement' }), 2, 'שתי המנהלות נשאלו');
  await cross.confirmArrangement({ user: hostMgr, id: String(arr._id) });
  eq((await M.CrossBranchArrangement.findById(arr._id)).status, 'proposed', 'אחרי אישור אחת — עדיין מוצע');
  await cross.confirmArrangement({ user: homeMgr, id: String(arr._id) });
  eq((await M.CrossBranchArrangement.findById(arr._id)).status, 'active', 'שתיהן אישרו — פעיל');
  const act = await cross.activeArrangements({ hostBranchId: String(host._id), employeeIds: [String(dana._id)] });
  eq(act.length, 1, 'סידור פעיל זמין לשיבוץ אוטומטי');
  await cross.cancelArrangement({ user: homeMgr, id: String(arr._id) });
  eq((await M.CrossBranchArrangement.findById(arr._id)).status, 'cancelled', 'כל אחת מבטלת לבד');

  console.log('\nדחיית שיבוץ');
  const w4 = await mkWeek('2026-10-18', [{ ...entry('2026-10-20'), cross_status: 'pending' }], false);
  await throws(() => cross.decidePlacement({ user: homeMgr, weekId: String(w4._id), entryId: String(w4.entries[0]._id), approve: false, reason: '' }), 400, 'יש לכתוב סיבה לדחייה', 'דחייה בלי סיבה');
  await cross.decidePlacement({ user: homeMgr, weekId: String(w4._id), entryId: String(w4.entries[0]._id), approve: false, reason: 'צריכה אותה אצלי' });
  eq((await ShiftWeek.findById(w4._id)).entries.length, 0, 'השיבוץ הוסר מהסידור המארח');
  eq(await M.NotificationEvent.countDocuments({ type: 'cross_placement_decision', recipient_id: hostMgrU._id, ref_id: w4._id }), 1, 'המארחת עודכנה עם הסיבה');

  console.log('\nשיבוצים בסניפים אחרים');
  const others = await cross.otherBranchEntries({ weekStart: '2026-10-11', employeeIds: [String(dana._id)], excludeBranchId: String(home._id) });
  eq(others.map(o => [o.date, o.branch_name, o.cross_status]), [['2026-10-12', 'כפר סבא - משה דיין', 'approved']], 'מנהלת הבית רואה את דנה במשה דיין');

  await new Promise(r => setTimeout(r, 300));
  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
