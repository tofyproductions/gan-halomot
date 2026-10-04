/**
 * Placements of employees in branches that are not theirs: who may be
 * placed, what her own manager must approve, and the permanent arrangements
 * that end the weekly asking.
 */
const mongoose = require('mongoose');
const { ShiftWeek, Employee, Branch, User, CrossBranchArrangement } = require('../../models');
const notificationService = require('../notification.service');
const { branchManagerFilter } = require('../branch-recipients.service');
const { weekdayOf } = require('../fixedSchedule');
const { ShiftError, canEdit } = require('./access');
const { hasBranchRate } = require('./crossRules');

const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function managersOf(branchId) {
  return (await User.find({ ...branchManagerFilter(branchId), role: 'branch_manager' }).select('_id').lean()).map(u => u._id);
}
const notify = (ids, payload) => Promise.all(ids.map(recipient_id => notificationService.notifyOnce({ ...payload, recipient_id })
  .catch(err => console.error('[cross-branch] notify failed:', err.message))));
async function branchNames(ids) {
  return new Map((await Branch.find({ _id: { $in: ids } }).select('name').lean()).map(b => [String(b._id), b.name]));
}

async function foreignCandidates({ hostBranchId }) {
  const emps = await Employee.find({ is_active: true, branch_id: { $ne: hostBranchId } }).select('full_name branch_id branch_rates').sort({ full_name: 1 }).lean();
  const names = await branchNames([...new Set(emps.map(e => String(e.branch_id)))]);
  return emps.map(e => ({ _id: String(e._id), full_name: e.full_name, branch_id: String(e.branch_id), branch_name: names.get(String(e.branch_id)) || '', has_rate: hasBranchRate(e, hostBranchId) }));
}

async function activeArrangements({ hostBranchId, employeeIds }) {
  return CrossBranchArrangement.find({ host_branch_id: hostBranchId, employee_id: { $in: employeeIds }, status: 'active' }).lean();
}

/** Her entries in every other branch's week — for overlap checks and the home manager's view. */
async function otherBranchEntries({ weekStart, employeeIds, excludeBranchId }) {
  if (!employeeIds.length) return [];
  const weeks = await ShiftWeek.find({ week_start: weekStart, branch_id: { $ne: excludeBranchId }, 'entries.employee_id': { $in: employeeIds } }).lean();
  const names = await branchNames(weeks.map(w => w.branch_id));
  const ids = new Set(employeeIds.map(String));
  return weeks.flatMap(w => w.entries.filter(e => ids.has(String(e.employee_id))).map(e => ({
    ...e, _id: String(e._id), employee_id: String(e.employee_id), branch_id: String(w.branch_id), branch_name: names.get(String(w.branch_id)) || '', week_id: String(w._id),
  })));
}

async function homePending({ branchId }) {
  const mine = (await Employee.find({ branch_id: branchId }).select('_id').lean()).map(e => e._id);
  const weeks = await ShiftWeek.find({ branch_id: { $ne: branchId }, entries: { $elemMatch: { employee_id: { $in: mine }, cross_status: 'pending' } } }).lean();
  const names = await branchNames(weeks.map(w => w.branch_id));
  const set = new Set(mine.map(String));
  return weeks.flatMap(w => w.entries.filter(e => set.has(String(e.employee_id)) && e.cross_status === 'pending').map(e => ({
    ...e, _id: String(e._id), week_id: String(w._id), branch_id: String(w.branch_id), branch_name: names.get(String(w.branch_id)) || '',
  })));
}

/** Two earlier consecutive host weeks with the same approved placement → propose a permanent arrangement. */
async function maybeProposeArrangement({ week, entry }) {
  const weekday = weekdayOf(entry.date);
  const exists = await CrossBranchArrangement.exists({ employee_id: entry.employee_id, host_branch_id: week.branch_id, weekday, start_hhmm: entry.start_hhmm, end_hhmm: entry.end_hhmm, status: { $in: ['proposed', 'active'] } });
  if (exists) return null;
  for (const back of [7, 14]) {
    const date = addDays(entry.date, -back);
    const prev = await ShiftWeek.findOne({ branch_id: week.branch_id, week_start: addDays(week.week_start, -back) }).lean();
    const hit = prev && (prev.published || []).some(e => String(e.employee_id) === String(entry.employee_id) && e.date === date
      && e.start_hhmm === entry.start_hhmm && e.end_hhmm === entry.end_hhmm && e.cross_status === 'approved');
    if (!hit) return null;
  }
  const emp = await Employee.findById(entry.employee_id).select('full_name branch_id').lean();
  const arr = await CrossBranchArrangement.create({
    employee_id: entry.employee_id, employee_name: emp ? emp.full_name : '', home_branch_id: emp.branch_id, host_branch_id: week.branch_id,
    weekday, start_hhmm: entry.start_hhmm, end_hhmm: entry.end_hhmm,
  });
  const ids = [...await managersOf(week.branch_id), ...await managersOf(emp.branch_id)];
  await notify(ids, {
    type: 'cross_arrangement', ref_collection: 'CrossBranchArrangement', ref_id: arr._id,
    title: `${arr.employee_name} — סידור קבוע?`, body: `שובצה 3 שבועות ברצף באותו יום ובאותן שעות (${arr.start_hhmm}–${arr.end_hhmm}). לאשר כסידור קבוע?`, url: '/shifts',
  });
  return arr;
}

async function decidePlacement({ user, weekId, entryId, approve, reason }) {
  if (!mongoose.isValidObjectId(weekId)) throw new ShiftError(404, 'סידור לא נמצא');
  const week = await ShiftWeek.findById(weekId);
  if (!week) throw new ShiftError(404, 'סידור לא נמצא');
  const entry = week.entries.id(entryId);
  if (!entry || !entry.cross_branch) throw new ShiftError(404, 'שיבוץ לא נמצא');
  const emp = await Employee.findById(entry.employee_id).select('full_name branch_id').lean();
  if (!emp || !canEdit(user, emp.branch_id)) throw new ShiftError(403, 'רק מנהלת סניף הבית של העובדת מאשרת');
  if (entry.cross_status !== 'pending') throw new ShiftError(409, 'השיבוץ כבר טופל');
  if (!approve) {
    const why = String(reason || '').trim();
    if (!why) throw new ShiftError(400, 'יש לכתוב סיבה לדחייה');
    entry.deleteOne();
    await week.save();
    await notify(await managersOf(week.branch_id), {
      type: 'cross_placement_decision', ref_collection: 'ShiftWeek', ref_id: week._id,
      title: `השיבוץ של ${emp.full_name} ב-${entry.date} לא אושר`, body: why, url: `/shifts?week=${week.week_start}`,
    });
    return { approved: false };
  }
  entry.cross_status = 'approved';
  await week.save();
  await notify(await managersOf(week.branch_id), {
    type: 'cross_placement_decision', ref_collection: 'ShiftWeek', ref_id: week._id,
    title: `השיבוץ של ${emp.full_name} ב-${entry.date} אושר`, body: '', url: `/shifts?week=${week.week_start}`,
  });
  await maybeProposeArrangement({ week, entry: entry.toObject() });
  return { approved: true };
}

async function loadArr(id) {
  if (!mongoose.isValidObjectId(id)) throw new ShiftError(404, 'סידור קבוע לא נמצא');
  const a = await CrossBranchArrangement.findById(id);
  if (!a) throw new ShiftError(404, 'סידור קבוע לא נמצא');
  return a;
}

async function confirmArrangement({ user, id }) {
  const a = await loadArr(id);
  if (a.status !== 'proposed') throw new ShiftError(409, 'הסידור כבר לא ממתין לאישור');
  const isHost = canEdit(user, a.host_branch_id); const isHome = canEdit(user, a.home_branch_id);
  if (!isHost && !isHome) throw new ShiftError(403, 'רק אחת משתי המנהלות מאשרת');
  if (isHost) a.host_confirmed = true;
  if (isHome) a.home_confirmed = true;
  if (a.host_confirmed && a.home_confirmed) a.status = 'active';
  await a.save();
  return a;
}

async function cancelArrangement({ user, id }) {
  const a = await loadArr(id);
  if (a.status === 'cancelled') throw new ShiftError(409, 'הסידור כבר בוטל');
  if (!canEdit(user, a.host_branch_id) && !canEdit(user, a.home_branch_id)) throw new ShiftError(403, 'רק אחת משתי המנהלות מבטלת');
  a.status = 'cancelled'; a.cancelled_by = user.id;
  await a.save();
  const ids = [...await managersOf(a.host_branch_id), ...await managersOf(a.home_branch_id)];
  await notify(ids, {
    type: 'cross_arrangement', ref_collection: 'CrossBranchArrangement', ref_id: a._id,
    title: `הסידור הקבוע של ${a.employee_name} בוטל`, body: 'משבוע הבא כל שיבוץ שלה שוב דורש אישור', url: '/shifts',
  });
  return a;
}

async function arrangementsFor({ user, branchId }) {
  const list = await CrossBranchArrangement.find({ status: { $in: ['proposed', 'active'] }, $or: [{ host_branch_id: branchId }, { home_branch_id: branchId }] }).lean();
  const names = await branchNames(list.flatMap(a => [a.host_branch_id, a.home_branch_id]));
  return list.map(a => ({
    ...a, host_branch_name: names.get(String(a.host_branch_id)) || '', home_branch_name: names.get(String(a.home_branch_id)) || '',
    can_confirm: a.status === 'proposed' && ((canEdit(user, a.host_branch_id) && !a.host_confirmed) || (canEdit(user, a.home_branch_id) && !a.home_confirmed)),
    can_cancel: canEdit(user, a.host_branch_id) || canEdit(user, a.home_branch_id),
  }));
}

module.exports = {
  foreignCandidates, activeArrangements, otherBranchEntries, homePending, maybeProposeArrangement,
  decidePlacement, confirmArrangement, cancelArrangement, arrangementsFor, managersOf,
};
