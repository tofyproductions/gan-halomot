/**
 * Payroll controller — CRUD for Employee (payroll), plus attendance / hours
 * aggregation from Punch records.
 *
 * This is separate from `employee.controller.js` which operates on the User
 * model (login accounts). A future cleanup could merge the two by linking
 * Employee.user_id, but for now they live in parallel.
 */
const mongoose = require('mongoose');
const { Employee, Punch, Branch, Amuta, User, AgentCommand, EmployeeCommitment, Holiday, EmployeeRequest, EmployeeChangeRequest, PunchResolution, SavedPayslip, PayrollMonth, EmployeeDocument } = require('../models');
const { calculateMonthlySalary, billableDayPunches } = require('../services/payrollCalc');
const { analyzeCommitment } = require('../services/commitmentAnalysis');
const { dispatchEmail } = require('../services/email.service');
const fixedSchedule = require('../services/fixedSchedule');
const fingerprintSync = require('../services/fingerprintSync');
const userSync = require('../services/userSync');
const form101 = require('../services/form101');
const { scanForm101 } = require('../services/form101Scan');

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
function summarizeDay(dayPunches, resolution) {
  const allSorted = [...dayPunches].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  // Same billing rule as the salary calc: ≤2 punches pair normally; a >2-punch
  // day uses the accountant's approved in/out labels when it has been resolved,
  // otherwise the provisional first→last span (flagged for review elsewhere).
  const sorted = billableDayPunches(allSorted, resolution);
  const needsReview = allSorted.length > 2 && !(resolution && resolution.status === 'approved');
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
  const PENDING = new Set(['pending', 'pending_manager', 'pending_accountant']);
  // pending/manual flags consider ALL punches, not just the collapsed span.
  const has_pending = allSorted.some(p => PENDING.has(p.approval_status));
  const has_manual = allSorted.some(p => p.timestamp_source === 'manual');
  // Generated from a standing weekly schedule (employee doesn't clock in) —
  // marked separately so the grid never passes it off as a real clock reading.
  const has_fixed_schedule = allSorted.some(p => p.timestamp_source === 'fixed_schedule');
  // Only a lone single punch is genuinely incomplete (no span to bill).
  const incomplete = allSorted.length === 1;
  let trailingPunch = null;
  if (incomplete) {
    const last = allSorted[allSorted.length - 1];
    trailingPunch = {
      id: String(last._id),
      timestamp: last.timestamp,
      hhmm: israelTimeHHMM(new Date(last.timestamp)),
      is_manual: last.timestamp_source === 'manual',
    };
  }
  return {
    needs_review: needsReview,
    punch_count: allSorted.length,
    sessions,
    trailing_punch: trailingPunch,
    incomplete,
    has_pending,
    has_manual,
    has_fixed_schedule,
    total_minutes: totalMinutes,
    total_hours: Math.round((totalMinutes / 60) * 100) / 100,
    first_in: sorted.length ? israelTimeHHMM(new Date(sorted[0].timestamp)) : null,
    last_out: sorted.length >= 2 && !incomplete
      ? israelTimeHHMM(new Date(sorted[sorted.length - 1].timestamp))
      : null,
  };
}

// --- Employee CRUD --------------------------------------------------------

/**
 * What an employee record is missing before payroll can run cleanly.
 *
 * These gaps used to surface one at a time, at the worst moment — a salary
 * that can't be paid because there is no bank account, a payslip that can't be
 * emailed because there is no address. The list screen can say so up front.
 *
 * `formIds` is the set of employee ids that have a טופס 101 on file FOR THE
 * CURRENT TAX YEAR — the form is refiled every January, so one from 2024 does
 * not answer for 2026. It used to be matched on the document's label, which
 * read as missing for anyone whose file was named something else; documents
 * now carry a real type, so this is a plain lookup like the rest.
 */
function missingFieldsFor(emp, formIds, taxYear) {
  const miss = [];
  const blank = (v) => v === null || v === undefined || String(v).trim() === '';
  // 'blocking' stops the month from being paid or the person from being
  // identified. 'warning' is everything that merely makes life harder later.
  const add = (label, level) => miss.push({ label, level });

  if (blank(emp.israeli_id)) add('ת״ז', 'blocking');
  if (blank(emp.bank_number) || blank(emp.bank_branch) || blank(emp.bank_account)) add('חשבון בנק', 'blocking');

  // A rate can live either at the top level or per-amuta; either one counts.
  const dist = emp.amuta_distribution || [];
  if (emp.salary_type === 'global') {
    if (!(emp.global_salary || dist.some((d) => d.global_salary))) add('שכר תקן', 'blocking');
  } else if (!(emp.hourly_rate || dist.some((d) => d.hourly_rate))) {
    add('תעריף שעתי', 'blocking');
  }

  if (blank(emp.phone)) add('טלפון', 'warning');
  if (blank(emp.email)) add('אימייל', 'warning');
  if (!emp.start_date) add('תאריך תחילה', 'warning');
  if (!formIds.has(String(emp._id))) add(`טופס 101 (${taxYear})`, 'warning');
  return miss;
}

async function listEmployees(req, res, next) {
  try {
    const { branch, active } = req.query;
    const filter = {};
    // 'all' (cross-branch admin view) is a UI sentinel, not a real branch_id —
    // skip the filter so every active employee is returned.
    if (branch && branch !== 'all') filter.branch_id = branch;
    if (active === 'true') filter.is_active = true;
    if (active === 'false') filter.is_active = false;

    // Enforce per-user branch scope for non-admin/accountant viewers
    const role = req.user?.role;
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length > 0 ? managed : fallback;
      if (filter.branch_id && !allowed.includes(String(filter.branch_id))) {
        return res.json({ employees: [] });
      }
      if (!filter.branch_id) filter.branch_id = { $in: allowed };
    }

    const employees = await Employee.find(filter)
      .populate('branch_id', 'name')
      .populate('amuta_distribution.amuta_id', 'name short_name')
      .sort({ full_name: 1 })
      .lean();

    // One pass for everyone who has a טופס 101 on file for this tax year, so
    // the per-employee check below stays a pure function over data in hand.
    const taxYear = form101.currentTaxYear();
    const formIds = await form101.employeeIdsWithForm(employees.map((e) => e._id), taxYear);

    res.json({
      tax_year: taxYear,
      employees: employees.map(e => ({
        ...e,
        id: e._id,
        has_form_101: formIds.has(String(e._id)),
        missing_fields: missingFieldsFor(e, formIds, taxYear),
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
 * Fill in a missing amuta_id on rate-bearing distribution entries so the
 * operator never has to pick an amuta by hand. Resolution order:
 *   1. the employee's branch amuta_id
 *   2. the amuta used by the most branches (org default)
 *   3. the single active amuta, if there is exactly one
 * If none resolves, entries are left as-is (amuta_id stays null).
 */
async function resolveAmutaDistribution(distribution, branchId) {
  if (!Array.isArray(distribution) || distribution.length === 0) return distribution;
  const hasRate = (d) => d.hourly_rate != null || d.global_salary != null ||
                         d.global_ot_rate != null || d.required_hours != null;
  const needsResolve = distribution.some(d => !d.amuta_id && hasRate(d));
  if (!needsResolve) return distribution;

  let fallback = null;
  if (branchId) {
    const branch = await Branch.findById(branchId).select('amuta_id').lean();
    if (branch?.amuta_id) fallback = branch.amuta_id;
  }
  if (!fallback) {
    // Most common branch amuta = the org's de-facto default.
    const branches = await Branch.find({ amuta_id: { $ne: null } }).select('amuta_id').lean();
    const counts = new Map();
    for (const b of branches) {
      const k = String(b.amuta_id);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
    if (best) fallback = best;
  }
  if (!fallback) {
    const active = await Amuta.find({ is_active: true }).select('_id').limit(2).lean();
    if (active.length === 1) fallback = active[0]._id;
  }
  if (!fallback) return distribution;
  return distribution.map(d => (!d.amuta_id && hasRate(d)) ? { ...d, amuta_id: fallback } : d);
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
    if (!mongoose.isValidObjectId(payload.branch_id)) {
      return res.status(400).json({ error: 'יש לבחור סניף תקין' });
    }
    payload.amuta_distribution = await resolveAmutaDistribution(payload.amuta_distribution, payload.branch_id);
    const emp = await Employee.create(payload);

    // Give her a login, with the role her job title implies (userSync owns the
    // position→role mapping and the linking rules).
    let createdUser = null;
    const normalizedId = userSync.normalizeIsraeliId(emp.israeli_id);
    if (normalizedId) {
      try {
        const synced = await userSync.syncEmployeeUser(emp, { isNew: true });
        if (synced.created) createdUser = synced.user;
      } catch (userErr) {
        console.error(`Auto-create user failed for ${emp.full_name}:`, userErr.message);
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

// Hebrew labels for the change-approval diff view.
const EMPLOYEE_FIELD_LABELS = {
  full_name: 'שם מלא', israeli_id: 'ת"ז', employee_number: 'מספר עובד', is_freelancer: 'עצמאי',
  receives_salary: 'מקבל/ת שכר',
  branch_id: 'סניף', phone: 'טלפון', email: 'אימייל', address: 'כתובת', gender: 'מין', position: 'תפקיד',
  start_date: 'תאריך תחילה', salary_type: 'סוג שכר', salary_is_net: 'נטו/ברוטו',
  amuta_distribution: 'חלוקת עמותות', branch_rates: 'תעריפים לפי סניף', hourly_bonuses: 'תוספות שעתיות',
  travel_mode: 'אופן נסיעות', travel_per_day: 'נסיעות ליום', travel_monthly_flat: 'נסיעות חודשי',
  travel_override: 'דריסת נסיעות', travel_allowance: 'החזר נסיעות', meal_vouchers: 'תווי מזון',
  recreation_annual: 'הבראה שנתית', bank_number: 'בנק', bank_branch: 'סניף בנק', bank_account: 'חשבון בנק', bank_account_holder: 'בעל/ת החשבון',
  pension_fund: 'קרן פנסיה', education_fund: 'קרן השתלמות', clock_aliases: 'כינויי שעון',
  pension_exempt: 'פטור פנסיה', bituach_leumi_exempt: 'פטור ביטוח לאומי', has_army_reserve_form: 'טופס מילואים',
  sick_pay_policy: 'מדיניות דמי מחלה', sick_balance_opening: 'יתרת מחלה פותחת',
  sick_daily_value_override: 'ערך יום מחלה', loans: 'הלוואות', bonuses: 'בונוסים',
  notes: 'הערות', permanent_note: 'הערה קבועה', is_active: 'פעיל', inactive_reason: 'סיבת אי-פעילות',
  work_days: 'ימי עבודה', on_maternity_leave: 'חופשת לידה', maternity_leave_from: 'לידה מתאריך',
  maternity_leave_to: 'לידה עד תאריך', is_pregnant: 'בהריון', due_date: 'צפי לידה',
  gave_birth_date: 'תאריך לידה', on_pregnancy_bedrest: 'שמירת הריון',
};

// Compare/store values in a stable, JSON-friendly shape (Dates → YYYY-MM-DD,
// ObjectIds → string) so the diff doesn't flag equal values as changed.
function normalizeForDiff(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map(normalizeForDiff);
  if (typeof v === 'object') {
    if (v._bsontype === 'ObjectID' || v.constructor?.name === 'ObjectId') return String(v);
    if (typeof v.toObject === 'function') return normalizeForDiff(v.toObject());
    const out = {};
    for (const k of Object.keys(v)) { if (k !== '_id' && k !== '$__' && k !== '$isNew') out[k] = normalizeForDiff(v[k]); }
    return out;
  }
  return v;
}

async function updateEmployee(req, res, next) {
  try {
    const emp = await Employee.findById(req.params.id);
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const fields = [
      'full_name', 'israeli_id', 'employee_number', 'is_freelancer', 'receives_salary',
      'branch_id', 'phone', 'email', 'address', 'gender',
      'position', 'start_date',
      'salary_type', 'salary_is_net', 'amuta_distribution', 'branch_rates', 'hourly_bonuses',
      'travel_mode', 'travel_per_day', 'travel_monthly_flat', 'travel_override',
      'travel_allowance', 'meal_vouchers', 'recreation_annual',
      'bank_number', 'bank_branch', 'bank_account', 'bank_account_holder', 'pension_fund', 'education_fund', 'clock_aliases',
      'pension_exempt', 'bituach_leumi_exempt', 'has_army_reserve_form',
      'sick_pay_policy', 'sick_balance_opening', 'sick_daily_value_override',
      'loans', 'bonuses', 'notes', 'permanent_note', 'is_active', 'inactive_reason', 'work_days',
      'on_maternity_leave', 'maternity_leave_from', 'maternity_leave_to',
      'is_pregnant', 'due_date', 'gave_birth_date', 'on_pregnancy_bedrest',
    ];
    // Branch managers may not write the employee card directly — every field
    // they change is captured as a pending request for the accountant/admin.
    if (req.user?.role === 'branch_manager') {
      const changes = [];
      for (const f of fields) {
        if (req.body[f] === undefined) continue;
        const before = emp[f];
        const after = req.body[f];
        if (JSON.stringify(normalizeForDiff(before)) === JSON.stringify(normalizeForDiff(after))) continue;
        changes.push({
          field: f,
          label: EMPLOYEE_FIELD_LABELS[f] || f,
          before: normalizeForDiff(before),
          after: normalizeForDiff(after),
        });
      }
      if (changes.length === 0) {
        return res.json({ employee: { ...emp.toObject(), id: emp._id }, no_changes: true });
      }
      const cr = await EmployeeChangeRequest.create({
        employee_id: emp._id,
        branch_id: emp.branch_id || null,
        employee_name: emp.full_name || '',
        changes,
        status: 'pending',
        requested_by: req.user?.id || null,
        requested_by_name: req.user?.full_name || '',
      });
      return res.json({
        pending_approval: true,
        request_id: String(cr._id),
        changes_count: changes.length,
        message: 'השינויים נשלחו לאישור הנהלת החשבונות',
      });
    }

    // Branches she could clock in at BEFORE the edit — a branch added here
    // (a new row in "תעריפים פר-סניף") means her finger has to reach that
    // branch's clock too, or she simply can't punch there.
    const branchesBefore = fingerprintSync.employeeBranchIds(emp).join(',');
    // Job title before the edit — a real change is what licenses userSync to
    // push a new role onto her login (see the service's comment).
    const positionBefore = emp.position || '';

    // Turning pay ON for a role-holder who was unpaid: stamp when it started,
    // so later it is clear the earlier months were unpaid by design.
    const startsGettingPaid = req.body.receives_salary === true && emp.receives_salary === false;

    for (const f of fields) {
      if (req.body[f] !== undefined) emp[f] = req.body[f];
    }
    if (startsGettingPaid && !emp.salary_started_at) emp.salary_started_at = new Date();
    if (req.body.amuta_distribution !== undefined) {
      emp.amuta_distribution = await resolveAmutaDistribution(req.body.amuta_distribution, emp.branch_id);
    }
    await emp.save(); // triggers post-save hook for orphan punch re-linking

    // Keep the login in step: create it if the ת"ז only arrived now, and mirror
    // name / branch / title / active. Never blocks saving the employee card.
    try {
      await userSync.syncEmployeeUser(emp, { positionChanged: (emp.position || '') !== positionBefore });
    } catch (e) {
      console.error('[userSync] employee update sync failed:', e.message);
    }

    if (fingerprintSync.employeeBranchIds(emp).join(',') !== branchesBefore) {
      // Fire-and-forget: queueing clock commands must not slow down (or fail)
      // saving the employee card.
      fingerprintSync.syncEmployee(emp._id, { createdBy: req.user?.id || null })
        .catch(e => console.error('[fingerprint] sync after employee update failed:', e.message));
    }

    res.json({ employee: { ...emp.toObject(), id: emp._id } });
  } catch (err) { next(err); }
}

/**
 * GET /api/payroll/employee-change-requests?status=pending
 * Pending employee-card edits awaiting accountant/admin approval. Branch
 * managers see (read-only) the ones they filed for their own branches.
 */
async function listEmployeeChangeRequests(req, res, next) {
  try {
    const filter = { status: req.query.status || 'pending' };
    const role = req.user?.role;
    if (role !== 'system_admin' && role !== 'accountant') {
      // A manager only sees their own branches' requests.
      const managed = (req.user?.managed_branch_ids || []).map(String);
      const fallback = req.user?.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length ? managed : fallback;
      if (!allowed.length) return res.json({ requests: [] });
      filter.branch_id = { $in: allowed };
    }
    const requests = await EmployeeChangeRequest.find(filter)
      .populate('branch_id', 'name')
      .sort({ created_at: -1 })
      .lean();
    res.json({
      requests: requests.map(r => ({
        ...r,
        id: String(r._id),
        branch_name: r.branch_id?.name || '',
      })),
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll/employee-change-requests/:id/decide  { approve: bool, note? }
 * Accountant/admin applies or rejects a manager's employee-card edit. On
 * approval the stored `after` values are written to the Employee.
 */
async function decideEmployeeChangeRequest(req, res, next) {
  try {
    const role = req.user?.role;
    if (role !== 'system_admin' && role !== 'accountant') {
      return res.status(403).json({ error: 'רק הנהלת חשבונות או מנהל מערכת יכולים לאשר' });
    }
    const cr = await EmployeeChangeRequest.findById(req.params.id);
    if (!cr) return res.status(404).json({ error: 'בקשה לא נמצאה' });
    if (cr.status !== 'pending') return res.status(400).json({ error: 'הבקשה כבר טופלה' });

    const approve = req.body?.approve !== false;
    if (approve) {
      const emp = await Employee.findById(cr.employee_id);
      if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });
      const positionBefore = emp.position || '';
      for (const ch of cr.changes) {
        if (ch.field === 'amuta_distribution') {
          emp.amuta_distribution = await resolveAmutaDistribution(ch.after, emp.branch_id);
        } else {
          emp[ch.field] = ch.after;
        }
      }
      await emp.save(); // post-save hook re-links orphan punches
      // A manager's approved edit reaches the login the same way a direct one does.
      try {
        await userSync.syncEmployeeUser(emp, { positionChanged: (emp.position || '') !== positionBefore });
      } catch (e) {
        console.error('[userSync] change-request sync failed:', e.message);
      }
    }
    cr.status = approve ? 'approved' : 'rejected';
    cr.reviewed_by = req.user?.id || null;
    cr.reviewed_at = new Date();
    cr.review_note = req.body?.note || '';
    await cr.save();
    res.json({ ok: true, status: cr.status });
  } catch (err) { next(err); }
}

async function removeEmployee(req, res, next) {
  try {
    const emp = await Employee.findById(req.params.id);
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });
    // Soft delete so historical punches/attendance still reference something.
    // Clear inactive_reason so a removed employee drops out of the monthly table
    // (only table-deactivated staff, which carry a reason, stay visible).
    emp.is_active = false;
    emp.inactive_reason = '';
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

    // Branch-scope enforcement
    const role = req.user?.role;
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length > 0 ? managed : fallback;
      if (!allowed.includes(String(branch))) {
        return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
      }
    }

    // Keep fixed-hours employees current before reading the grid, so their days
    // appear here the same as anyone else's (bounded by today, idempotent).
    try {
      await fixedSchedule.materializeMonth(month, { branchIds: [branch], userId: req.user?.id || null });
    } catch (e) {
      console.error('[attendance] fixed-schedule fill failed:', e.message);
    }

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

    // Accountant decisions for >2-punch days, so the grid shows approved days as
    // settled instead of flagging them red forever.
    const attResDocs = await PunchResolution.find({ date: { $regex: `^${ymPrefix}` }, status: 'approved' })
      .select('employee_id date labels status minutes').lean();
    const attRes = new Map();
    for (const r of attResDocs) {
      const k = String(r.employee_id);
      if (!attRes.has(k)) attRes.set(k, new Map());
      attRes.get(k).set(r.date, r);
    }

    const finalize = (bucket) => {
      const summarized = {};
      const empRes = bucket.employee_id ? (attRes.get(String(bucket.employee_id)) || new Map()) : new Map();
      for (const [dayKey, dayPunches] of Object.entries(bucket.days)) {
        const s = summarizeDay(dayPunches, empRes.get(dayKey));
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
          const s = summarizeDay(info.punches, empRes.get(dayKey));
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
// Shared computation for one employee's monthly hours report (the authoritative
// shape the client + all PDF/email renderers consume). Returns null if the
// employee or month is invalid. `user` is used only for the salary-month lookup.
async function computeHoursReportData(employeeId, month, user, opts = {}) {
    const emp = await Employee.findById(employeeId)
      .populate('branch_id', 'name')
      .lean();
    if (!emp) return null;
    const range = monthRange(month);
    if (!range) return null;

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
    // Accountant decisions for this employee's >2-punch days, so the report bills
    // exactly what the salary does.
    const resDocs = await PunchResolution.find({
      employee_id: emp._id, date: { $regex: `^${ymPrefix}` }, status: 'approved',
    }).lean();
    const resByDate = new Map(resDocs.map(r => [r.date, r]));
    const dayRows = Object.keys(days).sort().map(k => {
      const summary = summarizeDay(days[k], resByDate.get(k));
      // Tag each session with the branch where its first punch happened, and
      // mark the day with the set of non-home branches the employee visited.
      const branchesVisited = new Set();
      const allBranches = new Set();
      for (const p of days[k]) {
        const bid = String(p.branch_id);
        const name = branchById.get(bid) || 'אחר';
        allBranches.add(name);
        if (bid !== homeBranchId) branchesVisited.add(name);
      }
      return {
        date: k,
        ...summary,
        cross_branch_names: [...branchesVisited],   // empty array if all at home
        branch_names: [...allBranches],             // every branch worked that day
        branch_label: [...allBranches].join(' + '), // e.g. "משה דיין" or "משה דיין + הרצליה"
      };
    });

    const monthMinutes = dayRows.reduce((s, d) => s + d.total_minutes, 0);

    // Pull the AUTHORITATIVE per-day shortfall / extra-hours data from the same
    // payroll-month computation that drives the salary table's "היעדרות (שעות)"
    // column, so the report's missing/extra hours match the actual deduction and
    // extra pay exactly (commitment-based, grace 1h, excused, made-up, approval).
    let partial = null;
    let leaveSummary = null;
    let manualAbsenceEntries = [];
    try {
      const { fetchMonthData } = require('./payrollMonth.controller');
      const branchId = String(emp.branch_id?._id || emp.branch_id || '');
      // fetchMonthData computes the WHOLE branch — expensive. When rendering many
      // employees (branch/office hours report), reuse one result per branch via
      // opts.mdCache instead of recomputing per employee.
      let md;
      if (opts.mdCache && opts.mdCache.has(branchId)) md = opts.mdCache.get(branchId);
      else { md = await fetchMonthData({ month: ymPrefix, branch: branchId }, user); if (opts.mdCache) opts.mdCache.set(branchId, md); }
      const row = (md?.rows || []).find(r => String(r.employee_id) === String(emp._id));
      partial = row?.partial_absence || null;
      manualAbsenceEntries = row?.manual?.absence_entries || [];
      if (row) {
        // Monthly leave/absence tallies for the report's summary.
        const ntVal = (f) => (f && f.kind === 'number') ? f.amount : (f?.text || '');
        const openAbsence = (row.absence?.days || []).length;
        leaveSummary = {
          sick_days: Number(row.manual?.sick_days) || 0,
          absence_days: openAbsence,
          vacation_days: row.vacation_eff_days != null ? row.vacation_eff_days : (Number(row.manual?.vacation_days) || 0),
          holiday_days: row.holiday_pay_auto?.total_days || 0,
          miluim: ntVal(row.manual?.miluim),
        };
      }
      if (partial) {
        const shortByDate = new Map((partial.candidates || []).map(c => [c.date, c]));
        const extraByDate = new Map((partial.extra_candidates || []).map(c => [c.date, c]));
        // A day's shortfall is actually deducted only when it is unexcused AND
        // the month was not fully made up elsewhere (made_up caps net to zero).
        const monthMadeUp = !!partial.made_up;
        for (const d of dayRows) {
          const sc = shortByDate.get(d.date);
          if (sc) {
            d.committed_hours = sc.committed_h;
            d.shortfall_hours = sc.shortfall_h;
            d.shortfall_excused = !!sc.excused;
            d.shortfall_reason = sc.reason || '';
            // deducted | excused | madeup
            d.shortfall_status = sc.excused ? 'excused' : (monthMadeUp ? 'madeup' : 'deducted');
          }
          const ec = extraByDate.get(d.date);
          if (ec) {
            d.extra_hours = ec.hours;
            d.extra_kind = ec.kind;            // 'overage' | 'offday'
            d.extra_approved = !!ec.approved;
            d.extra_reason = ec.reason || '';
          }
        }
      }
    } catch (e) { /* non-fatal: report still renders without shortfall/extra */ }

    // Absence + leave days: a committed work day with NO punch should still show
    // up in the report, marked as absence — or, when the day is covered by
    // sick / vacation / holiday / reserve, with that note instead of a bare
    // "didn't show up". Only for employees with a schedule (commitment).
    try {
      const commitment = await EmployeeCommitment.findOne({ employee_id: emp._id }).lean();
      const ci = analyzeCommitment(commitment, filtered, ymPrefix);
      // Only days that have already PASSED count as absence — a committed day
      // still in the future (today or later this month) hasn't happened yet, so
      // it must not be marked absent.
      const todayKey = israelDateKey(new Date());
      const pastAbsent = (ci.absent_dates || []).filter(d => d < todayKey);
      if (ci.has_commitment && pastAbsent.length) {
        // Expand an inclusive [from,to] range into YYYY-MM-DD keys in this month.
        const expand = (from, to) => {
          const out = [];
          if (!from) return out;
          const e = to ? new Date(to) : new Date(from);
          for (let t = new Date(from); t <= e; t.setDate(t.getDate() + 1)) {
            const key = israelDateKey(t);
            if (key.startsWith(ymPrefix)) out.push(key);
          }
          return out;
        };
        // Kindergarten closures (holidays) → name.
        const holidayName = new Map();
        for (const h of await Holiday.find({ branch_id: emp.branch_id?._id || emp.branch_id }).lean()) {
          for (const k of expand(h.start_date, h.end_date)) if (!holidayName.has(k)) holidayName.set(k, h.name || 'חופשת גן');
        }
        // Approved sick / vacation requests → type + reason.
        const leaveByDate = new Map();
        const reqs = await EmployeeRequest.find({
          type: { $in: ['sick', 'vacation'] }, status: 'approved',
          $or: [{ employee_id: emp._id }, ...(emp.user_id ? [{ user_id: emp.user_id }] : [])],
        }).select('type from_date to_date reason').lean();
        for (const r of reqs) for (const k of expand(r.from_date, r.to_date)) if (!leaveByDate.has(k)) leaveByDate.set(k, { type: r.type, reason: r.reason || '' });
        // Office per-day marks from the salary month (reserve / explicit category).
        const entryByDate = new Map((manualAbsenceEntries || []).map(e => [e.date, e]));

        const LEAVE_LABEL = { sick: 'מחלה', vacation: 'חופשה', miluim: 'מילואים', holiday: 'חג / סגירת גן', absence: 'היעדרות — לא הגיע/ה' };
        // Non-deductible categories: sick/vacation/reserve map to a leave type;
        // 'approved' is a justified absence — still "היעדרות", but marked אושרה.
        const CAT_TO_TYPE = { sick: 'sick', vacation: 'vacation', reserve: 'miluim' };

        const existing = new Set(dayRows.map(d => d.date));
        for (const date of pastAbsent) {
          if (existing.has(date)) continue; // absent == no punch, but guard anyway
          const entry = entryByDate.get(date);
          const leave = leaveByDate.get(date);
          let type = 'absence', reason = '', approved = false;
          if (entry && CAT_TO_TYPE[entry.category]) { type = CAT_TO_TYPE[entry.category]; reason = entry.note || ''; }
          else if (entry && entry.category === 'approved') { approved = true; reason = entry.note || ''; }
          else if (leave) { type = leave.type; reason = leave.reason || ''; }
          else if (holidayName.has(date)) { type = 'holiday'; reason = holidayName.get(date); }
          const label = (type === 'absence' && approved) ? 'היעדרות (אושרה)' : LEAVE_LABEL[type];
          dayRows.push({
            date,
            is_absence: true,
            leave_type: type,
            absence_approved: approved,
            note: label + (reason ? ` — ${reason}` : ''),
            sessions: [], total_minutes: 0, total_hours: 0,
            first_in: null, last_out: null, incomplete: false,
            cross_branch_names: [], branch_names: [], branch_label: '',
          });
        }
        dayRows.sort((a, b) => a.date.localeCompare(b.date));
      }
    } catch (e) { /* non-fatal: report still renders without absence rows */ }

    return {
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
      // Authoritative shortfall / extra-hours summary (null if no commitment or
      // for hourly staff, where neither concept applies).
      partial_absence: partial && partial.has_commitment ? {
        has_commitment: true,
        committed_hours: partial.committed_hours,
        worked_hours: partial.worked_hours,
        deduct_hours: partial.effective_hours,        // hours actually deducted
        deduct_gross_hours: partial.deduct_gross_hours,
        deduction: partial.deduction,                 // ₪ deducted
        made_up: !!partial.made_up,
        extra_approved_hours: partial.extra_approved_hours,
        extra_hours: partial.extra_hours,
        extra_pay: partial.extra_pay,                 // ₪ extra paid
      } : null,
      leave_summary: leaveSummary,   // monthly מחלה/היעדרות/חופשה/חגים/מילואים tallies
      totals: {
        days_worked: dayRows.filter(d => !d.is_absence).length,
        absence_days_shown: dayRows.filter(d => d.is_absence).length,
        total_minutes: monthMinutes,
        total_hours: Math.round((monthMinutes / 60) * 100) / 100,
        incomplete_days: dayRows.filter(d => d.incomplete).length,
      },
    };
}

async function hoursReport(req, res, next) {
  try {
    const data = await computeHoursReportData(req.params.id, req.query.month, req.user);
    if (!data) return res.status(404).json({ error: 'עובד לא נמצא או חודש לא תקין' });
    res.json(data);
  } catch (err) { next(err); }
}

// ── Rich hours-report HTML — a server-side clone of the client's
// HoursReportDialog "ייצא PDF" output, so the report emailed/attached in the
// distribution flow looks EXACTLY like the one produced from the system. Takes
// one or more computeHoursReportData() objects (one A4 page per employee). ──
const HOURS_REPORT_CSS = `
  @page { size: A4 portrait; margin: 5mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  body { font-family: Arial, "Segoe UI", "Helvetica Neue", sans-serif; color: #111; margin: 0; padding: 0; background: #fff; }
  /* Each employee lives in a fixed A4-content-sized box (210−2×5mm wide,
     just under 297−2×5mm tall, overflow clipped). The PDF path renders ONE
     employee per document, so a document is physically exactly one page —
     no cross-employee bleed regardless of the browser's page-break support.
     The inner .fit is scaled (transform — reliable in print, unlike zoom,
     which broke fragmentation on Render's Chromium 131) to fill the box. */
  .emp-page { width: 200mm; height: 285mm; overflow: hidden; margin: 0 auto; padding: 0; }
  .emp-page .fit { width: 200mm; transform-origin: top right; }
  .doc-head { border: 1.5px solid #111; padding: 8px 12px; margin-bottom: 8px;
    display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; font-size: 10pt; }
  .doc-head .row { display: flex; gap: 6px; }
  .doc-head .row .lbl { font-weight: 700; }
  .doc-head .title-row { grid-column: 1/3; display: flex; justify-content: space-between; align-items: baseline;
    border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-bottom: 2px; }
  .doc-head .title-row .title { font-size: 14pt; font-weight: 800; }
  table.daily { width: 100%; border-collapse: collapse; font-size: 7pt; table-layout: fixed; }
  table.daily thead th { background: #f6f7f9 !important; border: 1px solid #c4cad3; padding: 1px 3px; font-weight: 700; font-size: 6.5pt; text-align: center; line-height: 1.05; color: #374151; }
  table.daily tbody td { border: 1px solid #e2e5e9; padding: 0.5px 3px; text-align: center; line-height: 1.05; }
  table.daily tbody td.date { text-align: right; font-weight: 500; white-space: nowrap; color: #374151; }
  table.daily tbody td.branch { white-space: nowrap; }
  table.daily tbody td.num { font-variant-numeric: tabular-nums; }
  table.daily tbody td.note { font-size: 6.5pt; color: #555; text-align: right; }
  table.daily tbody tr.incomplete td { background: #fffbeb !important; }
  table.daily tbody tr.incomplete td.note { color: #92400e; font-weight: 700; }
  table.daily tbody tr.r-ded td   { background: #fef2f2 !important; }
  table.daily tbody tr.r-extra td { background: #f0fdf4 !important; }
  table.daily tbody tr.r-exc td   { background: #eff6ff !important; }
  table.daily tbody tr.r-pend td  { background: #faf5ff !important; }
  table.daily td.ot { color: #92400e; font-weight: 600; }
  table.daily td.ot2 { color: #b91c1c; font-weight: 600; }
  table.daily td.miss-ded { color: #b91c1c; font-weight: 700; }
  table.daily td.miss-exc { color: #92400e; font-weight: 600; }
  table.daily td.miss-mu  { color: #1d4ed8; font-weight: 600; }
  table.daily td.extra-ok   { color: #15803d; font-weight: 700; }
  table.daily td.extra-pend { color: #7e22ce; font-weight: 600; }
  table.daily td.mute { color: #d1d5db; }
  .legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; font-size: 8pt; }
  .legend .item { display: flex; align-items: center; gap: 4px; }
  .legend .sw { width: 11px; height: 11px; border: 1px solid #999; border-radius: 2px; display: inline-block; }
  table.daily tbody tr { page-break-inside: avoid; }
  table.daily tfoot td { border: 1px solid #94a3b8; padding: 2px 4px; background: #f1f3f5 !important; font-weight: 700; text-align: center; }
  table.daily tfoot td.label { text-align: right; }
  .summary-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 12px; }
  .summary-grid .box { border: 1px solid #999; padding: 0; font-size: 9pt; }
  .summary-grid .box .box-title { font-weight: 800; padding: 4px 10px; text-align: center; background: #f3f4f6 !important; border-bottom: 1px solid #999; }
  .summary-grid .box .row { display: flex; justify-content: space-between; padding: 2px 10px; }
  .summary-grid .box .row .v { font-weight: 700; font-variant-numeric: tabular-nums; }
  .signatures { margin-top: 24px; display: grid; grid-template-columns: 1fr 1fr; gap: 32px; font-size: 9pt; }
  .signatures .sig { border-top: 1px solid #111; padding-top: 4px; text-align: center; color: #555; }
`;

function renderHoursReportDoc(reports) {
  const HD = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
  const dow = (ymd) => { if (!ymd) return ''; const [y, m, d] = ymd.split('-').map(Number); return 'יום ' + HD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };
  const fmt = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2).replace(/\.00$/, '');
  const fdate = (ymd) => { if (!ymd) return ''; const [y, m, d] = ymd.split('-'); return `${d}/${m}/${y}`; };
  // Short branch for the per-day cell — the segment after " - " (e.g.
  // "כפר סבא - משה דיין" → "משה דיין"), so it fits one line. Full name stays in
  // the header. Handles cross-branch days ("A + B").
  const shortBranch = (label) => (label || '—').split(' + ').map(s => { const p = s.split(' - '); return p[p.length - 1].trim(); }).join(' + ');
  const split = (t) => { t = Number(t) || 0; return { regular: Math.min(t, 8), ot125: Math.max(0, Math.min(t, 10) - 8), ot150: Math.max(0, t - 10) }; };
  const EXTRA_KIND = { overage: 'מעבר להתחייבות', offday: 'עבודה ביום חופש' };
  const now = new Date();
  const todayStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

  const empPage = (report) => {
    const [yy, mm] = (report.month || '').split('-');
    const monthLabel = `${mm}/${yy}`;
    const pa = report.partial_absence;
    // Commitment columns (מחויב/חוסר/תוספת) are תקן-only. Hourly staff are paid
    // per hour worked even if a schedule exists, so never show them.
    const hasCommit = !!pa && report.employee?.salary_type === 'global';
    const totals = { regular: 0, ot125: 0, ot150: 0, total: 0, committed: 0, shortfall: 0, extra: 0, days: 0 };
    // Tally the absence/leave rows actually shown so the bottom summary matches.
    const tally = { sick: 0, vacation: 0, miluim: 0, holiday: 0, absence: 0 };
    const colCount = hasCommit ? 11 : 8;
    const tbodyHtml = (report.days || []).map(d => {
      if (d.is_absence) {
        if (tally[d.leave_type] != null) tally[d.leave_type]++;
        const cls = (d.leave_type === 'absence' && !d.absence_approved) ? 'r-ded' : 'r-exc';
        const commitCell = hasCommit ? '<td class="num mute">—</td>' : '';
        const shExCells = hasCommit ? '<td class="num mute">—</td><td class="num mute">—</td>' : '';
        return `<tr class="${cls}"><td class="date">${fdate(d.date)} ${dow(d.date)}</td><td class="branch">—</td><td>—</td><td>—</td>
          <td class="num mute">—</td>${commitCell}<td class="num mute">—</td><td class="num mute">—</td>${shExCells}<td class="note">${d.note || 'היעדרות'}</td></tr>`;
      }
      const { regular, ot125, ot150 } = split(d.total_hours);
      totals.regular += regular; totals.ot125 += ot125; totals.ot150 += ot150;
      totals.total += Number(d.total_hours) || 0; totals.days += 1;
      const committed = d.committed_hours;
      if (committed != null) totals.committed += Number(committed) || 0;
      const sh = Number(d.shortfall_hours) || 0, ex = Number(d.extra_hours) || 0;
      totals.shortfall += sh; totals.extra += ex;
      const shClass = sh <= 0 ? 'mute' : d.shortfall_status === 'deducted' ? 'miss-ded' : d.shortfall_status === 'excused' ? 'miss-exc' : 'miss-mu';
      const exClass = ex <= 0 ? 'mute' : (d.extra_approved ? 'extra-ok' : 'extra-pend');
      const shTxt = sh <= 0 ? '—' : d.shortfall_status === 'deducted' ? `−${fmt(sh)}` : d.shortfall_status === 'excused' ? `${fmt(sh)} ✓` : `${fmt(sh)} ↺`;
      const exTxt = ex <= 0 ? '—' : (d.extra_approved ? `+${fmt(ex)} ✓` : `+${fmt(ex)} ⏳`);
      let rowClass = '';
      if (sh > 0 && d.shortfall_status === 'deducted') rowClass = 'r-ded';
      else if (ex > 0 && d.extra_approved) rowClass = 'r-extra';
      else if (sh > 0) rowClass = 'r-exc';
      else if (ex > 0) rowClass = 'r-pend';
      else if (d.incomplete) rowClass = 'incomplete';
      const noteParts = [];
      if (d.incomplete) noteParts.push('חסרה החתמה');
      if (hasCommit && sh > 0) {
        if (d.shortfall_status === 'deducted') noteParts.push(`חוסר מקוזז${d.shortfall_reason ? ' — ' + d.shortfall_reason : ''}`);
        else if (d.shortfall_status === 'excused') noteParts.push(`חוסר מאושר (ללא קיזוז)${d.shortfall_reason ? ' — ' + d.shortfall_reason : ''}`);
        else noteParts.push('חוסר הושלם בימים אחרים');
      }
      if (hasCommit && ex > 0) {
        const k = EXTRA_KIND[d.extra_kind] || 'שעות נוספות';
        noteParts.push(`${k}${d.extra_approved ? ' — שולמה תוספת' : ' — ממתין לאישור'}${d.extra_reason ? ' (' + d.extra_reason + ')' : ''}`);
      }
      const commitCell = hasCommit ? `<td class="num ${committed != null ? '' : 'mute'}">${committed != null ? fmt(committed) : '—'}</td>` : '';
      const shExCells = hasCommit ? `<td class="num ${shClass}">${shTxt}</td><td class="num ${exClass}">${exTxt}</td>` : '';
      return `<tr ${rowClass ? `class="${rowClass}"` : ''}><td class="date">${fdate(d.date)} ${dow(d.date)}</td>
        <td class="branch">${shortBranch(d.branch_label)}</td><td>${d.first_in || '—'}</td><td>${d.last_out || (d.incomplete ? '⚠' : '—')}</td>
        <td class="num">${fmt(d.total_hours || 0)}</td>${commitCell}
        <td class="num ${ot125 > 0 ? 'ot' : 'mute'}">${ot125 > 0 ? fmt(ot125) : '—'}</td>
        <td class="num ${ot150 > 0 ? 'ot2' : 'mute'}">${ot150 > 0 ? fmt(ot150) : '—'}</td>${shExCells}<td class="note">${noteParts.join(' • ')}</td></tr>`;
    }).join('');
    const avgHours = totals.days ? (totals.total / totals.days) : 0;
    const emp = report.employee || {};
    // Bottom summary counts the leave rows actually shown in the table.
    const leaveItems = [['ימי מחלה', tally.sick], ['ימי היעדרות', tally.absence], ['ימי חופשה', tally.vacation], ['דמי חגים (ימים)', tally.holiday], ['מילואים', tally.miluim]];
    // Table/inline layout (NOT grid/flex) — the email→PDF converter (GAS) only
    // renders tables reliably, so the emailed PDF matches this in-browser preview.
    const hcell = (l, v, ltr) => `<td style="padding:1.5px 8px;font-weight:600;width:15%;white-space:nowrap;border:1px solid #e2e5e9;color:#374151">${l}:</td><td style="padding:1.5px 8px;width:35%;border:1px solid #e2e5e9"${ltr ? ' dir="ltr"' : ''}>${v}</td>`;
    const money = (n, sign) => (n > 0 ? sign + '₪' + Math.round(n).toLocaleString('he-IL') : '₪0');
    const generalRows = [['ימי עבודה', totals.days], ['סה״כ שעות', fmt(totals.total)], ['שעות רגילות', fmt(totals.regular)], ['125% (יומי)', fmt(totals.ot125)], ['150% (יומי)', fmt(totals.ot150)]];
    const box2 = hasCommit
      ? ['חוסר וקיזוז שכר', [['שעות התחייבות', fmt(pa.committed_hours || 0)], ['שעות בפועל', fmt(pa.worked_hours || 0)], ['חוסר (ברוטו)', fmt(totals.shortfall)], ['שעות שקוזזו בפועל', fmt(pa.deduct_hours || 0), '#b91c1c'], ['סכום קיזוז', money(pa.deduction, '−'), '#b91c1c'], ...(pa.made_up ? [['↺ החוסר הושלם בימים אחרים — ללא קיזוז', '', '#1d4ed8']] : [])]]
      : ['סטטיסטיקה', [['ממוצע שעות יומי', fmt(avgHours)], ['ימים עם חסר החתמה', report.totals?.incomplete_days || 0]]];
    const box3 = ['תוספת שכר (מעבר להתחייבות)', [['שעות מעבר להתחייבות', fmt(pa?.extra_hours || 0)], ['שעות שאושרו לתשלום', fmt(pa?.extra_approved_hours || 0), '#15803d'], ['תוספת ששולמה', money(pa?.extra_pay, '+'), '#15803d']]];
    const box4 = ['מחלה · היעדרות · חופשה · מילואים', leaveItems.map(([l, v]) => [l, (v === 0 || v == null || v === '') ? '—' : v])];
    const boxCell = ([title, rows]) => `<td style="vertical-align:top;padding:0">
      <table width="100%" border="0" cellspacing="0" cellpadding="0" style="border:1px solid #64748b;border-collapse:collapse;font-size:7.5pt">
        <tr><td colspan="2" style="font-weight:700;background:#f6f7f9;text-align:center;padding:2px 6px;border-bottom:1px solid #64748b;font-size:8pt">${title}</td></tr>
        ${rows.map(([l, v, c]) => (v === '' || v == null)
          ? `<tr><td colspan="2" align="right" style="padding:1px 6px;border-bottom:1px solid #eee${c ? `;color:${c}` : ''}">${l}</td></tr>`
          : `<tr><td align="right" style="padding:1px 6px;border-bottom:1px solid #eee${c ? `;color:${c}` : ''}">${l}</td><td align="left" style="padding:1px 6px;border-bottom:1px solid #eee;font-weight:600${c ? `;color:${c}` : ''}">${v}</td></tr>`).join('')}
      </table></td>`;
    const legendItems = [['#fef2f2', 'חוסר שמקזז שכר'], ['#eff6ff', 'חוסר מאושר / הושלם בימים אחרים'], ['#f0fdf4', 'תוספת שאושרה ושולמה'], ['#faf5ff', 'תוספת ממתינה לאישור'], ['#fffbeb', 'החתמה חסרה']];
    return `<table style="width:100%;border:1px solid #64748b;border-collapse:collapse;margin-bottom:6px;font-size:8.5pt">
      <tr><td colspan="4" style="border-bottom:1px solid #e2e5e9;padding:3px 10px;font-size:11pt;font-weight:700;color:#1f2937">דוח שעות חודשי <span style="font-size:8pt;font-weight:400;color:#6b7280"> · תאריך הפקה: ${todayStr}</span></td></tr>
      <tr>${hcell('שם החברה', 'גן החלומות')}${hcell('חודש', monthLabel)}</tr>
      <tr>${hcell('שם העובד', emp.full_name || '—')}${hcell('ת״ז', emp.israeli_id || '—', true)}</tr>
      <tr>${hcell('סניף', emp.branch_name || '—')}${hcell('תפקיד', emp.position || '—')}</tr>
    </table>
    <table class="daily">${hasCommit
      ? '<colgroup><col style="width:10%"><col style="width:15%"><col style="width:7%"><col style="width:7%"><col style="width:7%"><col style="width:7%"><col style="width:7%"><col style="width:7%"><col style="width:8%"><col style="width:8%"><col style="width:17%"></colgroup>'
      : '<colgroup><col style="width:13%"><col style="width:19%"><col style="width:9%"><col style="width:9%"><col style="width:9%"><col style="width:9%"><col style="width:9%"><col style="width:23%"></colgroup>'}<thead><tr>
      <th>תאריך</th><th>סניף</th><th>שעת כניסה</th><th>שעת יציאה</th><th>סה״כ שעות</th>${hasCommit ? '<th>מחויב</th>' : ''}
      <th>125% (יומי)</th><th>150% (יומי)</th>${hasCommit ? '<th>חוסר<br><span style="font-weight:400;font-size:7pt">מקוזז שכר</span></th><th>תוספת<br><span style="font-weight:400;font-size:7pt">מעבר להתחייבות</span></th>' : ''}<th>הערות</th></tr></thead>
      <tbody>${tbodyHtml || `<tr><td colspan="${colCount}" style="padding:16px;text-align:center;color:#888">אין נתוני החתמה לחודש זה</td></tr>`}</tbody>
      <tfoot><tr><td class="label" colspan="4">סה״כ</td><td>${fmt(totals.total)}</td>${hasCommit ? `<td>${fmt(totals.committed)}</td>` : ''}
        <td>${fmt(totals.ot125)}</td><td>${fmt(totals.ot150)}</td>
        ${hasCommit ? `<td class="miss-ded">${totals.shortfall > 0 ? fmt(totals.shortfall) : '—'}</td><td class="extra-ok">${totals.extra > 0 ? fmt(totals.extra) : '—'}</td>` : ''}<td></td></tr></tfoot>
    </table>
    ${hasCommit ? `<div style="margin-top:4px;font-size:7pt;line-height:1.5">${legendItems.map(([bg, t]) => `<span style="background:${bg};border:1px solid #ccc;padding:1px 5px;border-radius:2px;margin-left:5px;white-space:nowrap">${t}</span>`).join(' ')}</div>` : ''}
    ${(() => {
      const boxes = hasCommit ? [['כללי', generalRows], box2, box4, box3] : [['כללי', generalRows], box2, box4];
      const w = (100 / boxes.length).toFixed(2);
      return `<table style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:5px;margin-top:6px">
      <colgroup>${boxes.map(() => `<col style="width:${w}%">`).join('')}</colgroup>
      <tr>${boxes.map(boxCell).join('')}</tr>
    </table>`;
    })()}
    <table width="100%" border="0" cellspacing="0" cellpadding="0" style="border:1px solid #64748b;border-collapse:collapse;margin-top:5px;font-size:7.5pt">
      <tr><td style="font-weight:700;background:#f6f7f9;text-align:center;padding:2px 6px;border-bottom:1px solid #64748b;font-size:8pt">הערות</td></tr>
      <tr><td style="height:22px;border-bottom:1px solid #e5e7eb"></td></tr>
      <tr><td style="height:22px"></td></tr>
    </table>
    <table style="width:100%;margin-top:12px"><tr>
      <td style="border-top:1px solid #555;text-align:center;padding-top:3px;width:45%;font-size:8.5pt;color:#555">חתימת העובד</td>
      <td style="width:10%"></td>
      <td style="border-top:1px solid #555;text-align:center;padding-top:3px;width:45%;font-size:8.5pt;color:#555">חתימת המנהל</td>
    </tr></table>`;
  };

  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><style>${HOURS_REPORT_CSS}</style></head>
<body>${reports.map((r, i) => `<div class="emp-page" style="${i < reports.length - 1 ? 'break-after:page;page-break-after:always;' : ''}break-inside:avoid;page-break-inside:avoid"><div class="fit">${empPage(r)}</div></div>`).join('')}
<script>
/* Fill the fixed page box: measure the content's natural (unscaled) height,
   pick scale z so it spans ~98% of the box (sparse months grow, capped ×2;
   dense months shrink to fit), widen the layout to 200mm/z so the SCALED
   width stays the printable 200mm, and apply transform:scale(z). transform
   does not affect layout, so offsetHeight measurements stay clean; iterate
   because the width change re-wraps lines. Runs in Chromium before
   page.pdf(); the GAS HTML fallback ignores scripts and box heights. */
(function () {
  var TARGET = 1060; /* px: ~285mm box at 96dpi × 0.985 safety */
  document.querySelectorAll('.emp-page .fit').forEach(function (fit) {
    var z = 1;
    for (var i = 0; i < 4; i++) {
      var h = fit.offsetHeight; /* layout height — unaffected by transform */
      if (!h) return;
      var nz = Math.max(0.5, Math.min(2, z * (TARGET / (h * z))));
      if (Math.abs(nz - z) < 0.02) { z = nz; break; }
      z = nz;
      fit.style.width = (200 / z) + 'mm';
    }
    fit.style.width = (200 / z) + 'mm';
    fit.style.transform = 'scale(' + z + ')';
  });
})();
</script></body></html>`;
}

// Render a rich hours-report PDF for a list of employee ids in a month.
// Employees are rendered in CHUNKS: each chunk is one combined HTML (employees
// separated by break-after:page — Chromium 131 honors it, verified live via
// /api/pdf-pagetest), and one browser renders all chunks page-by-page. A whole
// 25-employee branch in a single document spikes Chromium past the 512MB tier
// and the process gets OOM-killed mid-job (which is why sends used to vanish
// without a log); small chunks keep the peak bounded. Chunk PDFs are merged
// with pdf-lib. Returns a PDF Buffer, or null if nothing rendered.
// Pre-warm the expensive per-branch salary computation ONCE per branch, in
// parallel, then compute all employees in parallel off the cache — a
// sequential per-employee loop takes minutes for a large branch.
async function computeReportsParallel(employeeIds, month, user) {
  const { fetchMonthData } = require('./payrollMonth.controller');
  const mr = monthRange(month);
  const ymPrefix = mr ? `${mr.year}-${String(mr.month).padStart(2, '0')}` : month;
  const emps = await Employee.find({ _id: { $in: employeeIds } }).select('branch_id').lean();
  const branchIds = [...new Set(emps.map(e => String(e.branch_id?._id || e.branch_id || '')).filter(Boolean))];
  const mdCache = new Map();
  await Promise.all(branchIds.map(async bid => {
    try { mdCache.set(bid, await fetchMonthData({ month: ymPrefix, branch: bid }, user)); } catch (e) { /* skip branch */ }
  }));
  return (await Promise.all(employeeIds.map(id =>
    computeHoursReportData(id, month, user, { mdCache }).catch(() => null)))).filter(Boolean);
}

async function renderHoursPdfForEmployees(employeeIds, month, user) {
  const { htmlToPdfBatch } = require('../services/htmlPdf');
  const { PDFDocument } = require('pdf-lib');
  const reports = await computeReportsParallel(employeeIds, month, user);
  if (reports.length === 0) return null;
  // One document per employee (physically one page each) in one browser pass.
  const pdfs = await htmlToPdfBatch(reports.map(r => renderHoursReportDoc([r])));
  const merged = await PDFDocument.create();
  for (const buf of pdfs) {
    const src = await PDFDocument.load(buf);
    (await merged.copyPages(src, src.getPageIndices())).forEach(p => merged.addPage(p));
  }
  if (merged.getPageCount() !== reports.length) {
    console.error(`hours PDF page/employee mismatch: ${merged.getPageCount()} pages for ${reports.length} employees`);
  }
  return Buffer.from(await merged.save());
}

// HTML documents for a set of employees — ONE DOCUMENT PER EMPLOYEE. A
// single fixed-height clipped box renders to physically exactly one page, so
// cross-employee bleed is impossible. Multi-page chunk documents with
// transform-scaled boxes spiked Chromium past the 512MB tier (two OOMs in a
// row on the live loadtest), while per-employee documents — with the
// browser recycled every few documents (htmlPdf) and a real GC between
// instances — survived 40+ on the live instance.
async function buildHoursChunkHtmls(employeeIds, month, user) {
  const reports = await computeReportsParallel(employeeIds, month, user);
  return reports.map(r => renderHoursReportDoc([r]));
}

// Per-employee hours PDFs in ONE browser pass — for sends where every employee
// gets their own report attached. A browser launch per employee costs minutes
// across a big send; here all documents render page-by-page in one Chromium.
// Returns Map<employeeIdString, Buffer>.
async function renderHoursPdfPerEmployee(employeeIds, month, user) {
  const { htmlToPdfBatch } = require('../services/htmlPdf');
  const reports = await computeReportsParallel(employeeIds, month, user);
  if (reports.length === 0) return new Map();
  const pdfs = await htmlToPdfBatch(reports.map(r => renderHoursReportDoc([r])));
  const map = new Map();
  reports.forEach((r, i) => { if (r.employee?.id && pdfs[i]) map.set(String(r.employee.id), pdfs[i]); });
  return map;
}

// Build the email attachment for a rich hours report. Prefer a real
// server-rendered PDF (pixel-perfect, one page per employee); fall back to the
// GAS-converted HTML attachment if Chromium can't render (e.g. low memory).
// Returns an object to spread into dispatchEmail: { fileAttachments } | { attachments }.
async function hoursReportEmailAttachments(employeeIds, month, user, baseName) {
  try {
    const pdf = await renderHoursPdfForEmployees(employeeIds, month, user);
    if (!pdf) throw new Error('no pages rendered');
    return { fileAttachments: [{ filename: `${baseName}.pdf`, contentBase64: pdf.toString('base64'), contentType: 'application/pdf' }] };
  } catch (e) {
    console.error('hours PDF render failed → HTML fallback:', e.message);
    const html = await buildRichHoursHtml(employeeIds, month, user);
    return { attachments: [{ name: baseName, html }] };
  }
}

async function buildRichHoursHtml(employeeIds, month, user) {
  const { fetchMonthData } = require('./payrollMonth.controller');
  const mr = monthRange(month);
  const ymPrefix = mr ? `${mr.year}-${String(mr.month).padStart(2, '0')}` : month;
  // Pre-warm the expensive per-branch salary computation ONCE per branch, in
  // parallel — this is the bottleneck (fetchMonthData computes a whole branch).
  const emps = await Employee.find({ _id: { $in: employeeIds } }).select('branch_id').lean();
  const branchIds = [...new Set(emps.map(e => String(e.branch_id?._id || e.branch_id || '')).filter(Boolean))];
  const mdCache = new Map();
  await Promise.all(branchIds.map(async bid => {
    try { mdCache.set(bid, await fetchMonthData({ month: ymPrefix, branch: bid }, user)); } catch (e) { /* skip branch */ }
  }));
  // Then each employee's report reuses the cache — light + parallel.
  const reports = (await Promise.all(employeeIds.map(id =>
    computeHoursReportData(id, month, user, { mdCache }).catch(() => null)))).filter(Boolean);
  return renderHoursReportDoc(reports);
}

/**
 * GET /api/payroll/hours-report-bulk?month=YYYY-MM&branch=X|all
 * Monthly hours reports for ALL employees in scope, in one shot — for the
 * branch-grouped overview, bulk print, and the send-to-managers flow.
 */
async function hoursReportBulk(req, res, next) {
  try {
    const range = monthRange(req.query.month);
    if (!range) return res.status(400).json({ error: 'month must be YYYY-MM' });

    const role = req.user?.role;
    const reqBranch = req.query.branch && req.query.branch !== 'all' ? req.query.branch : null;
    const empFilter = { is_active: true };
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length ? managed : fallback;
      if (reqBranch && !allowed.includes(String(reqBranch))) {
        return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
      }
      empFilter.branch_id = reqBranch || { $in: allowed };
    } else if (reqBranch) {
      empFilter.branch_id = reqBranch;
    }

    const employees = await Employee.find(empFilter)
      .populate('branch_id', 'name').sort({ full_name: 1 }).lean();
    const branches = await Branch.find({}).select('_id name').lean();
    const branchById = new Map(branches.map(b => [String(b._id), b.name]));

    const punches = await Punch.find({
      employee_id: { $in: employees.map(e => e._id) },
      timestamp: { $gte: range.from, $lt: range.to },
      ignored: { $ne: true },
    }).sort({ timestamp: 1 }).lean();

    const ymPrefix = `${range.year}-${String(range.month).padStart(2, '0')}`;
    const byEmp = new Map();
    for (const p of punches) {
      const k = israelDateKey(new Date(p.timestamp));
      if (!k.startsWith(ymPrefix)) continue;
      const eid = String(p.employee_id);
      if (!byEmp.has(eid)) byEmp.set(eid, {});
      (byEmp.get(eid)[k] ||= []).push(p);
    }

    const reports = employees.map(emp => {
      const days = byEmp.get(String(emp._id)) || {};
      const homeBranchId = String(emp.branch_id?._id || emp.branch_id);
      const dayRows = Object.keys(days).sort().map(dk => {
        const summary = summarizeDay(days[dk]);
        const all = new Set();
        for (const p of days[dk]) all.add(branchById.get(String(p.branch_id)) || 'אחר');
        return { date: dk, ...summary, branch_label: [...all].join(' + '), branch_names: [...all] };
      });
      const monthMinutes = dayRows.reduce((s, d) => s + (d.total_minutes || 0), 0);
      return {
        employee: {
          id: String(emp._id), full_name: emp.full_name, israeli_id: emp.israeli_id || '',
          branch_id: homeBranchId, branch_name: emp.branch_id?.name || '—', salary_type: emp.salary_type,
        },
        days: dayRows,
        totals: {
          days_worked: dayRows.length,
          total_minutes: monthMinutes,
          total_hours: Math.round((monthMinutes / 60) * 100) / 100,
          incomplete_days: dayRows.filter(d => d.incomplete).length,
        },
      };
    });

    res.json({ month: ymPrefix, reports });
  } catch (err) { next(err); }
}

// Build a printable HTML hours report for a list of employee report objects.
function buildHoursReportHtml(title, ymPrefix, reports) {
  const f1 = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('he-IL');
  const fmtDate = (ymd) => { const [y, m, d] = ymd.split('-'); return `${d}/${m}/${y}`; };
  const empBlock = (r) => {
    const rows = r.days.map(d => {
      const t = Number(d.total_hours) || 0;
      const reg = Math.min(t, 8), ot125 = Math.max(0, Math.min(t, 10) - 8), ot150 = Math.max(0, t - 10);
      return `<tr${d.incomplete ? ' style="background:#fffbeb"' : ''}>
        <td style="text-align:right;font-weight:600;white-space:nowrap">${fmtDate(d.date)}</td>
        <td>${d.branch_label || '—'}</td><td>${d.first_in || '—'}</td><td>${d.last_out || (d.incomplete ? '⚠' : '—')}</td>
        <td>${f1(t)}</td><td>${f1(reg)}</td><td>${ot125 > 0 ? f1(ot125) : '—'}</td><td>${ot150 > 0 ? f1(ot150) : '—'}</td></tr>`;
    }).join('');
    return `<div style="page-break-inside:avoid;margin-bottom:10px">
      <div style="font-size:12px;border-bottom:1px solid #ccc;padding:3px 2px"><b>${r.employee.full_name}</b>${r.employee.israeli_id ? ` · ת״ז ${r.employee.israeli_id}` : ''}
        <span style="float:left;color:#1d4ed8;font-weight:700">סה״כ ${f1(r.totals.total_hours)} שעות · ${r.totals.days_worked} ימים${r.totals.incomplete_days ? ` · ${r.totals.incomplete_days} חסרים` : ''}</span></div>
      <table style="width:100%;border-collapse:collapse;font-size:10.5px;margin-top:3px">
        <thead><tr>${['תאריך', 'סניף', 'כניסה', 'יציאה', 'שעות', 'רגיל', '125%', '150%'].map(h => `<th style="background:#f3f4f6;border:1px solid #bbb;padding:3px 4px">${h}</th>`).join('')}</tr></thead>
        <tbody>${rows || '<tr><td colspan="8" style="text-align:center;color:#888;border:1px solid #ccc;padding:3px">אין החתמות</td></tr>'}</tbody>
      </table></div>`;
  };
  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<style>@page{size:A4 portrait;margin:10mm}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
body{font-family:Arial,sans-serif;color:#111;margin:0;padding:14px}h1{font-size:17px;text-align:center;margin:0 0 10px}
table td{border:1px solid #ccc;padding:2px 4px;text-align:center}</style></head><body>
<h1>דוח שעות — ${title} · ${ymPrefix}</h1>${reports.map(empBlock).join('')}</body></html>`;
}

// Build per-employee hours-report data ({employee, days, totals}) for a list of
// employees in a month — the exact shape buildHoursReportHtml() consumes. Reused
// by the manager send and the payslip-distribution flow.
async function buildHoursReportsForEmployees(employees, range, ymPrefix) {
  const branches = await Branch.find({}).select('_id name').lean();
  const branchById = new Map(branches.map(b => [String(b._id), b.name]));
  const punches = await Punch.find({
    employee_id: { $in: employees.map(e => e._id) },
    timestamp: { $gte: range.from, $lt: range.to }, ignored: { $ne: true },
  }).sort({ timestamp: 1 }).lean();
  const byEmp = new Map();
  for (const p of punches) {
    const k = israelDateKey(new Date(p.timestamp));
    if (!k.startsWith(ymPrefix)) continue;
    const eid = String(p.employee_id);
    if (!byEmp.has(eid)) byEmp.set(eid, {});
    (byEmp.get(eid)[k] ||= []).push(p);
  }
  return employees.map(emp => {
    const days = byEmp.get(String(emp._id)) || {};
    const dayRows = Object.keys(days).sort().map(dk => {
      const summary = summarizeDay(days[dk]);
      const all = new Set();
      for (const p of days[dk]) all.add(branchById.get(String(p.branch_id)) || 'אחר');
      return { date: dk, ...summary, branch_label: [...all].join(' + ') };
    });
    const min = dayRows.reduce((s, d) => s + (d.total_minutes || 0), 0);
    return {
      employee: { full_name: emp.full_name, israeli_id: emp.israeli_id || '' },
      days: dayRows,
      totals: { days_worked: dayRows.length, total_hours: Math.round(min / 60 * 100) / 100, incomplete_days: dayRows.filter(d => d.incomplete).length },
    };
  });
}

/**
 * POST /api/payroll/hours-report/send-managers  { month, branch? }
 * Emails each branch manager their branch's employees' hours reports.
 */
async function sendHoursReportsToManagers(req, res, next) {
  try {
    const month = req.body?.month || req.query.month;
    const range = monthRange(month);
    if (!range) return res.status(400).json({ error: 'month must be YYYY-MM' });
    const ymPrefix = `${range.year}-${String(range.month).padStart(2, '0')}`;

    const reqBranch = req.body?.branch && req.body.branch !== 'all' ? req.body.branch : null;
    const role = req.user?.role;
    let allowed = null;
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      allowed = managed.length ? managed : (req.user.branch_id ? [String(req.user.branch_id)] : []);
    }
    const branchFilter = { is_active: true };
    if (reqBranch) branchFilter._id = reqBranch;
    const branches = await Branch.find(branchFilter).select('_id name').lean();
    const branchById = new Map(branches.map(b => [String(b._id), b.name]));

    const results = [];
    for (const br of branches) {
      const bid = String(br._id);
      if (allowed && !allowed.includes(bid)) continue;
      const managers = await User.find({
        role: 'branch_manager',
        $or: [{ managed_branch_ids: br._id }, { branch_id: br._id }],
      }).select('email full_name').lean();
      const emails = [...new Set(managers.map(m => m.email).filter(Boolean))];
      const employees = await Employee.find({ branch_id: br._id, is_active: true }).populate('branch_id', 'name').sort({ full_name: 1 }).lean();
      if (employees.length === 0) { results.push({ branch: br.name, status: 'no_employees' }); continue; }
      if (emails.length === 0) { results.push({ branch: br.name, status: 'no_manager' }); continue; }

      const reports = await buildHoursReportsForEmployees(employees, range, ymPrefix);

      const html = buildHoursReportHtml(br.name, ymPrefix, reports);
      // Put the report both inline (works on every email provider) and as an
      // attachment (the Apps Script provider converts it to a PDF).
      const intro = `<div dir="rtl" style="font-family:Arial,sans-serif"><p>שלום,</p>
        <p>דוח שעות העובדים של סניף <b>${br.name}</b> לחודש ${ymPrefix} (${employees.length} עובדים) — מצורף וגם למטה.</p></div><hr>`;
      try {
        await dispatchEmail({
          to: emails,
          subject: `דוח שעות חודשי — ${br.name} — ${ymPrefix}`,
          html: intro + html,
          // ASCII filename — Gmail RFC-2047-encodes Hebrew attachment names and
          // some mail clients fail to decode them (gibberish name, no .pdf).
          attachments: [{ name: `hours-report-${ymPrefix}`, html }],
        });
        results.push({ branch: br.name, status: 'sent', managers: emails, employees: employees.length });
      } catch (e) {
        console.error('send hours report failed:', e.message);
        results.push({ branch: br.name, status: 'error', error: e.message });
      }
    }
    res.json({ month: ymPrefix, results });
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

    // Look up existing employees with these Israeli IDs — anywhere in the
    // system, not just the current branch. A clock at branch A can match an
    // employee whose home branch is B (cross-branch worker); we still want to
    // mark her as linked so the admin doesn't try to re-assign her.
    const existing = userIds.length
      ? await Employee.find({
          israeli_id: { $in: userIds },
        }).populate('branch_id', 'name').select('_id full_name israeli_id branch_id is_active').lean()
      : [];
    const byId = new Map(existing.map(e => [e.israeli_id, {
      _id: e._id, full_name: e.full_name, israeli_id: e.israeli_id,
      branch_name: e.branch_id?.name || '',
      is_active: e.is_active,
    }]));

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

/**
 * POST /api/payroll/employees/:id/enroll-clock  { branch_id }
 *
 * Register an EXISTING employee on another branch's physical clock, so a
 * cross-branch worker (already set up at her home branch) shows up at the new
 * branch too. Queues an `add_user` command for that branch's Pi agent, which
 * adds her ת"ז + name to the device. Her punches there then auto-link by ת"ז.
 *
 * NOTE: this registers the user id + name only — the fingerprint TEMPLATE is not
 * copied between devices (agent limitation), so she still enrolls her finger
 * once on the new device (or the clock accepts ID/card).
 */
async function enrollEmployeeToClock(req, res, next) {
  try {
    const { branch_id } = req.body || {};
    if (!branch_id) return res.status(400).json({ error: 'branch_id נדרש' });
    const emp = await Employee.findById(req.params.id).select('full_name israeli_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });
    if (!emp.israeli_id) return res.status(400).json({ error: 'לעובד/ת אין ת"ז — לא ניתן לשייך לשעון' });
    const branch = await Branch.findById(branch_id).select('name').lean();
    if (!branch) return res.status(404).json({ error: 'סניף לא נמצא' });
    const cmd = await AgentCommand.create({
      branch_id,
      type: 'add_user',
      payload: { israeli_id: emp.israeli_id, name: emp.full_name || '' },
      status: 'pending',
    });
    res.json({ ok: true, command_id: String(cmd._id), branch_name: branch.name, israeli_id: emp.israeli_id, full_name: emp.full_name });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll/employees/:id/export-template
 * Body: { branch_id }  — the SOURCE branch whose clock already has the
 * employee's fingerprint enrolled. Queues a READ-ONLY `export_template`
 * command to that branch's agent, which reads the templates off the device
 * and reports them back on the command result. Poll
 * GET /api/payroll/clock-commands/:command_id for the outcome. This writes to
 * NO device — it is the safe first half of cross-branch fingerprint copy.
 */
async function exportEmployeeTemplate(req, res, next) {
  try {
    const { branch_id } = req.body || {};
    if (!branch_id) return res.status(400).json({ error: 'branch_id (סניף מקור) נדרש' });
    const emp = await Employee.findById(req.params.id).select('full_name israeli_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });
    if (!emp.israeli_id) return res.status(400).json({ error: 'לעובד/ת אין ת"ז' });
    const branch = await Branch.findById(branch_id).select('name').lean();
    if (!branch) return res.status(404).json({ error: 'סניף מקור לא נמצא' });
    const cmd = await AgentCommand.create({
      branch_id,
      type: 'export_template',
      payload: { israeli_id: emp.israeli_id },
      status: 'pending',
      created_by: req.user?.id || null,
    });
    res.json({ ok: true, command_id: String(cmd._id), branch_name: branch.name, israeli_id: emp.israeli_id, full_name: emp.full_name });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll/employees/:id/import-template
 * Body: { target_branch_id, export_command_id }
 *
 * Second half of the cross-branch fingerprint copy: queues an
 * `import_template` (WRITE) command to the TARGET branch's agent. The
 * template blobs are taken server-side from a completed `export_template`
 * command (`export_command_id`) — the browser never carries them, and we
 * refuse blobs that weren't produced by an export for this same employee.
 */
async function importEmployeeTemplate(req, res, next) {
  try {
    const { target_branch_id, export_command_id } = req.body || {};
    if (!target_branch_id || !export_command_id) {
      return res.status(400).json({ error: 'target_branch_id ו-export_command_id נדרשים' });
    }
    const emp = await Employee.findById(req.params.id).select('full_name israeli_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });
    if (!emp.israeli_id) return res.status(400).json({ error: 'לעובד/ת אין ת"ז' });
    const branch = await Branch.findById(target_branch_id).select('name').lean();
    if (!branch) return res.status(404).json({ error: 'סניף יעד לא נמצא' });
    const exp = await AgentCommand.findById(export_command_id).lean();
    if (!exp || exp.type !== 'export_template') {
      return res.status(400).json({ error: 'פקודת החילוץ לא נמצאה' });
    }
    if (exp.status !== 'confirmed' || !Array.isArray(exp.result?.templates) || exp.result.templates.length === 0) {
      return res.status(400).json({ error: 'פקודת החילוץ לא הסתיימה בהצלחה או שאין בה טביעות' });
    }
    if (String(exp.result.israeli_id) !== String(emp.israeli_id)) {
      return res.status(400).json({ error: 'הטביעות שחולצו אינן של העובד/ת הזה/זו' });
    }
    if (String(exp.branch_id) === String(target_branch_id)) {
      return res.status(400).json({ error: 'סניף היעד זהה לסניף המקור' });
    }
    const cmd = await AgentCommand.create({
      branch_id: target_branch_id,
      type: 'import_template',
      payload: {
        israeli_id: emp.israeli_id,
        name: emp.full_name || '',
        templates: exp.result.templates,
      },
      status: 'pending',
      created_by: req.user?.id || null,
    });
    res.json({
      ok: true,
      command_id: String(cmd._id),
      branch_name: branch.name,
      israeli_id: emp.israeli_id,
      full_name: emp.full_name,
      finger_count: exp.result.templates.length,
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll/employees/:id/sync-fingerprint   { force? }
 *
 * "Send this employee's fingerprint to every branch she works at." Uses the
 * server-side copy when we have one; otherwise queues a read-only capture from
 * the most likely branch and completes the fan-out by itself once it arrives
 * (see services/fingerprintSync). Safe to press repeatedly — work already
 * queued is never duplicated.
 */
async function syncEmployeeFingerprint(req, res, next) {
  try {
    const result = await fingerprintSync.syncEmployee(req.params.id, {
      createdBy: req.user?.id || null,
      force: !!req.body?.force,
    });
    const HE = {
      employee_not_found: 'עובד לא נמצא',
      no_israeli_id: 'לעובד/ת אין ת"ז — לא ניתן לסנכרן טביעה',
      no_clock_branches: 'לעובד/ת אין סניפים עם שעון נוכחות',
      no_source_left: 'לא נמצאה טביעה באף אחד מהסניפים — יש להחתים אצבע פעם אחת במכשיר',
      capture_requested: 'נשלחה בקשת קריאת טביעה מהשעון — ההעתקה לשאר הסניפים תתבצע אוטומטית',
      push_queued: 'הטביעה נשלחת לשעונים של שאר הסניפים',
      up_to_date: 'הטביעה כבר קיימת בכל הסניפים הרלוונטיים',
    };
    if (result.status === 'employee_not_found') return res.status(404).json({ error: HE.employee_not_found });
    if (result.status === 'no_israeli_id') return res.status(400).json({ error: HE.no_israeli_id });
    res.json({ ok: true, ...result, message: HE[result.status] || result.status });
  } catch (err) { next(err); }
}

/**
 * GET /api/payroll/employees/:id/fingerprint-status
 * Where the employee's finger currently is, branch by branch. Blob-free.
 */
async function employeeFingerprintStatus(req, res, next) {
  try {
    const status = await fingerprintSync.statusFor(req.params.id);
    if (!status) return res.status(404).json({ error: 'עובד לא נמצא' });
    res.json({ ok: true, ...status });
  } catch (err) { next(err); }
}

/**
 * GET /api/payroll/clock-commands/:id
 * Poll the status/result of a queued AgentCommand so the UI can wait for a
 * Pi agent to finish. The heavy `templates[].b64` blobs are stripped — only a
 * light per-finger summary (fid/valid/size) is returned to the browser.
 */
async function getClockCommand(req, res, next) {
  try {
    const cmd = await AgentCommand.findById(req.params.id)
      .select('type status result last_error created_at completed_at branch_id')
      .lean();
    if (!cmd) return res.status(404).json({ error: 'פקודה לא נמצאה' });
    let result = cmd.result ? { ...cmd.result } : null;
    if (result && Array.isArray(result.templates)) {
      result.templates = result.templates.map(t => ({ fid: t.fid, valid: t.valid, size: t.size }));
    }
    res.json({
      ok: true,
      command_id: String(cmd._id),
      type: cmd.type,
      status: cmd.status,
      result,
      last_error: cmd.last_error || '',
      created_at: cmd.created_at,
      completed_at: cmd.completed_at,
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
async function createManualPunches(req, res, next, opts = {}) {
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

    // Multi-branch workers: the punch can be attributed to a chosen branch
    // (where the work happened); default to the employee's home branch.
    const punchBranchId = (req.body.branch_id && mongoose.isValidObjectId(req.body.branch_id))
      ? req.body.branch_id : emp.branch_id;

    // Approval chain (accountant is final). A salary-affecting punch entered by
    // a branch manager is NOT counted until the accountant approves it.
    //   - accountant / system_admin → approved immediately (final authority)
    //   - branch_manager            → pending_accountant (manager is the source)
    //   - employee (self-service)   → pending_manager
    // `opts.selfReport` marks the employee-portal path: whatever role the user
    // holds elsewhere, here she is an employee reporting her own punch, so it
    // always starts at the bottom of the approval chain.
    const role = opts.selfReport ? 'employee' : req.user?.role;
    const isFinal = role === 'system_admin' || role === 'accountant';
    const isManager = role === 'branch_manager';
    const approvalStatus = isFinal ? 'approved' : (isManager ? 'pending_accountant' : 'pending_manager');
    const decidedAt = isFinal ? new Date() : null;
    const decidedBy = isFinal ? req.user.id : null;
    const managerApprovedAt = (isFinal || isManager) ? new Date() : null;
    const managerApprovedBy = (isFinal || isManager) ? req.user.id : null;

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
        branch_id: punchBranchId,
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
        approval_status: approvalStatus,
        approval_decided_by: decidedBy,
        approval_decided_at: decidedAt,
        manager_approved_by: managerApprovedBy,
        manager_approved_at: managerApprovedAt,
      });
      created.push(punch);
    }

    res.json({ ok: true, created: created.length, punches: created });
  } catch (err) { next(err); }
}

/**
 * GET /api/payroll/punches/day?employee_id=&branch=&date=YYYY-MM-DD
 *
 * Returns raw punch records for a single day. Used by the inline punch
 * editor in AttendanceMonitor. Either employee_id (matched punches) or
 * branch (unlinked punches) must be provided.
 */
async function listPunchesForDay(req, res, next) {
  try {
    const { employee_id, branch, israeli_id, date } = req.query;
    if (!date) return res.status(400).json({ error: 'date=YYYY-MM-DD is required' });

    // Query a buffered ±2-day window in UTC and post-filter by the Israel
    // calendar date. Mirrors the approach used by attendanceByMonth so the
    // two views always agree about which punches belong to which day —
    // regardless of DST transitions or device time being a few hours off.
    const [y, m, d] = date.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, d - 1, 0, 0, 0));
    const to   = new Date(Date.UTC(y, m - 1, d + 2, 0, 0, 0));

    const filter = { timestamp: { $gte: from, $lt: to }, ignored: { $ne: true } };
    if (employee_id) {
      // Employee may have punched at any branch — don't constrain by branch.
      // ALSO include punches that arrived before the Employee record was
      // created/linked: those have employee_id: null but match by israeli_id.
      // attendanceByMonth groups them under this employee too, so the editor
      // needs to see them as well.
      const emp = await Employee.findById(employee_id).select('israeli_id').lean();
      const orClauses = [{ employee_id }];
      if (emp?.israeli_id) {
        orClauses.push({ employee_id: null, israeli_id: emp.israeli_id });
      }
      filter.$or = orClauses;
    } else if (israeli_id) {
      filter.israeli_id = israeli_id;
      // Unlinked rows are scoped to a single branch (multiple unmatched IDs
      // can collide across branches), so keep branch in the filter here.
      if (branch) filter.branch_id = branch;
    } else if (branch) {
      filter.branch_id = branch;
    }
    const raw = await Punch.find(filter)
      .populate('branch_id', 'name')
      .populate('approval_decided_by', 'full_name')
      .populate('created_by', 'full_name')
      .sort({ timestamp: 1 })
      .lean();

    // Keep only punches whose IL-local calendar date equals the requested date
    const punches = raw.filter(p => israelDateKey(new Date(p.timestamp)) === date);
    res.json({ punches });
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
    // Deleting a generated fixed-schedule punch means "she didn't work that
    // day". Record it as an exception, otherwise the next materialization pass
    // would simply put the day back.
    const wasGenerated = p.timestamp_source === 'fixed_schedule';
    const empId = p.employee_id;
    const date = fixedSchedule.ISR_DAY(p.timestamp);
    await p.deleteOne();
    if (wasGenerated && empId) {
      // Drop the day's other generated punch (in/out come as a pair) and mark
      // the date off so it stays deleted.
      const dayFrom = fixedSchedule.ilDateTime(date, '00:00');
      const dayTo = new Date(dayFrom.getTime() + 36 * 3600 * 1000);
      await Punch.deleteMany({
        employee_id: empId,
        timestamp_source: 'fixed_schedule',
        timestamp: { $gte: dayFrom, $lt: dayTo },
      });
      await fixedSchedule.markDayOff(empId, date);
    }
    res.json({ ok: true, id: req.params.id, fixed_schedule_day_off: wasGenerated ? date : null });
  } catch (err) { next(err); }
}

// --- Fixed hours (שעות קבועות) — employees who don't clock in -------------

/**
 * GET /api/payroll/fixed-schedules
 * Everyone who currently has a standing weekly schedule, plus the picker list
 * of employees who could be given one.
 */
async function listFixedSchedules(req, res, next) {
  try {
    const branchFilter = {};
    const role = req.user?.role;
    if (role === 'branch_manager') {
      const managed = (req.user?.managed_branch_ids || []).map(String);
      const scope = managed.length ? managed : (req.user?.branch_id ? [String(req.user.branch_id)] : []);
      if (scope.length) branchFilter.branch_id = { $in: scope };
    }
    const employees = await Employee.find({ ...branchFilter, is_active: true })
      .select('full_name branch_id position fixed_schedule')
      .populate('branch_id', 'name')
      .sort({ full_name: 1 })
      .lean();

    res.json({
      employees: employees.map(e => ({
        id: String(e._id),
        full_name: e.full_name,
        position: e.position || '',
        branch_id: e.branch_id?._id ? String(e.branch_id._id) : null,
        branch_name: e.branch_id?.name || '',
        fixed_schedule: e.fixed_schedule?.enabled
          ? {
            enabled: true,
            days: e.fixed_schedule.days || [],
            exceptions: e.fixed_schedule.exceptions || [],
            start_date: e.fixed_schedule.start_date || null,
            note: e.fixed_schedule.note || '',
          }
          : null,
      })),
    });
  } catch (err) { next(err); }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * PUT /api/payroll/fixed-schedules
 * Body: { employee_ids: [], schedule: { days:[{weekday,in,out}], start_date?, note? } }
 * Applies one weekly schedule to a set of employees. Existing per-date
 * exceptions are preserved — the weekly pattern is what's being set here.
 */
async function setFixedSchedules(req, res, next) {
  try {
    const { employee_ids, schedule } = req.body || {};
    if (!Array.isArray(employee_ids) || employee_ids.length === 0) {
      return res.status(400).json({ error: 'לא נבחרו עובדים' });
    }
    const days = (schedule?.days || [])
      .filter(d => Number.isInteger(Number(d.weekday)) && HHMM.test(d.in || '') && HHMM.test(d.out || ''))
      .map(d => ({ weekday: Number(d.weekday), in: d.in, out: d.out }));
    if (days.length === 0) return res.status(400).json({ error: 'יש להגדיר לפחות יום אחד עם שעת כניסה ויציאה' });
    for (const d of days) {
      if (d.out <= d.in) return res.status(400).json({ error: 'שעת היציאה חייבת להיות אחרי שעת הכניסה' });
    }

    const employees = await Employee.find({ _id: { $in: employee_ids } });
    for (const emp of employees) {
      emp.fixed_schedule = {
        enabled: true,
        days,
        exceptions: emp.fixed_schedule?.exceptions || [],
        start_date: schedule?.start_date || emp.fixed_schedule?.start_date || null,
        note: schedule?.note ?? (emp.fixed_schedule?.note || ''),
      };
      await emp.save();
    }

    // Fill the current month straight away so the change is visible.
    const month = fixedSchedule.todayIsrael().slice(0, 7);
    const empIds = employees.map(e => e._id);

    // Days already materialized this month still carry the OLD hours, and the
    // generator skips any day it has already filled — so changing 08:00-17:00
    // to 08:00-16:30 mid-month used to report "0 punches created" and leave the
    // month on the old times. Payroll would then pay hours nobody meant to set.
    // Clear this month's generated rows first so the new pattern actually lands.
    //
    // Three things are deliberately spared:
    //   • real clock reads and hand-typed entries — a different timestamp_source
    //   • days a human corrected by hand — schedule_edited
    //   • past months — the arrangement changed from now on, not retroactively
    const monthFrom = fixedSchedule.ilDateTime(`${month}-01`, '00:00');
    const monthTo = new Date(fixedSchedule.ilDateTime(`${month}-31`, '00:00').getTime() + 36 * 3600 * 1000);
    const editedDays = await Punch.find({
      employee_id: { $in: empIds },
      timestamp_source: 'fixed_schedule',
      schedule_edited: true,
      timestamp: { $gte: monthFrom, $lt: monthTo },
    }).select('employee_id timestamp').lean();
    const keep = new Set(editedDays.map(p => `${String(p.employee_id)}|${fixedSchedule.ISR_DAY(p.timestamp)}`));

    const generated = await Punch.find({
      employee_id: { $in: empIds },
      timestamp_source: 'fixed_schedule',
      timestamp: { $gte: monthFrom, $lt: monthTo },
    }).select('_id employee_id timestamp').lean();
    const staleIds = generated
      .filter(p => !keep.has(`${String(p.employee_id)}|${fixedSchedule.ISR_DAY(p.timestamp)}`))
      .map(p => p._id);
    if (staleIds.length) await Punch.deleteMany({ _id: { $in: staleIds } });

    const result = await fixedSchedule.materializeMonth(month, {
      employeeIds: empIds,
      userId: req.user?.id || null,
    });
    res.json({
      ok: true,
      updated: employees.length,
      punches_created: result.created,
      punches_refreshed: staleIds.length,
      days_kept_edited: keep.size,
      conflicts: result.conflicts,
    });
  } catch (err) { next(err); }
}

/**
 * DELETE /api/payroll/fixed-schedules/:employeeId
 * Stop generating for this employee. Already-generated punches are kept —
 * they are hours she actually worked; delete them from the grid if not.
 */
async function clearFixedSchedule(req, res, next) {
  try {
    const emp = await Employee.findById(req.params.employeeId);
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });
    emp.fixed_schedule = { ...(emp.fixed_schedule?.toObject?.() || emp.fixed_schedule || {}), enabled: false };
    await emp.save();
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll/fixed-schedules/:employeeId/exception
 * Body: { date, off?, in?, out?, note? } — one arbitrary day gets different
 * hours (or none). Regenerates that day so the change lands immediately.
 */
async function setFixedScheduleException(req, res, next) {
  try {
    const { date, off = false, in: inTime = '', out: outTime = '', note = '' } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'תאריך נדרש (YYYY-MM-DD)' });
    if (!off && (!HHMM.test(inTime) || !HHMM.test(outTime))) {
      return res.status(400).json({ error: 'הזן שעת כניסה ויציאה, או סמן "לא עבדה"' });
    }
    if (!off && outTime <= inTime) return res.status(400).json({ error: 'שעת היציאה חייבת להיות אחרי שעת הכניסה' });

    const emp = await Employee.findById(req.params.employeeId);
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });
    if (!emp.fixed_schedule?.enabled) return res.status(400).json({ error: 'לעובדת זו אין שעות קבועות' });

    const list = emp.fixed_schedule.exceptions || [];
    const idx = list.findIndex(e => e.date === date);
    const entry = { date, off: !!off, in: off ? '' : inTime, out: off ? '' : outTime, note };
    if (idx >= 0) list[idx] = entry; else list.push(entry);
    emp.fixed_schedule.exceptions = list;
    await emp.save();

    // Clear that day's generated punches so the new hours take effect. Real
    // clock punches are left untouched.
    const dayFrom = fixedSchedule.ilDateTime(date, '00:00');
    const dayTo = new Date(dayFrom.getTime() + 36 * 3600 * 1000);
    await Punch.deleteMany({
      employee_id: emp._id,
      timestamp_source: 'fixed_schedule',
      timestamp: { $gte: dayFrom, $lt: dayTo },
    });
    const result = await fixedSchedule.materializeMonth(date.slice(0, 7), {
      employeeIds: [emp._id], userId: req.user?.id || null,
    });
    res.json({ ok: true, punches_created: result.created });
  } catch (err) { next(err); }
}

/** DELETE /api/payroll/fixed-schedules/:employeeId/exception/:date */
async function removeFixedScheduleException(req, res, next) {
  try {
    const { employeeId, date } = req.params;
    const emp = await Employee.findById(employeeId);
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });
    emp.fixed_schedule.exceptions = (emp.fixed_schedule?.exceptions || []).filter(e => e.date !== date);
    await emp.save();
    const result = await fixedSchedule.materializeMonth(date.slice(0, 7), {
      employeeIds: [emp._id], userId: req.user?.id || null,
    });
    res.json({ ok: true, punches_created: result.created });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll/fixed-schedules/materialize  { month }
 * Manual "fill now" — the same pass that runs on every payroll load, exposed
 * for a month the accountant wants to backfill.
 */
async function materializeFixedSchedules(req, res, next) {
  try {
    const month = req.body?.month || fixedSchedule.todayIsrael().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM נדרש' });
    const result = await fixedSchedule.materializeMonth(month, { userId: req.user?.id || null });
    res.json({ ok: true, month, punches_created: result.created, conflicts: result.conflicts });
  } catch (err) { next(err); }
}

// --- Self-service manual-punch request (employee → manager approval) ----

/**
 * The Employee record behind the logged-in user. The explicit `user_id` link is
 * authoritative; ת"ז (including clock aliases) and finally the full name are
 * fallbacks, because plenty of employee cards predate the login link. Every
 * self-service endpoint resolves the same way — otherwise an employee can see
 * her punches but gets "אין רשומת עובד מקושרת" when she tries to report one.
 */
async function resolveSelfEmployee(req) {
  if (req.user?.id) {
    const byLink = await Employee.findOne({ user_id: req.user.id, is_active: true }).lean();
    if (byLink) return byLink;
  }
  const idNumber = fingerprintSync.normalizeId(req.user?.id_number || '');
  if (idNumber) {
    const byId = await Employee.findOne({
      is_active: true,
      $or: [{ israeli_id: idNumber }, { clock_aliases: idNumber }],
    }).lean();
    if (byId) return byId;
  }
  const name = (req.user?.full_name || '').trim();
  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const byName = await Employee.findOne({
      is_active: true,
      full_name: { $regex: new RegExp(`^${escaped}$`, 'i') },
    }).lean();
    if (byName) return byName;
  }
  return null;
}

/** Branches the employee may attribute her own punches to, with names. */
async function selfBranchOptions(emp) {
  const ids = fingerprintSync.employeeBranchIds(emp);
  if (!ids.length) return [];
  const branches = await Branch.find({ _id: { $in: ids } }).select('name').lean();
  const byId = Object.fromEntries(branches.map(b => [String(b._id), b.name]));
  return ids.filter(id => byId[id]).map(id => ({ branch_id: id, name: byId[id] }));
}

/**
 * POST /api/payroll/punch-requests
 * Body: { date, in_time, out_time, note, branch_id? }
 *
 * Used by employees through the self-service portal to report a missing
 * punch. Resolves employee_id from the authenticated user, sets the
 * punch's approval_status to 'pending', and surfaces it to the branch
 * manager via /api/payroll/punches/pending.
 *
 * `branch_id` matters for a cross-branch worker: a forgotten punch at קפלן must
 * be billed to קפלן's rate and land in קפלן's bucket, not at her home branch.
 * Only a branch she actually works at is accepted — the body is user input.
 */
async function createPunchRequest(req, res, next) {
  try {
    const emp = await resolveSelfEmployee(req);
    if (!emp) return res.status(404).json({ error: 'אין רשומת עובד מקושרת למשתמש' });
    req.body.employee_id = String(emp._id);

    const allowed = fingerprintSync.employeeBranchIds(emp);
    const wanted = req.body.branch_id ? String(req.body.branch_id) : '';
    if (wanted && !allowed.includes(wanted)) {
      return res.status(400).json({ error: 'לא ניתן לדווח החתמה על סניף שאינך עובד/ת בו' });
    }
    req.body.branch_id = wanted || String(emp.branch_id);

    await createManualPunches(req, res, next, { selfReport: true });
  } catch (err) { next(err); }
}

/**
 * GET /api/payroll/punches/pending?branch=<id>
 * Returns pending manual-punch requests awaiting approval. Branch managers
 * see only their own branch; system admins see all branches.
 */
async function listPendingPunches(req, res, next) {
  try {
    const role = req.user.role;
    const isFinal = role === 'system_admin' || role === 'accountant';
    const isManager = role === 'branch_manager' || role === 'system_admin';
    const managed = (req.user.managed_branch_ids || []).map(String);
    const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
    const allowed = managed.length > 0 ? managed : fallback;
    // The api client auto-appends ?branch=<selectedBranch> to GETs; 'all' is the
    // cross-branch sentinel and must NOT be used as a branch_id filter.
    const branchQ = req.query.branch && req.query.branch !== 'all' ? req.query.branch : null;

    const load = (filter) => Punch.find(filter)
      .populate('employee_id', 'full_name israeli_id')
      .populate('created_by', 'full_name')
      .sort({ timestamp: -1 }).lean();

    // Stage 1 (branch manager): employee-reported punches in managed branches.
    let pending_manager = [];
    if (isManager) {
      const f = { approval_status: { $in: ['pending_manager', 'pending'] } };
      if (role !== 'system_admin') {
        if (allowed.length === 0) return res.json({ pending_manager: [], pending_accountant: [] });
        f.branch_id = { $in: allowed };
      } else if (branchQ) { f.branch_id = branchQ; }
      pending_manager = await load(f);
    }
    // Stage 2 (accountant/admin): manager-approved or manager-created punches.
    let pending_accountant = [];
    if (isFinal) {
      const f = { approval_status: 'pending_accountant' };
      if (branchQ) f.branch_id = branchQ;
      pending_accountant = await load(f);
    }
    res.json({ pending_manager, pending_accountant });
  } catch (err) { next(err); }
}

/**
 * PATCH /api/payroll/punches/:id/approve
 * Body: { note }
 */
async function approvePunch(req, res, next) {
  try {
    const p = await Punch.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'punch not found' });
    const role = req.user.role;
    const isFinal = role === 'system_admin' || role === 'accountant';
    const isManager = role === 'branch_manager' || role === 'system_admin';
    const st = p.approval_status;

    if ((st === 'pending_manager' || st === 'pending') && isManager) {
      // Stage 1 → forward to the accountant.
      p.approval_status = 'pending_accountant';
      p.manager_approved_by = req.user.id;
      p.manager_approved_at = new Date();
    } else if (st === 'pending_accountant' && isFinal) {
      // Stage 2 → final approval; now counts in salary.
      p.approval_status = 'approved';
      p.approval_decided_by = req.user.id;
      p.approval_decided_at = new Date();
      p.approval_decided_note = req.body?.note || '';
    } else {
      return res.status(403).json({ error: 'אין הרשאה לאשר את ההחתמה בשלב זה' });
    }
    await p.save();
    res.json({ ok: true, punch: p });
  } catch (err) { next(err); }
}

/**
 * PATCH /api/payroll/punches/:id/reject
 * Body: { note }
 */
async function rejectPunch(req, res, next) {
  try {
    const p = await Punch.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'punch not found' });
    p.approval_status = 'rejected';
    p.approval_decided_by = req.user.id;
    p.approval_decided_at = new Date();
    p.approval_decided_note = req.body?.note || '';
    await p.save();
    res.json({ ok: true, punch: p });
  } catch (err) { next(err); }
}

/**
 * PATCH /api/payroll/punches/:id
 * Body: { timestamp?, state?, manual_note? }
 *
 * Edit a punch's timestamp / state. Manager-level only. We mark the punch
 * as 'approved' on edit (a manager intervening on a record is approving
 * the corrected value). Used for fixing typo'd manual punches and rare
 * clock-time corrections.
 */
async function editPunch(req, res, next) {
  try {
    const p = await Punch.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'punch not found' });
    if (req.body.timestamp) {
      const next = new Date(req.body.timestamp);
      // Correcting a generated row makes it a human decision. Mark it so the
      // regenerator leaves that day alone when the weekly hours change.
      if (p.timestamp_source === 'fixed_schedule' && next.getTime() !== p.timestamp.getTime()) {
        p.schedule_edited = true;
      }
      p.timestamp = next;
    }
    if (req.body.state != null) p.state = Number(req.body.state);
    if (req.body.manual_note != null) p.manual_note = String(req.body.manual_note);
    // Editing a still-pending manual punch advances it through the chain:
    // an accountant/admin edit approves it; a manager edit forwards it to the accountant.
    const pendingStates = ['pending', 'pending_manager', 'pending_accountant'];
    if (p.timestamp_source === 'manual' && pendingStates.includes(p.approval_status)) {
      const role = req.user.role;
      if (role === 'system_admin' || role === 'accountant') {
        p.approval_status = 'approved';
        p.approval_decided_by = req.user.id;
        p.approval_decided_at = new Date();
      } else {
        p.approval_status = 'pending_accountant';
        p.manager_approved_by = req.user.id;
        p.manager_approved_at = new Date();
      }
    }
    await p.save();
    res.json({ ok: true, punch: p });
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

    // Branch-scope enforcement
    const role = req.user?.role;
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length > 0 ? managed : fallback;
      if (!allowed.includes(String(branch))) {
        return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
      }
    }

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
        // תקן OT addition (overtime beyond commitment) for global employees.
        teken_ot: Math.round((b.components.teken_breakdown?.ot_part || 0)),
        teken_ot_exceeded: !!b.components.teken_breakdown?.exceeded_commitment,
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

    const emp = await resolveSelfEmployee(req);

    if (!emp) {
      return res.json({ punches: [], branches: [] });
    }

    // Branches she may report a forgotten punch for (home + per-branch rates).
    const branchOptions = await selfBranchOptions(emp);

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

    // Group into days with branch info + pending-approval marker
    const PENDING_STATES = new Set(['pending', 'pending_manager', 'pending_accountant']);
    const dayMap = {};
    for (const p of rawPunches) {
      const d = new Date(p.timestamp);
      const dateStr = d.toLocaleDateString('he-IL', { timeZone: IL_TZ });
      if (!dayMap[dateStr]) {
        dayMap[dateStr] = {
          times: [], branch: branchMap[String(p.branch_id)] || '', branch_id: String(p.branch_id), pending: false,
          // ISO form of the same day — the client needs it to pre-fill a
          // "complete my missing punch" report for that exact date.
          iso: israelDateKey(d),
          stage: null,
        };
      }
      dayMap[dateStr].times.push(d.toLocaleTimeString('he-IL', { timeZone: IL_TZ, hour: '2-digit', minute: '2-digit' }));
      dayMap[dateStr].branch = branchMap[String(p.branch_id)] || '';
      dayMap[dateStr].branch_id = String(p.branch_id);
      // Employee-reported punches arrive as 'pending_manager' and are then moved
      // to 'pending_accountant' — matching only the legacy 'pending' meant a
      // self-reported punch never showed as awaiting approval.
      if (PENDING_STATES.has(p.approval_status)) {
        dayMap[dateStr].pending = true;
        dayMap[dateStr].stage = p.approval_status === 'pending_accountant' ? 'accountant' : 'manager';
      }
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
      return {
        date, iso_date: data.iso,
        in_time: inTime, out_time: outTime,
        hours: hours ? `${hours}` : null,
        branch: data.branch,
        branch_id: data.branch_id,
        pending_approval: data.pending,
        approval_stage: data.stage,
        // A lone punch — the pair never completed, so this is exactly the day
        // the employee needs to report. Surfaced so she doesn't have to notice.
        incomplete: data.times.length === 1,
      };
    });

    res.json({
      punches, month, employee_name: emp.full_name,
      // Multi-branch worker: the portal shows a branch picker in the
      // "forgotten punch" form so the hours land on the right branch.
      branches: branchOptions,
      home_branch_id: String(emp.branch_id || ''),
      missing_count: punches.filter(p => p.incomplete).length,
    });
  } catch (err) { next(err); }
}

/**
 * GET /api/payroll/my-payslips
 * Returns payslip history for the logged-in employee (placeholder — returns empty for now)
 */
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי',
  'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/**
 * The employee's own payslips.
 *
 * The distribution has been archiving a SavedPayslip per employee per month
 * all along; this endpoint returned an empty array, so "התלושים שלי" was blank
 * no matter how many payslips had been sent. The bytes were there the whole
 * time — nothing read them.
 */
async function myPayslips(req, res, next) {
  try {
    const emp = await resolveSelfEmployee(req);
    if (!emp) return res.json({ payslips: [] });

    const saved = await SavedPayslip.find({ employee_id: emp._id })
      .select('-data')                       // the PDF is fetched per-row on demand
      .sort({ year_month: -1 })
      .lean();
    if (saved.length === 0) return res.json({ payslips: [] });

    // Net pay lives on the monthly payroll row, not on the archived PDF.
    const months = saved.map((p) => p.year_month);
    const rows = await PayrollMonth.find({ employee_id: emp._id, month: { $in: months } })
      .select('month net_pay estimated_total payslip_paid').lean();
    const byMonth = new Map(rows.map((r) => [r.month, r]));

    res.json({
      payslips: saved.map((p) => {
        const [y, m] = p.year_month.split('-');
        const row = byMonth.get(p.year_month);
        const net = row?.net_pay ?? row?.estimated_total ?? null;
        return {
          year_month: p.year_month,
          month_name: HE_MONTHS[Number(m) - 1] || m,
          year: y,
          net_amount: net != null ? Math.round(net).toLocaleString('he-IL') : '—',
          status: row?.payslip_paid ? 'paid' : 'pending',
          sent_at: p.sent_at,
          file_url: `/api/payroll/my-payslips/${p.year_month}/file`,
        };
      }),
    });
  } catch (err) { next(err); }
}

/**
 * GET /payroll/my-payslips/:ym/file
 * Scoped to the caller's own employee record — the month is the only input,
 * so there is no id to tamper with and no way to read someone else's payslip.
 */
async function myPayslipFile(req, res, next) {
  try {
    const emp = await resolveSelfEmployee(req);
    if (!emp) return res.status(404).json({ error: 'לא נמצא רישום עובד/ת עבור המשתמש' });
    const p = await SavedPayslip.findOne({ employee_id: emp._id, year_month: req.params.ym }).lean();
    if (!p?.data) return res.status(404).json({ error: 'לא נמצא תלוש לחודש הזה' });
    const buf = p.data.buffer ? Buffer.from(p.data.buffer) : Buffer.from(p.data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="payslip-${req.params.ym}.pdf"`);
    res.send(buf);
  } catch (err) { next(err); }
}

/**
 * GET /api/payroll/my-form-101
 *
 * The employee's own tax forms, and whether this year's is filed.
 *
 * The point of the endpoint is the ASK: an employee has no way to know the
 * form is outstanding until a payroll goes out with the wrong deduction, and
 * "we'll tell you when we need it" is how 72 of 83 records ended up without
 * one. The portal can now say it, in the one place the person already visits
 * for their payslip.
 */
async function myForm101(req, res, next) {
  try {
    const emp = await resolveSelfEmployee(req);
    if (!emp) return res.json({ forms: [], tax_year: form101.currentTaxYear(), has_current: false });

    const docs = await EmployeeDocument.find({ employee_id: emp._id, doc_type: 'form_101' })
      .select('tax_year created_at file_name source self_uploaded')
      .sort({ tax_year: -1, created_at: -1 })
      .lean();

    const year = form101.currentTaxYear();
    res.json({
      tax_year: year,
      has_current: docs.some(d => d.tax_year === year),
      forms: docs.map(d => ({
        id: String(d._id),
        tax_year: d.tax_year,
        created_at: d.created_at,
        file_name: d.file_name || '',
        source: d.source || 'upload',
        self_uploaded: !!d.self_uploaded,
        file_url: `/api/payroll/my-form-101/${d._id}/file`,
      })),
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll/my-form-101
 * Body: { file_data(base64), file_name?, file_mimetype?, tax_year? }
 *
 * The employee files their own form. The year is read off the document when it
 * isn't given, and a failed read never blocks the upload — a form on file for
 * the wrong year is fixable, a form the person gave up on sending is not.
 */
async function uploadMyForm101(req, res, next) {
  try {
    const emp = await resolveSelfEmployee(req);
    if (!emp) return res.status(404).json({ error: 'לא נמצא רישום עובד/ת עבור המשתמש' });

    const { file_data, file_name, file_mimetype, tax_year } = req.body || {};
    if (!file_data) return res.status(400).json({ error: 'נדרש קובץ' });
    if (Buffer.byteLength(file_data, 'utf8') > 8 * 1024 * 1024) {
      return res.status(413).json({ error: 'הקובץ גדול מדי (מקסימום 8MB)' });
    }

    let scan = {};
    let year = Number(tax_year) || null;
    if (!year) {
      try {
        scan = await scanForm101(file_data, file_name, file_mimetype);
        year = scan.tax_year || null;
      } catch { scan = {}; }
    }
    year = year || form101.currentTaxYear();

    const existing = await EmployeeDocument.findOne({
      employee_id: emp._id, doc_type: 'form_101', tax_year: year,
    }).select('_id').lean();
    if (existing) {
      return res.status(409).json({ error: `כבר קיים טופס 101 לשנת ${year}. לעדכון פנה/י להנהלה.` });
    }

    const doc = await form101.attachForm(emp, {
      data: file_data, name: file_name, mimetype: file_mimetype,
    }, {
      scan,
      taxYear: year,
      source: 'upload',
      matchBasis: 'manual',
      selfUploaded: true,
      createdBy: req.user?.id || null,
      hash: form101.hashFile(file_data),
      description: 'הועלה על ידי העובד/ת מהפורטל',
    });

    res.status(201).json({ id: String(doc._id), tax_year: year });
  } catch (err) { next(err); }
}

/**
 * GET /api/payroll/my-form-101/:id/file
 * Scoped to the caller's own employee record — an id from someone else's file
 * simply does not resolve.
 */
async function myForm101File(req, res, next) {
  try {
    const emp = await resolveSelfEmployee(req);
    if (!emp) return res.status(404).json({ error: 'לא נמצא רישום עובד/ת עבור המשתמש' });
    const d = await EmployeeDocument.findOne({
      _id: req.params.id, employee_id: emp._id, doc_type: 'form_101',
    }).select('file_data file_name file_mimetype name').lean();
    if (!d?.file_data) return res.status(404).json({ error: 'אין קובץ' });
    res.json({ data: d.file_data, name: d.file_name || d.name || 'טופס 101', mimetype: d.file_mimetype || 'application/pdf' });
  } catch (err) { next(err); }
}

module.exports = {
  myPayslipFile,
  myForm101,
  uploadMyForm101,
  myForm101File,
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  removeEmployee,
  attendanceByMonth,
  hoursReport,
  hoursReportBulk,
  sendHoursReportsToManagers,
  listClockUsers,
  assignIsraeliIds,
  enrollEmployeeToClock,
  exportEmployeeTemplate,
  importEmployeeTemplate,
  syncEmployeeFingerprint,
  employeeFingerprintStatus,
  listEmployeeChangeRequests,
  decideEmployeeChangeRequest,
  getClockCommand,
  salaryForEmployee,
  salarySummary,
  createManualPunches,
  createPunchRequest,
  listPendingPunches,
  listPunchesForDay,
  approvePunch,
  rejectPunch,
  editPunch,
  deletePunch,
  listFixedSchedules,
  setFixedSchedules,
  clearFixedSchedule,
  setFixedScheduleException,
  removeFixedScheduleException,
  materializeFixedSchedules,
  mySalaryPreview,
  myPunches,
  myPayslips,
  // Reused by the payslip-distribution flow (payslipAudit.controller):
  buildHoursReportHtml,
  buildHoursReportsForEmployees,
  computeHoursReportData,
  renderHoursReportDoc,
  buildRichHoursHtml,
  hoursReportEmailAttachments,
  renderHoursPdfForEmployees,
  renderHoursPdfPerEmployee,
  buildHoursChunkHtmls,
  monthRange,
};
