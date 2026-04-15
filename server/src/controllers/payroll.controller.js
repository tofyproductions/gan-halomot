/**
 * Payroll controller — CRUD for Employee (payroll), plus attendance / hours
 * aggregation from Punch records.
 *
 * This is separate from `employee.controller.js` which operates on the User
 * model (login accounts). A future cleanup could merge the two by linking
 * Employee.user_id, but for now they live in parallel.
 */
const { Employee, Punch, Branch, Amuta } = require('../models');

// --- helpers --------------------------------------------------------------

const IL_TZ = 'Asia/Jerusalem';

/** Format a Date as YYYY-MM-DD in the Israel timezone. */
function israelDateKey(date) {
  // en-CA produces YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: IL_TZ }).format(date);
}

/** Format a Date as HH:mm in the Israel timezone. */
function israelTimeHHMM(date) {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: IL_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

/** Parse a YYYY-MM string into { from: Date, to: Date } in Israel timezone. */
function monthRange(ym) {
  // We need the range covering the WHOLE calendar month in Israel time.
  // Easiest: construct a Date at the first of the month in UTC then shift.
  // Since timezone offset varies (DST), we use a safe approach: parse the
  // YYYY-MM, then use the 1st 00:00 local Israel time → convert to ISO via
  // subtracting the offset. Instead of that math, we use Date with explicit
  // components and trust that for "month boundaries" a 2-day buffer is safe:
  // we query a slightly wider window and filter afterwards by israelDateKey.
  const [y, m] = String(ym || '').split('-').map(Number);
  if (!y || !m) return null;
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - 3 * 3600 * 1000);
  // 2-day overflow on the end side
  const to = new Date(Date.UTC(y, m, 2, 0, 0, 0));
  return { from, to, year: y, month: m };
}

/**
 * Given a sorted array of punches for a single employee+day, pair them into
 * in/out sessions and compute total minutes. Odd punch count → the last punch
 * is unpaired and the day is flagged `incomplete: true`.
 *
 * We intentionally don't try to classify "in" vs "out" — the clock's state
 * code is unreliable on TANDEM4 PRO. We just chronologically pair: #1=in,
 * #2=out, #3=in, #4=out, etc.
 */
function summarizeDay(dayPunches) {
  const sorted = [...dayPunches].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const sessions = [];
  let totalMinutes = 0;
  for (let i = 0; i < sorted.length - 1; i += 2) {
    const inP = sorted[i];
    const outP = sorted[i + 1];
    const mins = Math.round((new Date(outP.timestamp) - new Date(inP.timestamp)) / 60000);
    sessions.push({
      in: inP.timestamp,
      out: outP.timestamp,
      in_hhmm: israelTimeHHMM(new Date(inP.timestamp)),
      out_hhmm: israelTimeHHMM(new Date(outP.timestamp)),
      minutes: mins,
    });
    totalMinutes += mins;
  }
  const incomplete = sorted.length % 2 === 1;
  let trailingPunch = null;
  if (incomplete) {
    const last = sorted[sorted.length - 1];
    trailingPunch = { timestamp: last.timestamp, hhmm: israelTimeHHMM(new Date(last.timestamp)) };
  }
  return {
    punch_count: sorted.length,
    sessions,
    trailing_punch: trailingPunch,
    incomplete,
    total_minutes: totalMinutes,
    total_hours: Math.round((totalMinutes / 60) * 100) / 100,
    first_in: sorted.length ? israelTimeHHMM(new Date(sorted[0].timestamp)) : null,
    last_out: sorted.length >= 2 && !incomplete
      ? israelTimeHHMM(new Date(sorted[sorted.length - 1].timestamp))
      : null,
  };
}

// --- Employee CRUD --------------------------------------------------------

async function listEmployees(req, res, next) {
  try {
    const { branch, active } = req.query;
    const filter = {};
    if (branch) filter.branch_id = branch;
    if (active === 'true') filter.is_active = true;
    if (active === 'false') filter.is_active = false;

    const employees = await Employee.find(filter)
      .populate('branch_id', 'name')
      .populate('amuta_distribution.amuta_id', 'name short_name')
      .sort({ full_name: 1 })
      .lean();

    res.json({
      employees: employees.map(e => ({
        ...e,
        id: e._id,
        branch_name: e.branch_id?.name || null,
        branch_id: e.branch_id?._id || e.branch_id,
        // Flatten the first amuta's rate into top-level display fields so the
        // table can show a single "שכר" column without the frontend having
        // to reach into the distribution array.
        _display_rate: (() => {
          const first = (e.amuta_distribution || []).find(d => d.hourly_rate || d.global_salary);
          if (!first) return null;
          if (e.salary_type === 'global') return first.global_salary;
          return first.hourly_rate;
        })(),
      })),
    });
  } catch (err) { next(err); }
}

async function getEmployee(req, res, next) {
  try {
    const employee = await Employee.findById(req.params.id)
      .populate('branch_id', 'name')
      .populate('amuta_distribution.amuta_id', 'name short_name')
      .lean();
    if (!employee) return res.status(404).json({ error: 'עובד לא נמצא' });
    res.json({
      employee: {
        ...employee,
        id: employee._id,
        branch_name: employee.branch_id?.name || null,
      },
    });
  } catch (err) { next(err); }
}

/**
 * Accepts the full Employee payload. Notable: `amuta_distribution` can be
 * passed as an array of { amuta_id, hourly_rate, global_salary, ... }.
 */
async function createEmployee(req, res, next) {
  try {
    const payload = { ...req.body };
    if (!payload.full_name || !payload.branch_id) {
      return res.status(400).json({ error: 'שם מלא וסניף הם שדות חובה' });
    }
    const emp = await Employee.create(payload);
    res.status(201).json({ employee: { ...emp.toObject(), id: emp._id } });
  } catch (err) { next(err); }
}

async function updateEmployee(req, res, next) {
  try {
    const emp = await Employee.findById(req.params.id);
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const fields = [
      'full_name', 'israeli_id', 'branch_id', 'phone', 'email', 'address',
      'position', 'start_date',
      'salary_type', 'salary_is_net', 'amuta_distribution',
      'travel_allowance', 'meal_vouchers', 'recreation_annual',
      'pension_exempt', 'bituach_leumi_exempt', 'has_army_reserve_form',
      'loans', 'bonuses', 'notes', 'is_active',
      'on_maternity_leave', 'maternity_leave_from', 'maternity_leave_to',
    ];
    for (const f of fields) {
      if (req.body[f] !== undefined) emp[f] = req.body[f];
    }
    await emp.save(); // triggers post-save hook for orphan punch re-linking
    res.json({ employee: { ...emp.toObject(), id: emp._id } });
  } catch (err) { next(err); }
}

async function removeEmployee(req, res, next) {
  try {
    const emp = await Employee.findById(req.params.id);
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });
    // Soft delete so historical punches/attendance still reference something.
    emp.is_active = false;
    await emp.save();
    res.json({ ok: true, id: req.params.id });
  } catch (err) { next(err); }
}

// --- Attendance -----------------------------------------------------------

/**
 * GET /api/payroll/attendance?branch=...&month=YYYY-MM
 *
 * Returns attendance grouped by employee, then by day. Unmatched punches
 * (no Employee with that israeli_id) are returned in an `unlinked` group so
 * the admin can see them and assign later.
 */
async function attendanceByMonth(req, res, next) {
  try {
    const { branch, month } = req.query;
    if (!branch) return res.status(400).json({ error: 'branch is required' });
    const range = monthRange(month);
    if (!range) return res.status(400).json({ error: 'month must be YYYY-MM' });

    const [employees, punches] = await Promise.all([
      Employee.find({ branch_id: branch, is_active: true })
        .select('_id full_name israeli_id position')
        .sort({ full_name: 1 })
        .lean(),
      Punch.find({
        branch_id: branch,
        timestamp: { $gte: range.from, $lt: range.to },
        ignored: { $ne: true },
      })
        .sort({ timestamp: 1 })
        .lean(),
    ]);

    // Filter punches to the exact Israel-local month (drop overflow from
    // the 2-day buffer we added in monthRange()).
    const ymPrefix = `${range.year}-${String(range.month).padStart(2, '0')}`;
    const monthPunches = punches.filter(p => israelDateKey(new Date(p.timestamp)).startsWith(ymPrefix));

    // Bucket by employee (use employee_id if matched, else group under the
    // raw israeli_id for the `unlinked` block).
    const byEmployee = new Map();
    const unlinkedByIsraeliId = new Map();

    for (const emp of employees) {
      byEmployee.set(String(emp._id), {
        employee_id: String(emp._id),
        full_name: emp.full_name,
        israeli_id: emp.israeli_id || '',
        position: emp.position || '',
        days: {},
        month_total_hours: 0,
        incomplete_days: 0,
      });
    }

    for (const p of monthPunches) {
      const dayKey = israelDateKey(new Date(p.timestamp));
      let bucket;
      if (p.employee_id) {
        bucket = byEmployee.get(String(p.employee_id));
      }
      if (!bucket) {
        // Unlinked → key by israeli_id
        const k = String(p.israeli_id || 'unknown');
        bucket = unlinkedByIsraeliId.get(k);
        if (!bucket) {
          bucket = {
            employee_id: null,
            full_name: `(לא מזוהה — ת"ז ${k})`,
            israeli_id: k,
            position: '',
            days: {},
            month_total_hours: 0,
            incomplete_days: 0,
            unlinked: true,
          };
          unlinkedByIsraeliId.set(k, bucket);
        }
      }
      if (!bucket.days[dayKey]) bucket.days[dayKey] = [];
      bucket.days[dayKey].push(p);
    }

    // Summarize each day for each bucket.
    const finalize = (bucket) => {
      const summarized = {};
      for (const [dayKey, dayPunches] of Object.entries(bucket.days)) {
        const s = summarizeDay(dayPunches);
        summarized[dayKey] = s;
        bucket.month_total_hours += s.total_hours;
        if (s.incomplete) bucket.incomplete_days++;
      }
      bucket.days = summarized;
      bucket.month_total_hours = Math.round(bucket.month_total_hours * 100) / 100;
      return bucket;
    };

    const employeeBlocks = [...byEmployee.values()].map(finalize);
    const unlinkedBlocks = [...unlinkedByIsraeliId.values()].map(finalize);

    res.json({
      month: ymPrefix,
      branch_id: branch,
      employees: employeeBlocks,
      unlinked: unlinkedBlocks,
      totals: {
        employees: employeeBlocks.length,
        unlinked: unlinkedBlocks.length,
        total_punches: monthPunches.length,
        matched_punches: monthPunches.filter(p => p.employee_id).length,
      },
    });
  } catch (err) { next(err); }
}

/**
 * GET /api/payroll/employees/:id/hours-report?month=YYYY-MM
 * Detailed per-day breakdown for a single employee (used by the "דוח שעות" modal).
 */
async function hoursReport(req, res, next) {
  try {
    const { month } = req.query;
    const emp = await Employee.findById(req.params.id)
      .populate('branch_id', 'name')
      .lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });
    const range = monthRange(month);
    if (!range) return res.status(400).json({ error: 'month must be YYYY-MM' });

    const punches = await Punch.find({
      branch_id: emp.branch_id?._id || emp.branch_id,
      timestamp: { $gte: range.from, $lt: range.to },
      employee_id: emp._id,
      ignored: { $ne: true },
    }).sort({ timestamp: 1 }).lean();

    const ymPrefix = `${range.year}-${String(range.month).padStart(2, '0')}`;
    const filtered = punches.filter(p => israelDateKey(new Date(p.timestamp)).startsWith(ymPrefix));

    const days = {};
    for (const p of filtered) {
      const k = israelDateKey(new Date(p.timestamp));
      (days[k] ||= []).push(p);
    }
    const dayRows = Object.keys(days).sort().map(k => ({
      date: k,
      ...summarizeDay(days[k]),
    }));

    const monthMinutes = dayRows.reduce((s, d) => s + d.total_minutes, 0);
    res.json({
      month: ymPrefix,
      employee: {
        id: String(emp._id),
        full_name: emp.full_name,
        israeli_id: emp.israeli_id,
        branch_name: emp.branch_id?.name || null,
        position: emp.position || '',
        salary_type: emp.salary_type,
      },
      days: dayRows,
      totals: {
        days_worked: dayRows.length,
        total_minutes: monthMinutes,
        total_hours: Math.round((monthMinutes / 60) * 100) / 100,
        incomplete_days: dayRows.filter(d => d.incomplete).length,
      },
    });
  } catch (err) { next(err); }
}

// --- Clock users (for matching UI) ----------------------------------------

/**
 * GET /api/payroll/clock-users?branch=X
 *
 * Returns the cached list of users stored on the branch's TIMEDOX clock,
 * each enriched with `linked_employee` — the Employee (if any) whose
 * israeli_id already matches this clock user. The admin UI uses this to
 * show a checklist of "which clock users are already assigned, which are
 * still orphans".
 */
async function listClockUsers(req, res, next) {
  try {
    const { branch } = req.query;
    if (!branch) return res.status(400).json({ error: 'branch is required' });

    const branchDoc = await Branch.findById(branch).select('clock_users clock_users_updated_at name').lean();
    if (!branchDoc) return res.status(404).json({ error: 'branch not found' });

    const clockUsers = Array.isArray(branchDoc.clock_users) ? branchDoc.clock_users : [];
    const userIds = [...new Set(clockUsers.map(u => String(u.user_id || '')).filter(Boolean))];

    // Look up existing employees in this branch that already carry one of
    // these Israeli IDs, so we can tag each clock user with `linked_employee`.
    const existing = userIds.length
      ? await Employee.find({
          branch_id: branch,
          israeli_id: { $in: userIds },
        }).select('_id full_name israeli_id').lean()
      : [];
    const byId = new Map(existing.map(e => [e.israeli_id, e]));

    res.json({
      branch_id: String(branch),
      branch_name: branchDoc.name,
      updated_at: branchDoc.clock_users_updated_at,
      clock_users: clockUsers.map(u => ({
        uid: u.uid,
        user_id: u.user_id,
        linked_employee: byId.get(String(u.user_id)) || null,
      })).sort((a, b) => (a.uid || 0) - (b.uid || 0)),
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll/clock-users/assign
 *
 * Body: { assignments: [{ employee_id, israeli_id }, ...] }
 *
 * Applies each assignment by saving the Employee with the new israeli_id.
 * Because Employee uses doc.save() this triggers the post-save hook that
 * back-fills any orphan Punch records. Assignments are applied in sequence
 * so partial success is possible — the response lists each result.
 */
async function assignIsraeliIds(req, res, next) {
  try {
    const { assignments } = req.body || {};
    if (!Array.isArray(assignments) || assignments.length === 0) {
      return res.status(400).json({ error: 'assignments must be a non-empty array' });
    }
    const results = [];
    for (const { employee_id, israeli_id } of assignments) {
      try {
        if (!employee_id || !israeli_id) {
          results.push({ employee_id, israeli_id, ok: false, error: 'missing fields' });
          continue;
        }
        const emp = await Employee.findById(employee_id);
        if (!emp) {
          results.push({ employee_id, israeli_id, ok: false, error: 'employee not found' });
          continue;
        }
        emp.israeli_id = israeli_id; // pre-save hook normalizes
        await emp.save();             // post-save hook relinks orphan punches
        results.push({
          employee_id,
          israeli_id: emp.israeli_id,
          full_name: emp.full_name,
          ok: true,
        });
      } catch (e) {
        results.push({ employee_id, israeli_id, ok: false, error: e.message });
      }
    }
    res.json({
      ok: true,
      applied: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results,
    });
  } catch (err) { next(err); }
}

module.exports = {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  removeEmployee,
  attendanceByMonth,
  hoursReport,
  listClockUsers,
  assignIsraeliIds,
};
