/**
 * Payroll controller — CRUD for Employee (payroll), plus attendance / hours
 * aggregation from Punch records.
 *
 * This is separate from `employee.controller.js` which operates on the User
 * model (login accounts). A future cleanup could merge the two by linking
 * Employee.user_id, but for now they live in parallel.
 */
const { Employee, Punch, Branch, Amuta, User, AgentCommand } = require('../models');
const { calculateMonthlySalary } = require('../services/payrollCalc');
const bcrypt = require('bcryptjs');

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
      in_id: String(inP._id),
      out_id: String(outP._id),
      in_hhmm: israelTimeHHMM(new Date(inP.timestamp)),
      out_hhmm: israelTimeHHMM(new Date(outP.timestamp)),
      minutes: mins,
      is_manual: inP.timestamp_source === 'manual' || outP.timestamp_source === 'manual',
    });
    totalMinutes += mins;
  }
  const incomplete = sorted.length % 2 === 1;
  let trailingPunch = null;
  if (incomplete) {
    const last = sorted[sorted.length - 1];
    trailingPunch = {
      id: String(last._id),
      timestamp: last.timestamp,
      hhmm: israelTimeHHMM(new Date(last.timestamp)),
      is_manual: last.timestamp_source === 'manual',
    };
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
    // 'all' (cross-branch admin view) is a UI sentinel, not a real branch_id —
    // skip the filter so every active employee is returned.
    if (branch && branch !== 'all') filter.branch_id = branch;
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
        _display_required_hours: (() => {
          const first = (e.amuta_distribution || []).find(d => d.required_hours);
          return first?.required_hours || null;
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

    // Auto-create User account if employee has israeli_id
    let createdUser = null;
    const normalizedId = (emp.israeli_id || '').replace(/\D/g, '').padStart(9, '0');
    if (normalizedId.length === 9 && normalizedId !== '000000000') {
      const existingUser = await User.findOne({ id_number: normalizedId });
      if (!existingUser) {
        try {
          const hash = await bcrypt.hash(normalizedId, 10);
          createdUser = await User.create({
            email: `${normalizedId}@gan-halomot.local`,
            password_hash: hash,
            full_name: emp.full_name,
            id_number: normalizedId,
            role: 'teacher',
            branch_id: emp.branch_id,
            position: emp.position || '',
            is_active: true,
          });
          emp.user_id = createdUser._id;
          await emp.save();
        } catch (userErr) {
          console.error(`Auto-create user failed for ${emp.full_name}:`, userErr.message);
        }
      } else {
        // Link existing user
        emp.user_id = existingUser._id;
        await emp.save();
      }

      // Auto-queue add_user command to ALL branches with clocks
      try {
        const clockBranches = await Branch.find({ clock_ip: { $ne: null, $ne: '' } }).select('_id').lean();
        for (const branch of clockBranches) {
          await AgentCommand.create({
            branch_id: branch._id,
            type: 'add_user',
            payload: {
              israeli_id: normalizedId,
              name: emp.full_name,
              privilege: 0,
            },
            status: 'pending',
          });
        }
        console.log(`Queued add_user for ${emp.full_name} on ${clockBranches.length} branch(es)`);
      } catch (cmdErr) {
        console.error(`Auto-queue clock command failed:`, cmdErr.message);
      }
    }

    res.status(201).json({
      employee: { ...emp.toObject(), id: emp._id },
      user_created: !!createdUser,
    });
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

    // Deactivate User account
    if (emp.user_id) {
      await User.findByIdAndUpdate(emp.user_id, { is_active: false });
    }

    // Queue delete_user on all clocks
    const normalizedId = (emp.israeli_id || '').replace(/\D/g, '').padStart(9, '0');
    if (normalizedId.length === 9 && normalizedId !== '000000000') {
      try {
        const clockBranches = await Branch.find({ clock_ip: { $ne: null, $ne: '' } }).select('_id clock_users').lean();
        for (const branch of clockBranches) {
          // Find the UID on this branch's clock
          const clockUser = (branch.clock_users || []).find(u => u.user_id === normalizedId);
          if (clockUser) {
            await AgentCommand.create({
              branch_id: branch._id,
              type: 'delete_user',
              payload: { uid: clockUser.uid, israeli_id: normalizedId, name: emp.full_name },
              status: 'pending',
            });
          }
        }
      } catch (cmdErr) {
        console.error('Auto-queue delete_user failed:', cmdErr.message);
      }
    }

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

    // First batch — employees + branch list (don't depend on each other).
    const [homeEmployees, allEmployees, branches] = await Promise.all([
      Employee.find({ branch_id: branch, is_active: true })
        .select('_id full_name israeli_id position')
        .sort({ full_name: 1 })
        .lean(),
      Employee.find({ is_active: true })
        .select('_id full_name israeli_id branch_id position')
        .lean(),
      Branch.find({}).select('_id name').lean(),
    ]);
    const homeIdsArr = homeEmployees.map(e => e._id);

    // Second batch — punches. Run in parallel now that we have the home IDs.
    //  1) atThisBranchPunches: physically happened here (includes guests).
    //  2) awayPunches: home employees who punched at OTHER branches.
    const [atThisBranchPunches, awayPunches] = await Promise.all([
      Punch.find({
        branch_id: branch,
        timestamp: { $gte: range.from, $lt: range.to },
        ignored: { $ne: true },
      }).sort({ timestamp: 1 }).lean(),
      Punch.find({
        branch_id: { $ne: branch },
        employee_id: { $in: homeIdsArr },
        timestamp: { $gte: range.from, $lt: range.to },
        ignored: { $ne: true },
      }).sort({ timestamp: 1 }).lean(),
    ]);

    const ymPrefix = `${range.year}-${String(range.month).padStart(2, '0')}`;
    const monthPunches = atThisBranchPunches.filter(p =>
      israelDateKey(new Date(p.timestamp)).startsWith(ymPrefix));
    const monthAwayPunches = awayPunches.filter(p =>
      israelDateKey(new Date(p.timestamp)).startsWith(ymPrefix));

    const branchById = new Map(branches.map(b => [String(b._id), b.name]));
    const empById = new Map(allEmployees.map(e => [String(e._id), e]));
    const homeIdSet = new Set(homeEmployees.map(e => String(e._id)));

    // Three buckets:
    //  - byEmployee: home-branch employees (their punches at this branch)
    //  - guestByEmployee: employees from OTHER branches who punched here
    //  - unlinkedByIsraeliId: punches with no employee_id (truly unmatched)
    const byEmployee = new Map();
    const guestByEmployee = new Map();
    const unlinkedByIsraeliId = new Map();

    for (const emp of homeEmployees) {
      byEmployee.set(String(emp._id), {
        employee_id: String(emp._id),
        full_name: emp.full_name,
        israeli_id: emp.israeli_id || '',
        position: emp.position || '',
        days: {},
        away_days: {},          // days where this person worked at another branch
        month_total_hours: 0,
        away_total_hours: 0,
        incomplete_days: 0,
      });
    }

    for (const p of monthPunches) {
      const dayKey = israelDateKey(new Date(p.timestamp));
      const empIdStr = p.employee_id ? String(p.employee_id) : null;

      if (empIdStr && homeIdSet.has(empIdStr)) {
        // Home employee, punched at home — normal case.
        const bucket = byEmployee.get(empIdStr);
        if (!bucket.days[dayKey]) bucket.days[dayKey] = [];
        bucket.days[dayKey].push(p);
      } else if (empIdStr && empById.has(empIdStr)) {
        // Guest: known employee from another branch.
        let bucket = guestByEmployee.get(empIdStr);
        if (!bucket) {
          const emp = empById.get(empIdStr);
          bucket = {
            employee_id: empIdStr,
            full_name: emp.full_name,
            israeli_id: emp.israeli_id || '',
            position: emp.position || '',
            home_branch_id: emp.branch_id ? String(emp.branch_id) : null,
            home_branch_name: emp.branch_id ? (branchById.get(String(emp.branch_id)) || '') : '',
            is_guest: true,
            days: {},
            month_total_hours: 0,
            incomplete_days: 0,
          };
          guestByEmployee.set(empIdStr, bucket);
        }
        if (!bucket.days[dayKey]) bucket.days[dayKey] = [];
        bucket.days[dayKey].push(p);
      } else {
        // Truly unlinked: no employee in any branch with this israeli_id.
        const k = String(p.israeli_id || 'unknown');
        let bucket = unlinkedByIsraeliId.get(k);
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
        if (!bucket.days[dayKey]) bucket.days[dayKey] = [];
        bucket.days[dayKey].push(p);
      }
    }

    // Hour bucket for home employees who worked at another branch this month.
    // We track per-day where they were so the UI can label "worked at <other>".
    for (const p of monthAwayPunches) {
      const dayKey = israelDateKey(new Date(p.timestamp));
      const empIdStr = String(p.employee_id);
      const bucket = byEmployee.get(empIdStr);
      if (!bucket) continue;
      if (!bucket.away_days[dayKey]) {
        bucket.away_days[dayKey] = { punches: [], at_branches: new Set() };
      }
      bucket.away_days[dayKey].punches.push(p);
      bucket.away_days[dayKey].at_branches.add(branchById.get(String(p.branch_id)) || 'אחר');
    }

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

      // For home employees: also summarize away_days (same shape, plus branch list)
      if (bucket.away_days) {
        const awaySummarized = {};
        for (const [dayKey, info] of Object.entries(bucket.away_days)) {
          const s = summarizeDay(info.punches);
          s.at_branches = [...info.at_branches];
          awaySummarized[dayKey] = s;
          bucket.away_total_hours += s.total_hours;
        }
        bucket.away_days = awaySummarized;
        bucket.away_total_hours = Math.round(bucket.away_total_hours * 100) / 100;
      }
      return bucket;
    };

    const employeeBlocks = [...byEmployee.values()].map(finalize);
    const guestBlocks = [...guestByEmployee.values()].map(finalize);
    const unlinkedBlocks = [...unlinkedByIsraeliId.values()].map(finalize);

    res.json({
      month: ymPrefix,
      branch_id: branch,
      employees: employeeBlocks,
      guests: guestBlocks,           // NEW — workers from other branches who punched here
      unlinked: unlinkedBlocks,
      totals: {
        employees: employeeBlocks.length,
        guests: guestBlocks.length,
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

    // Cross-branch: pull punches by employee_id only (any branch). Salary
    // is computed at home-branch rate but every hour worked counts.
    const punches = await Punch.find({
      timestamp: { $gte: range.from, $lt: range.to },
      employee_id: emp._id,
      ignored: { $ne: true },
    }).sort({ timestamp: 1 }).lean();

    const branches = await Branch.find({}).select('_id name').lean();
    const branchById = new Map(branches.map(b => [String(b._id), b.name]));
    const homeBranchId = String(emp.branch_id?._id || emp.branch_id);

    const ymPrefix = `${range.year}-${String(range.month).padStart(2, '0')}`;
    const filtered = punches.filter(p => israelDateKey(new Date(p.timestamp)).startsWith(ymPrefix));

    const days = {};
    for (const p of filtered) {
      const k = israelDateKey(new Date(p.timestamp));
      (days[k] ||= []).push(p);
    }
    const dayRows = Object.keys(days).sort().map(k => {
      const summary = summarizeDay(days[k]);
      // Tag each session with the branch where its first punch happened, and
      // mark the day with the set of non-home branches the employee visited.
      const branchesVisited = new Set();
      for (const p of days[k]) {
        const bid = String(p.branch_id);
        if (bid !== homeBranchId) branchesVisited.add(branchById.get(bid) || 'אחר');
      }
      return {
        date: k,
        ...summary,
        cross_branch_names: [...branchesVisited],   // empty array if all at home
      };
    });

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

// --- Manual punch editing (for forgotten punches / corrections) ----------

/**
 * POST /api/payroll/manual-punches
 * Body: { employee_id, date: "YYYY-MM-DD", in_time: "HH:mm", out_time: "HH:mm", note }
 *
 * Creates a pair of Punch records (in + out) for the given Israel-local day.
 * Each manual punch gets a synthetic device_user_sn in the negative range
 * (`-Date.now() - n`) so it never collides with real clock records. These
 * are tagged `timestamp_source: 'manual'` and carry the user who created
 * them for audit.
 */
async function createManualPunches(req, res, next) {
  try {
    const { employee_id, date, in_time, out_time, note = '' } = req.body || {};
    if (!employee_id || !date) {
      return res.status(400).json({ error: 'employee_id and date are required' });
    }
    if (!in_time && !out_time) {
      return res.status(400).json({ error: 'at least one of in_time / out_time is required' });
    }

    const emp = await Employee.findById(employee_id).lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    // Build Date objects in Israel time. We piggy-back on toLocaleString
    // with en-CA to get a YYYY-MM-DD HH:mm:ss output and then reparse as
    // local-naive, then compensate for the TZ offset.
    function ilDateTime(dateStr, hhmm) {
      // dateStr: "2026-04-10", hhmm: "08:30"
      const [y, m, d] = dateStr.split('-').map(Number);
      const [hh, mm] = hhmm.split(':').map(Number);
      // Asia/Jerusalem is UTC+2 in winter and UTC+3 in summer. Node's Date
      // constructor with Z/UTC is the safest, but we need to know the
      // correct offset for THAT date. We compute the offset by formatting
      // a probe Date in both IL and UTC and diffing.
      const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
      const ilHour = parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(probe),
        10
      );
      const offsetHours = ilHour - 12; // 2 or 3
      // Now build the UTC Date for the intended IL local time
      return new Date(Date.UTC(y, m - 1, d, hh - offsetHours, mm, 0));
    }

    const created = [];
    const baseSn = -Date.now();

    const pairs = [];
    if (in_time)  pairs.push({ time: in_time,  state: 0, label: 'in'  });
    if (out_time) pairs.push({ time: out_time, state: 1, label: 'out' });

    for (let i = 0; i < pairs.length; i++) {
      const { time, state } = pairs[i];
      const ts = ilDateTime(date, time);
      const sn = baseSn - i; // unique per record
      const punch = await Punch.create({
        branch_id: emp.branch_id,
        employee_id: emp._id,
        israeli_id: emp.israeli_id || '',
        device_user_sn: sn,
        device_user_id: null,
        timestamp: ts,
        timestamp_source: 'manual',
        state,
        verify_mode: 0,
        received_at: new Date(),
        agent_version: 'manual-entry',
        manual_note: note || '',
        created_by: req.user?.id || null,
      });
      created.push(punch);
    }

    res.json({ ok: true, created: created.length, punches: created });
  } catch (err) { next(err); }
}

/**
 * DELETE /api/payroll/punches/:id
 * Allows admins to delete any punch (manual or clock) — useful for fixing
 * accidental double-punches or removing test punches.
 */
async function deletePunch(req, res, next) {
  try {
    const p = await Punch.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'punch not found' });
    await p.deleteOne();
    res.json({ ok: true, id: req.params.id });
  } catch (err) { next(err); }
}

// --- Salary calculation --------------------------------------------------

/**
 * GET /api/payroll/employees/:id/salary?month=YYYY-MM
 *
 * Computes the expected monthly salary for a single employee: pairs punches
 * into sessions, splits into regular/OT, applies rates + loans + bonuses,
 * returns a full breakdown.
 */
async function salaryForEmployee(req, res, next) {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'month=YYYY-MM is required' });
    const emp = await Employee.findById(req.params.id).lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const [y, m] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - 3 * 3600 * 1000);
    const to   = new Date(Date.UTC(y, m,     2, 0, 0, 0));

    const punches = await Punch.find({
      employee_id: emp._id,
      timestamp: { $gte: from, $lt: to },
      ignored: { $ne: true },
    }).sort({ timestamp: 1 }).lean();

    const forceFullGlobal = req.query.force_full_global === 'true';
    const breakdown = calculateMonthlySalary(emp, punches, month, { force_full_global: forceFullGlobal });
    res.json({ ok: true, breakdown });
  } catch (err) { next(err); }
}

/**
 * GET /api/payroll/salary-summary?branch=X&month=YYYY-MM
 *
 * Returns a compact per-employee salary estimate for the whole branch, used
 * by the monthly salary dashboard. Each entry has the key numbers the UI
 * needs to render a row without refetching the full breakdown.
 */
async function salarySummary(req, res, next) {
  try {
    const { branch, month } = req.query;
    if (!branch || !month) return res.status(400).json({ error: 'branch and month are required' });

    const employees = await Employee.find({ branch_id: branch, is_active: true })
      .sort({ full_name: 1 })
      .lean();

    const [y, m] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - 3 * 3600 * 1000);
    const to   = new Date(Date.UTC(y, m,     2, 0, 0, 0));

    // Cross-branch: pull all punches by these employees regardless of where
    // they physically clocked in. Salary = work × home-branch rate, even if
    // the work happened at a sister branch. Branch info is preserved on the
    // punch so we can break it down per-row for the UI.
    const allPunches = await Punch.find({
      employee_id: { $in: employees.map(e => e._id) },
      timestamp: { $gte: from, $lt: to },
      ignored: { $ne: true },
    }).sort({ timestamp: 1 }).lean();

    const branches = await Branch.find({}).select('_id name').lean();
    const branchById = new Map(branches.map(b => [String(b._id), b.name]));

    const byEmpId = new Map();
    for (const p of allPunches) {
      const k = String(p.employee_id);
      if (!byEmpId.has(k)) byEmpId.set(k, []);
      byEmpId.get(k).push(p);
    }

    const rows = employees.map(emp => {
      const empPunches = byEmpId.get(String(emp._id)) || [];
      const b = calculateMonthlySalary(emp, empPunches, month);

      // Build a small breakdown of where the punches happened. The home
      // branch's count includes any punches at branch=home; the other entries
      // are guest visits. Only included when there's actually cross-branch
      // activity, so the typical row stays clean.
      const branchCounts = {};
      for (const p of empPunches) {
        const bid = String(p.branch_id);
        branchCounts[bid] = (branchCounts[bid] || 0) + 1;
      }
      const homeBid = String(emp.branch_id);
      const otherBranches = Object.keys(branchCounts).filter(bid => bid !== homeBid);
      const cross_branch = otherBranches.length === 0 ? null : {
        home_punches:  branchCounts[homeBid] || 0,
        elsewhere: otherBranches.map(bid => ({
          branch_id:   bid,
          branch_name: branchById.get(bid) || '?',
          punch_count: branchCounts[bid],
        })),
      };

      return {
        employee_id: String(emp._id),
        full_name: emp.full_name,
        israeli_id: emp.israeli_id || '',
        salary_type: emp.salary_type,
        hours_total: b.hours.total,
        hours_regular: b.hours.regular,
        hours_ot125: b.hours.ot_125,
        hours_ot150: b.hours.ot_150,
        days_worked: b.hours.days_worked,
        incomplete_days: b.hours.incomplete_days,
        required_hours: b.rates.required_hours,
        base_salary: b.components.base_salary,
        extras: b.components.travel + b.components.meal_vouchers + b.components.recreation_monthly + b.components.bonuses,
        deductions: b.deductions.loans,
        estimated_total: b.estimated_total,
        warnings: b.warnings,
        cross_branch,
      };
    });

    // Totals across the branch
    const totals = rows.reduce((acc, r) => ({
      employees: acc.employees + 1,
      hours: acc.hours + r.hours_total,
      base: acc.base + r.base_salary,
      extras: acc.extras + r.extras,
      deductions: acc.deductions + r.deductions,
      total: acc.total + r.estimated_total,
    }), { employees: 0, hours: 0, base: 0, extras: 0, deductions: 0, total: 0 });

    // Round totals for presentation
    for (const k of ['hours', 'base', 'extras', 'deductions', 'total']) {
      totals[k] = Math.round(totals[k] * 100) / 100;
    }

    res.json({ month, branch_id: branch, rows, totals });
  } catch (err) { next(err); }
}

// --- Employee self-service endpoints ---

/**
 * GET /api/payroll/my-salary-preview
 * Returns salary preview for the logged-in employee (current month)
 */
async function mySalaryPreview(req, res, next) {
  try {
    const emp = await Employee.findOne({ israeli_id: req.user.id_number || '', is_active: true }).lean()
      || await Employee.findOne({ full_name: { $regex: new RegExp(`^${(req.user.full_name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }, is_active: true }).lean();

    if (!emp) {
      return res.json({ base_salary: 0, overtime: 0, travel: 0, total: 0, loans: 0, message: 'לא נמצא עובד מקושר' });
    }

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [y, m] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - 3 * 3600 * 1000);
    const to = new Date(Date.UTC(y, m, 2, 0, 0, 0));

    // Fetch punches from ALL branches (cross-branch support)
    const punches = await Punch.find({
      employee_id: emp._id,
      timestamp: { $gte: from, $lt: to },
      ignored: { $ne: true },
    }).sort({ timestamp: 1 }).lean();

    const b = calculateMonthlySalary(emp, punches, month);

    // Build per-branch breakdown
    const branchIds = [...new Set(punches.map(p => String(p.branch_id)))];
    const branches = await Branch.find({ _id: { $in: branchIds } }).select('name').lean();
    const branchMap = {};
    for (const br of branches) branchMap[String(br._id)] = br.name;

    const byBranch = {};
    for (const p of punches) {
      const bId = String(p.branch_id);
      if (!byBranch[bId]) byBranch[bId] = { name: branchMap[bId] || 'לא ידוע', count: 0 };
      byBranch[bId].count++;
    }

    res.json({
      base_salary: Math.round(b.components.base_salary),
      overtime: Math.round((b.components.ot_125 || 0) + (b.components.ot_150 || 0)),
      travel: Math.round(b.components.travel || 0),
      meals: Math.round(b.components.meal_vouchers || 0),
      bonuses: Math.round(b.components.bonuses || 0),
      loans: Math.round(b.deductions.loans || 0),
      total: Math.round(b.estimated_total),
      hours_total: Math.round(b.hours.total * 100) / 100,
      days_worked: b.hours.days_worked,
      month,
      branches_breakdown: Object.values(byBranch),
    });
  } catch (err) { next(err); }
}

/**
 * GET /api/payroll/my-punches?month=YYYY-MM
 * Returns punches for the logged-in employee
 */
async function myPunches(req, res, next) {
  try {
    const month = req.query.month;
    if (!month) return res.status(400).json({ error: 'month=YYYY-MM is required' });

    const emp = await Employee.findOne({ israeli_id: req.user.id_number || '', is_active: true }).lean()
      || await Employee.findOne({ full_name: { $regex: new RegExp(`^${(req.user.full_name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }, is_active: true }).lean();

    if (!emp) {
      return res.json({ punches: [] });
    }

    const [y, m] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - 3 * 3600 * 1000);
    const to = new Date(Date.UTC(y, m, 2, 0, 0, 0));

    // Fetch punches from ALL branches (cross-branch)
    const rawPunches = await Punch.find({
      employee_id: emp._id,
      timestamp: { $gte: from, $lt: to },
      ignored: { $ne: true },
    }).sort({ timestamp: 1 }).lean();

    // Load branch names
    const branchIds = [...new Set(rawPunches.map(p => String(p.branch_id)))];
    const branches = await Branch.find({ _id: { $in: branchIds } }).select('name').lean();
    const branchMap = {};
    for (const br of branches) branchMap[String(br._id)] = br.name;

    // Group into days with branch info
    const dayMap = {};
    for (const p of rawPunches) {
      const d = new Date(p.timestamp);
      const dateStr = d.toLocaleDateString('he-IL', { timeZone: IL_TZ });
      if (!dayMap[dateStr]) dayMap[dateStr] = { times: [], branch: branchMap[String(p.branch_id)] || '' };
      dayMap[dateStr].times.push(d.toLocaleTimeString('he-IL', { timeZone: IL_TZ, hour: '2-digit', minute: '2-digit' }));
      // Use last punch's branch as the day's branch
      dayMap[dateStr].branch = branchMap[String(p.branch_id)] || '';
    }

    const punches = Object.entries(dayMap).map(([date, data]) => {
      const inTime = data.times[0] || null;
      const outTime = data.times.length >= 2 ? data.times[data.times.length - 1] : null;
      let hours = null;
      if (inTime && outTime && data.times.length >= 2) {
        const [h1, m1] = inTime.split(':').map(Number);
        const [h2, m2] = outTime.split(':').map(Number);
        hours = ((h2 * 60 + m2) - (h1 * 60 + m1)) / 60;
        hours = Math.round(hours * 100) / 100;
      }
      return { date, in_time: inTime, out_time: outTime, hours: hours ? `${hours}` : null, branch: data.branch };
    });

    res.json({ punches, month, employee_name: emp.full_name });
  } catch (err) { next(err); }
}

/**
 * GET /api/payroll/my-payslips
 * Returns payslip history for the logged-in employee (placeholder — returns empty for now)
 */
async function myPayslips(req, res, next) {
  try {
    // Payslips will be populated when the payroll finalization feature is built
    res.json({ payslips: [] });
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
  salaryForEmployee,
  salarySummary,
  createManualPunches,
  deletePunch,
  mySalaryPreview,
  myPunches,
  myPayslips,
};
