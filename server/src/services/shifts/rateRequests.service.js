/**
 * Branch-rate requests: host asks, home manager agrees, office sets the money.
 */
const mongoose = require('mongoose');
const { BranchRateRequest, Employee, Branch, User } = require('../../models');
const notificationService = require('../notification.service');
const { branchManagerFilter } = require('../branch-recipients.service');
const { ShiftError, canEdit } = require('./access');

const OFFICE = ['system_admin', 'accountant'];

async function managersOf(branchId) {
  return (await User.find({ ...branchManagerFilter(branchId), role: 'branch_manager' }).select('_id').lean()).map(u => u._id);
}
async function officeIds() {
  return (await User.find({ role: { $in: OFFICE }, is_active: { $ne: false } }).select('_id').lean()).map(u => u._id);
}
const notify = (ids, payload) => Promise.all(ids.map(recipient_id => notificationService.notifyOnce({ ...payload, recipient_id })
  .catch(err => console.error('[rate-requests] notify failed:', err.message))));

async function loadOr404(id) {
  if (!mongoose.isValidObjectId(id)) throw new ShiftError(404, 'בקשה לא נמצאה');
  const r = await BranchRateRequest.findById(id);
  if (!r) throw new ShiftError(404, 'בקשה לא נמצאה');
  return r;
}

async function createRateRequest({ user, employeeId, hostBranchId, proposedRate }) {
  if (!canEdit(user, hostBranchId)) throw new ShiftError(403, 'רק מנהלת הסניף המארח מבקשת תעריף');
  if (!mongoose.isValidObjectId(employeeId)) throw new ShiftError(404, 'עובדת לא נמצאה');
  const emp = await Employee.findOne({ _id: employeeId, is_active: true });
  if (!emp) throw new ShiftError(404, 'עובדת לא נמצאה');
  if (String(emp.branch_id) === String(hostBranchId)) throw new ShiftError(400, 'העובדת כבר שייכת לסניף הזה');
  if (await BranchRateRequest.exists({ employee_id: emp._id, host_branch_id: hostBranchId, status: { $in: ['pending_home', 'pending_office'] } })) {
    throw new ShiftError(409, 'כבר יש בקשת תעריף פתוחה לעובדת הזו');
  }
  const rate = Number(proposedRate);
  // Her "regular rate" is what PAYROLL would pay her this month — read from
  // the same place payroll reads it (amuta_distribution / terms_history),
  // not a card field nobody maintains.
  const thisMonth = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
  const homeRate = Number(require('../payrollCalc').primaryRates(emp, thisMonth).hourly_rate) || 0;

  /**
   * The default IS her rate. Most placements pay her at the host exactly
   * what home pays her — so that path asks nobody: the rate is copied to
   * the host row, the fingerprint syncs, she can be placed now, and an
   * approved request row remains as the audit trail. Only a DIFFERENT
   * figure is a decision, and that decision is accounting's: it goes
   * straight to the office (no home-manager stop — her manager's consent
   * to the placement itself is the cross-approval on the board), and the
   * new rate takes effect at the host only when the office approves.
   */
  if (homeRate > 0 && (!(rate > 0) || rate === homeRate)) {
    const rows = emp.branch_rates || [];
    const row = rows.find(x => String(x.branch_id) === String(hostBranchId));
    if (row) row.hourly_rate = homeRate; else rows.push({ branch_id: hostBranchId, hourly_rate: homeRate });
    emp.branch_rates = rows;
    await emp.save();
    try {
      require('../fingerprintSync').syncEmployee(emp._id, { createdBy: user.id })
        .catch(err => console.error('[rate-requests] fingerprint sync failed:', err.message));
    } catch (err) { console.error('[rate-requests] fingerprint sync failed:', err.message); }
    return BranchRateRequest.create({
      employee_id: emp._id, home_branch_id: emp.branch_id, host_branch_id: hostBranchId,
      proposed_rate: homeRate, final_rate: homeRate, status: 'approved',
      requested_by: user.id, requested_by_name: user.full_name || '',
    });
  }

  const r = await BranchRateRequest.create({
    employee_id: emp._id, home_branch_id: emp.branch_id, host_branch_id: hostBranchId,
    proposed_rate: rate > 0 ? rate : null, status: 'pending_office',
    requested_by: user.id, requested_by_name: user.full_name || '',
  });
  const hostName = (await Branch.findById(hostBranchId).select('name').lean())?.name || '';
  await notify(await officeIds(), {
    type: 'rate_request', ref_collection: 'BranchRateRequest', ref_id: r._id,
    title: `תעריף שונה מהרגיל — ${emp.full_name} ב${hostName}`,
    body: rate > 0
      ? `הוצע ${rate} ₪ לשעה${homeRate ? ` (התעריף הרגיל שלה: ${homeRate} ₪)` : ''}`
      : 'לעובדת אין תעריף שעתי רגיל — יש לקבוע תעריף',
    url: '/shifts',
  });
  return r;
}

async function decideRateRequest({ user, id, approve, reason, finalRate }) {
  const r = await loadOr404(id);
  let atHome = r.status === 'pending_home';
  let atOffice = r.status === 'pending_office';
  if (!atHome && !atOffice) throw new ShiftError(409, 'הבקשה כבר טופלה');
  /**
   * The office outranks the queue. Requests from before the flow changed
   * still sit at the home stage; an accountant or admin facing one should
   * finish it in a single act — she is the final authority on the money,
   * and the home manager's consent to the placement itself lives on the
   * board, not here.
   */
  if (atHome && OFFICE.includes(user.role)) { atHome = false; atOffice = true; }
  if ((atHome && !canEdit(user, r.home_branch_id)) || (atOffice && !OFFICE.includes(user.role))) throw new ShiftError(403, 'אין הרשאה להחליט בשלב הזה');
  const emp = await Employee.findById(r.employee_id);
  if (!approve) {
    const why = String(reason || '').trim();
    if (!why) throw new ShiftError(400, 'יש לכתוב סיבה לדחייה');
    r.status = 'rejected'; r.reject_reason = why.slice(0, 500);
    if (atHome) r.home_decided_by = user.id; else r.office_decided_by = user.id;
    await r.save();
    await notify([r.requested_by], {
      type: 'rate_request_decision', ref_collection: 'BranchRateRequest', ref_id: r._id,
      title: `בקשת התעריף ל${emp ? emp.full_name : 'עובדת'} נדחתה`, body: r.reject_reason, url: '/shifts',
    });
    return r;
  }
  if (atHome) {
    r.status = 'pending_office'; r.home_decided_by = user.id;
    await r.save();
    await notify(await officeIds(), {
      type: 'rate_request', ref_collection: 'BranchRateRequest', ref_id: r._id,
      title: `תעריף לסניף אחר — ${emp ? emp.full_name : ''}`, body: r.proposed_rate ? `הוצע ${r.proposed_rate} ₪ לשעה` : 'יש לקבוע תעריף לשעה', url: '/shifts',
    });
    return r;
  }
  if (!emp) throw new ShiftError(404, 'עובדת לא נמצאה');
  const rate = Number(finalRate ?? r.proposed_rate);
  if (!(rate > 0)) throw new ShiftError(400, 'יש להזין תעריף לשעה');
  const rows = emp.branch_rates || [];
  const row = rows.find(x => String(x.branch_id) === String(r.host_branch_id));
  if (row) row.hourly_rate = rate; else rows.push({ branch_id: r.host_branch_id, hourly_rate: rate });
  emp.branch_rates = rows;
  await emp.save();
  // She may now punch at the host branch: bring her fingerprint to its clock. Never fails the request.
  try {
    require('../fingerprintSync').syncEmployee(emp._id, { createdBy: user.id })
      .catch(err => console.error('[rate-requests] fingerprint sync failed:', err.message));
  } catch (err) { console.error('[rate-requests] fingerprint sync failed:', err.message); }
  r.status = 'approved'; r.final_rate = rate; r.office_decided_by = user.id;
  await r.save();
  await notify([r.requested_by], {
    type: 'rate_request_decision', ref_collection: 'BranchRateRequest', ref_id: r._id,
    title: `נקבע תעריף ל${emp.full_name}`, body: `${rate} ₪ לשעה — אפשר לשבץ אותה`, url: '/shifts',
  });
  return r;
}

async function listRateRequests({ user }) {
  const isOffice = OFFICE.includes(user.role);
  const managed = (user.managed_branch_ids && user.managed_branch_ids.length ? user.managed_branch_ids : [user.branch_id]).filter(Boolean).map(String);
  const filter = isOffice ? { status: { $in: ['pending_home', 'pending_office'] } }
    : { status: { $in: ['pending_home', 'pending_office'] }, $or: [{ home_branch_id: { $in: managed } }, { host_branch_id: { $in: managed } }] };
  const list = await BranchRateRequest.find(filter).sort({ created_at: -1 }).lean();
  const thisMonth = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
  const { primaryRates } = require('../payrollCalc');
  const emps = new Map((await Employee.find({ _id: { $in: list.map(r => r.employee_id) } }).select('full_name salary_type amuta_distribution terms_history').lean()).map(e => [String(e._id), e]));
  const branches = new Map((await Branch.find({ _id: { $in: list.flatMap(r => [r.home_branch_id, r.host_branch_id]) } }).select('name').lean()).map(b => [String(b._id), b.name]));
  return list.map(r => {
    const emp = emps.get(String(r.employee_id));
    return {
      ...r,
      employee_name: emp?.full_name || '',
      home_branch_name: branches.get(String(r.home_branch_id)) || '',
      host_branch_name: branches.get(String(r.host_branch_id)) || '',
      // Her regular rate — prefilled in the deciding field. Only for whoever
      // may actually SET the rate (the office): the host manager, who is
      // explicitly not allowed to decide, has no business holding the figure.
      home_hourly_rate: isOffice && emp ? (Number(primaryRates(emp, thisMonth).hourly_rate) || null) : null,
      // An office user may decide a request at EITHER stage (one act).
      can_decide: isOffice || (r.status === 'pending_home' && canEdit(user, r.home_branch_id)),
      can_set_rate: isOffice,
    };
  });
}

module.exports = { createRateRequest, decideRateRequest, listRateRequests };
