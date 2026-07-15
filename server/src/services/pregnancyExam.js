/**
 * Pregnancy medical-exam hours (§7 חוק עבודת נשים) — balance computation.
 *
 * DISPLAY / ALERT ONLY. This never writes to payroll or computes salary; it
 * only tells the UI how many of the statutory exam-hours an employee has left,
 * so the accountant/manager can see it. The actual hour draws are stored as
 * `EmployeeRequest` docs with `type: 'pregnancy_exam'` and an `exam_hours`
 * value, approved through the normal manager→accountant chain.
 *
 * Entitlement (per pregnancy, resets with a new pregnancy):
 *   - full work-week & >4h/day  → 40h
 *   - full work-week & ≤4h/day  → 20h
 * Part-time proration is genuinely ambiguous in the statute, so it is a
 * configurable Setting `pregnancy_exam_proration_mode`:
 *   - 'linear'    (default) → 40 × FTE, rounded to the nearest 0.5h. Common
 *                  payroll convention, generally more generous / safer.
 *   - 'statutory' → the literal two-tier rule (40 if avg >4h/day else 20).
 * FTE = the employee's committed weekly hours ÷ a full-time week
 * (Setting `full_time_weekly_hours`, default 42).
 */
const { EmployeeRequest, EmployeeCommitment, Setting } = require('../models');

const DEFAULT_FULL_TIME_WEEKLY = 42;

async function getSetting(key, fallback) {
  const doc = await Setting.findOne({ key }).lean();
  return doc && doc.value != null ? doc.value : fallback;
}

/** Minutes between two "HH:mm" strings; 0 if either is missing/invalid. */
function hhmmSpanHours(start, end) {
  const p = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const a = p(start), b = p(end);
  if (a == null || b == null || b <= a) return 0;
  return (b - a) / 60;
}

/** Weekly committed hours + working-day count from an EmployeeCommitment doc. */
function weeklyHoursFromCommitment(commitment) {
  if (!commitment || !Array.isArray(commitment.days)) return { weeklyHours: 0, workDays: 0 };
  let weeklyHours = 0, workDays = 0;
  for (const d of commitment.days) {
    if (d.is_off) continue;
    const h = hhmmSpanHours(d.start_hhmm, d.end_hhmm);
    if (h > 0) { weeklyHours += h; workDays += 1; }
  }
  return { weeklyHours: Math.round(weeklyHours * 100) / 100, workDays };
}

function round2(n) { return Math.round(n * 100) / 100; }
function roundHalf(n) { return Math.round(n * 2) / 2; }

/**
 * Compute the exam-hours entitlement for one employee.
 * Returns { entitlement, fte, weekly_hours, avg_hours_per_day, mode, has_commitment }.
 */
async function computeEntitlement(employeeId) {
  const mode = await getSetting('pregnancy_exam_proration_mode', 'linear');
  const fullTimeWeekly = Number(await getSetting('full_time_weekly_hours', DEFAULT_FULL_TIME_WEEKLY)) || DEFAULT_FULL_TIME_WEEKLY;
  const commitment = await EmployeeCommitment.findOne({ employee_id: employeeId }).lean();
  const { weeklyHours, workDays } = weeklyHoursFromCommitment(commitment);
  const hasCommitment = weeklyHours > 0;

  // No commitment on file → assume full-time entitlement (40h) rather than
  // silently zeroing it; the manager can still see and adjust.
  const fte = hasCommitment ? Math.min(weeklyHours / fullTimeWeekly, 1) : 1;
  const avgPerDay = hasCommitment && workDays > 0 ? weeklyHours / workDays : null;

  let entitlement;
  if (!hasCommitment) {
    entitlement = 40;
  } else if (mode === 'statutory') {
    entitlement = (avgPerDay != null && avgPerDay > 4) ? 40 : 20;
  } else {
    entitlement = roundHalf(40 * fte);
  }
  return {
    entitlement,
    fte: round2(fte),
    weekly_hours: weeklyHours,
    avg_hours_per_day: avgPerDay != null ? round2(avgPerDay) : null,
    mode: mode === 'statutory' ? 'statutory' : 'linear',
    has_commitment: hasCommitment,
  };
}

/**
 * The current-pregnancy date window used to sum exam hours. The 40h pool resets
 * per pregnancy, so we count only exams within ~300 days before the due date
 * (a full gestation) through 60 days after. Without a due date we count all
 * approved pregnancy_exam requests (best effort).
 */
function pregnancyWindow(dueDate) {
  if (!dueDate) return null;
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return null;
  const from = new Date(due); from.setDate(from.getDate() - 300);
  const to = new Date(due); to.setDate(to.getDate() + 60);
  const ymd = (d) => d.toISOString().slice(0, 10);
  return { from: ymd(from), to: ymd(to) };
}

/**
 * Full balance for one employee: entitlement, hours used (approved), and hours
 * still pending approval. `dueDate` scopes the count to the current pregnancy.
 */
async function computeBalance(employee) {
  const empId = employee._id || employee.id;
  const ent = await computeEntitlement(empId);
  const win = pregnancyWindow(employee.due_date);

  const ownerMatch = employee.user_id
    ? { $or: [{ employee_id: empId }, { user_id: employee.user_id }] }
    : { employee_id: empId };
  const base = { ...ownerMatch, type: 'pregnancy_exam' };
  if (win) base.from_date = { $gte: win.from, $lte: win.to };

  const requests = await EmployeeRequest.find(base).sort({ from_date: 1 }).lean();
  const sumHours = (rs) => rs.reduce((s, r) => s + (Number(r.exam_hours) || 0), 0);
  const approved = requests.filter(r => r.status === 'approved');
  const pending = requests.filter(r => ['pending', 'pending_manager', 'pending_accountant'].includes(r.status));

  const used = round2(sumHours(approved));
  const pendingHours = round2(sumHours(pending));
  return {
    entitlement: ent.entitlement,
    used,
    pending_hours: pendingHours,
    remaining: round2(Math.max(ent.entitlement - used, 0)),
    over_cap: used > ent.entitlement,
    proration: ent,
    window: win,
    requests: requests.map(r => ({
      id: String(r._id),
      date: r.from_date,
      hours: Number(r.exam_hours) || 0,
      status: r.status,
      reason: r.reason || '',
      has_file: !!r.medical_file_data,
      file_name: r.medical_file_name || '',
    })),
  };
}

module.exports = { computeEntitlement, computeBalance };
