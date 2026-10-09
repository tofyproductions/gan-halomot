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
  // F4: the clock sync is stubbed — record the call, then fail, to prove it never reaches the request.
  const syncCalls = [];
  const fpPath = require.resolve('../src/services/fingerprintSync');
  require.cache[fpPath] = { id: fpPath, filename: fpPath, loaded: true, children: [], paths: [], exports: { syncEmployee: async (id, opts) => { syncCalls.push([String(id), opts && opts.createdBy]); throw new Error('no clock in tests'); } } };
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

  console.log('\nבקשת תעריף — עובדת בלי תעריף שעתי רגיל: המשרד קובע');
  await throws(() => rates.createRateRequest({ user: homeMgr, employeeId: String(dana._id), hostBranchId: String(host._id), proposedRate: 50 }), 403, 'רק מנהלת הסניף המארח מבקשת תעריף', 'רק המארחת מבקשת');
  const rr = await rates.createRateRequest({ user: hostMgr, employeeId: String(dana._id), hostBranchId: String(host._id), proposedRate: 50 });
  eq(rr.status, 'pending_office', 'בלי תעריף רגיל — ישר להנהלת חשבונות');
  eq(await M.NotificationEvent.countDocuments({ type: 'rate_request', recipient_id: homeMgrU._id }), 0, 'מנהלת הבית לא נשאלת על הכסף');
  eq(await M.NotificationEvent.countDocuments({ type: 'rate_request', recipient_id: accU._id }), 1, 'המשרד קיבל את הבקשה');
  await throws(() => rates.createRateRequest({ user: hostMgr, employeeId: String(dana._id), hostBranchId: String(host._id), proposedRate: 50 }), 409, 'כבר יש בקשת תעריף פתוחה לעובדת הזו', 'בקשה כפולה');
  await throws(() => rates.decideRateRequest({ user: hostMgr, id: String(rr._id), approve: true }), 403, 'אין הרשאה להחליט בשלב הזה', 'המארחת לא מאשרת שלב משרד');
  await throws(() => rates.decideRateRequest({ user: acc, id: String(rr._id), approve: false, reason: '' }), 400, 'יש לכתוב סיבה לדחייה', 'דחייה בלי סיבה');
  const list = await rates.listRateRequests({ user: acc });
  eq(list.map(r => [r.employee_name, r.can_decide]), [['דנה', true]], 'המשרד רואה את הבקשה ויכול להחליט');
  await throws(() => rates.decideRateRequest({ user: acc, id: String(rr._id), approve: true, finalRate: 0 }), 400, 'יש להזין תעריף לשעה', 'תעריף אפס');
  const done = await rates.decideRateRequest({ user: acc, id: String(rr._id), approve: true, finalRate: 48 });
  eq(done.status, 'approved', 'אושר');
  const d2 = await M.Employee.findById(dana._id).lean();
  eq(d2.branch_rates.map(r => [String(r.branch_id), r.hourly_rate]), [[String(host._id), 48]], 'התעריף נכתב לכרטיס העובדת');
  eq(syncCalls, [[String(dana._id), acc.id]], 'F4: אחרי קביעת התעריף — סנכרון טביעת אצבע לשעונים (כשל לא מפיל את הבקשה)');
  eq(await M.NotificationEvent.countDocuments({ type: 'rate_request_decision', recipient_id: hostMgrU._id }), 1, 'המבקשת עודכנה');
  eq((await rates.listRateRequests({ user: acc })).length, 0, 'אחרי אישור — יורדת מהרשימה');

  console.log('\nתעריף רגיל — מועתק מיד, בלי לשאול אף אחד');
  const rina = await M.Employee.create({ full_name: 'רינה', israeli_id: String(idn++), branch_id: home._id, is_active: true, salary_type: 'hourly', amuta_distribution: [{ amuta_id: new mongoose.Types.ObjectId(), hourly_rate: 45 }] });
  const auto = await rates.createRateRequest({ user: hostMgr, employeeId: String(rina._id), hostBranchId: String(host._id), proposedRate: null });
  eq(auto.status, 'approved', 'בלי שינוי — מאושר מיד');
  eq(auto.final_rate, 45, 'התעריף הרגיל שלה');
  const r2 = await M.Employee.findById(rina._id).lean();
  eq(r2.branch_rates.map(r => [String(r.branch_id), r.hourly_rate]), [[String(host._id), 45]], 'הועתק לכרטיס');
  eq(syncCalls.length, 2, 'סנכרון שעון גם במסלול המיידי');
  eq(await M.NotificationEvent.countDocuments({ type: 'rate_request', recipient_id: accU._id }), 1, 'המשרד לא קיבל בקשה נוספת');

  console.log('\nתעריף שונה מהרגיל — אישור הנהלת חשבונות');
  const gila = await M.Employee.create({ full_name: 'גילה', israeli_id: String(idn++), branch_id: home._id, is_active: true, salary_type: 'hourly', amuta_distribution: [{ amuta_id: new mongoose.Types.ObjectId(), hourly_rate: 45 }] });
  const diff = await rates.createRateRequest({ user: hostMgr, employeeId: String(gila._id), hostBranchId: String(host._id), proposedRate: 52 });
  eq(diff.status, 'pending_office', 'שינוי תעריף — ממתין למשרד');
  const g1 = await M.Employee.findById(gila._id).lean();
  eq((g1.branch_rates || []).length, 0, 'התעריף החדש לא בתוקף לפני אישור');
  await rates.decideRateRequest({ user: acc, id: String(diff._id), approve: true, finalRate: 52 });
  const g2 = await M.Employee.findById(gila._id).lean();
  eq(g2.branch_rates.map(r => [String(r.branch_id), r.hourly_rate]), [[String(host._id), 52]], 'אחרי אישור — נכנס לתוקף');

  console.log('\nמועמדות מסניפים אחרים');
  const cands = await cross.foreignCandidates({ hostBranchId: String(host._id) });
  eq(cands.filter(c => c.full_name === 'דנה').map(c => [c.full_name, c.has_rate, c.branch_name]), [['דנה', true, 'כפר סבא - קפלן']], 'דנה עם תעריף');
  eq(cands.filter(c => c.full_name === 'רינה').map(c => [c.has_rate, c.home_hourly_rate]), [[true, 45]], 'רינה — תעריף הועתק ותעריף רגיל מדווח');

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

  console.log('\nסקירה סופית');
  // M5: a placement / rate request / arrangement of an employee who no longer exists — 404 before any write.
  const ghost = new mongoose.Types.ObjectId();
  const ghostReq = await M.BranchRateRequest.create({ employee_id: ghost, home_branch_id: home._id, host_branch_id: host._id, proposed_rate: 40, requested_by: hostMgrU._id, status: 'pending_office' });
  await throws(() => rates.decideRateRequest({ user: acc, id: String(ghostReq._id), approve: true, finalRate: 40 }), 404, 'עובדת לא נמצאה', 'M5: שלב המשרד — עובדת שנמחקה');
  eq((await M.BranchRateRequest.findById(ghostReq._id)).status, 'pending_office', 'M5: הבקשה לא השתנתה');
  const wGhost = await mkWeek('2026-11-29', [{ ...entry('2026-11-30'), employee_id: ghost, cross_status: 'pending' }], false);
  await throws(() => cross.decidePlacement({ user: homeMgr, weekId: String(wGhost._id), entryId: String(wGhost.entries[0]._id), approve: true }), 404, 'עובדת לא נמצאה', 'M5: אישור שיבוץ — עובדת שנמחקה');
  await mkWeek('2026-11-15', [{ ...entry('2026-11-16'), employee_id: ghost }]);
  await mkWeek('2026-11-22', [{ ...entry('2026-11-23'), employee_id: ghost }]);
  await throws(() => cross.maybeProposeArrangement({ week: wGhost.toObject(), entry: { ...entry('2026-11-30'), employee_id: ghost } }), 404, 'עובדת לא נמצאה', 'M5: הצעת סידור קבוע — עובדת שנמחקה');
  eq(await M.CrossBranchArrangement.countDocuments({ employee_id: ghost }), 0, 'M5: לא נוצר סידור קבוע');

  // M6: a slot cancelled in the last 28 days is not proposed again.
  await mkWeek('2026-12-06', [entry('2026-12-07')]);
  await mkWeek('2026-12-13', [entry('2026-12-14')]);
  const w6 = await mkWeek('2026-12-20', [{ ...entry('2026-12-21'), cross_status: 'pending' }], false);
  await cross.decidePlacement({ user: homeMgr, weekId: String(w6._id), entryId: String(w6.entries[0]._id), approve: true });
  eq(await M.CrossBranchArrangement.countDocuments({ employee_id: dana._id, status: 'proposed' }), 0, 'M6: בוטל לאחרונה — לא מוצע שוב');
  await M.CrossBranchArrangement.collection.updateOne({ _id: arr._id }, { $set: { updated_at: new Date(Date.now() - 40 * 864e5) } });
  const again6 = await cross.maybeProposeArrangement({ week: (await ShiftWeek.findById(w6._id)).toObject(), entry: entry('2026-12-21') });
  eq(again6 && again6.status, 'proposed', 'M6: ביטול ישן (מעל 28 יום) — מוצע שוב');
  // M8: the approval did not touch the week's version.
  const w6doc = await ShiftWeek.findById(w6._id).lean();
  eq([w6doc.entries[0].cross_status, new Date(w6doc.updated_at).getTime()], ['approved', new Date(w6.updated_at).getTime()], 'M8: אישור שיבוץ לא משנה את גרסת הסידור');

  // M7: both managers confirming at once still activates.
  const arr7 = await M.CrossBranchArrangement.create({ employee_id: dana._id, employee_name: 'דנה', home_branch_id: home._id, host_branch_id: host._id, weekday: 3, start_hhmm: '08:00', end_hhmm: '10:00' });
  await Promise.all([cross.confirmArrangement({ user: hostMgr, id: String(arr7._id) }), cross.confirmArrangement({ user: homeMgr, id: String(arr7._id) })]);
  eq((await M.CrossBranchArrangement.findById(arr7._id)).status, 'active', 'M7: אישור בו־זמני של שתיהן — פעיל');

  console.log('\nשיבוצים בסניפים אחרים');
  const others = await cross.otherBranchEntries({ weekStart: '2026-10-11', employeeIds: [String(dana._id)], excludeBranchId: String(home._id) });
  eq(others.map(o => [o.date, o.branch_name, o.cross_status]), [['2026-10-12', 'כפר סבא - משה דיין', 'approved']], 'מנהלת הבית רואה את דנה במשה דיין');

  await new Promise(r => setTimeout(r, 300));
  await mongoose.disconnect();
  await mongod.stop();
  console.log(failures ? `\n${failures} FAILED` : '\nכל הבדיקות עברו');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
