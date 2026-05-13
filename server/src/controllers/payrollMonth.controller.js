/**
 * Controller for the monthly payroll table — the one with per-amuta column
 * groups and manual fields (sick, vacation, gift card, etc.). Backed by the
 * `PayrollMonth` collection plus on-the-fly recomputation via payrollCalc.
 */
const {
  PayrollMonth, PayrollPresetOption, PayrollCustomColumn, SalaryAdjustment,
  Employee, Branch, Amuta, Punch, EmployeeCommitment,
} = require('../models');
const { calculateMonthlySalary } = require('../services/payrollCalc');
const { analyzeCommitment } = require('../services/commitmentAnalysis');
const { computeHolidayPay } = require('../services/israeliHolidays');
const { parseCibusReport } = require('../services/payslipAudit/cibusParser');

function parseMonthRange(monthYM) {
  const [y, m] = monthYM.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - 3 * 3600 * 1000);
  const to   = new Date(Date.UTC(y, m,     2, 0, 0, 0));
  return { from, to };
}

/**
 * GET /api/payroll-month?month=YYYY-MM&branch=<id>&amuta=<id>
 *
 * Filters:
 *   - branch=<id>            single-branch view
 *   - amuta=<id>             all branches belonging to that amuta (merged)
 *   - (neither)              all branches in the org
 *
 * Returns: { rows: [...], amutot: [...], branches: [...], totals: {...} }
 * Each row contains the auto-calculated breakdown AND the persisted manual fields.
 */
async function getMonth(req, res, next) {
  try {
    const { month, branch, amuta } = req.query;
    if (!month) return res.status(400).json({ error: 'month=YYYY-MM is required' });

    // Determine which branches are in scope. Sentinel values that mean
    // "no filter": empty string, the literal 'all', or 'undefined'.
    const branchFilter = {};
    const isAllBranches = !branch || branch === 'all' || branch === 'undefined';
    if (!isAllBranches) {
      branchFilter._id = branch;
    } else if (amuta) {
      branchFilter.amuta_id = amuta;
    }
    // Enforce per-user branch scope: non-admins are restricted to the
    // branches they manage. system_admin / accountant see everything.
    const role = req.user?.role;
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length > 0 ? managed : fallback;
      if (branchFilter._id && !allowed.includes(String(branchFilter._id))) {
        // User asked for a branch they don't manage — return empty
        return res.json({
          rows: [], amutot: [], branches: [], branches_in_view: [], custom_columns: [], totals: {},
        });
      }
      if (!branchFilter._id) {
        branchFilter._id = { $in: allowed };
      }
    }
    const branches = await Branch.find(branchFilter).select('_id name amuta_id').lean();
    if (branches.length === 0) {
      return res.json({
        rows: [], amutot: [], branches: [], branches_in_view: [], custom_columns: [], totals: {},
      });
    }
    const branchIds = branches.map(b => b._id);

    // Pull employees from those branches
    const employees = await Employee.find({ branch_id: { $in: branchIds }, is_active: true })
      .populate('amuta_distribution.amuta_id', 'name short_name')
      .sort({ full_name: 1 })
      .lean();

    // Pull amutot to render column groups
    const amutot = await Amuta.find({ is_active: true }).sort({ name: 1 }).lean();

    // Pull custom columns: both month-specific and "*" (all months)
    const customColumns = await PayrollCustomColumn.find({
      is_active: true,
      $or: [{ month }, { month: '*' }],
    }).sort({ position: 1, created_at: 1 }).lean();

    // Build branch→amuta map for payrollCalc
    const allBranches = await Branch.find({}).select('_id amuta_id').lean();
    const branchAmutaMap = new Map(
      allBranches
        .filter(b => b.amuta_id)
        .map(b => [String(b._id), String(b.amuta_id)])
    );

    // Pull punches for all in-scope employees
    const { from, to } = parseMonthRange(month);
    const punches = await Punch.find({
      employee_id: { $in: employees.map(e => e._id) },
      timestamp: { $gte: from, $lt: to },
      ignored: { $ne: true },
    }).sort({ timestamp: 1 }).lean();

    const punchesByEmp = new Map();
    for (const p of punches) {
      const k = String(p.employee_id);
      if (!punchesByEmp.has(k)) punchesByEmp.set(k, []);
      punchesByEmp.get(k).push(p);
    }

    // Pull any existing PayrollMonth rows for these employees
    const existing = await PayrollMonth.find({
      employee_id: { $in: employees.map(e => e._id) },
      month,
    }).populate('manual.advance_deduction_preset_id').lean();
    const existingByEmp = new Map(existing.map(r => [String(r.employee_id), r]));

    // Salary adjustments — managers' ad-hoc credits/debits/hour corrections
    const adjustments = await SalaryAdjustment.find({
      employee_id: { $in: employees.map(e => e._id) },
      month,
      status: { $ne: 'rejected' },
    }).populate('created_by', 'full_name').sort({ created_at: -1 }).lean();

    // Commitments (contracted weekly schedules) — for absence detection
    const commitments = await EmployeeCommitment.find({
      employee_id: { $in: employees.map(e => e._id) },
    }).lean();
    const commitmentByEmp = new Map(commitments.map(c => [String(c.employee_id), c]));
    const adjByEmp = new Map();
    for (const adj of adjustments) {
      const k = String(adj.employee_id);
      if (!adjByEmp.has(k)) adjByEmp.set(k, []);
      adjByEmp.get(k).push({
        id: String(adj._id),
        type: adj.type,
        amount: adj.amount,
        hours: adj.hours,
        reason: adj.reason,
        status: adj.status,
        created_by_name: adj.created_by?.full_name || '',
        created_at: adj.created_at,
      });
    }

    // Need ALL branches (not just in-scope) so cross-branch hours can still
    // be shown in the table — an employee from branch A may have punched at B.
    const allBranchesData = await Branch.find({}).select('_id name amuta_id').sort({ name: 1 }).lean();
    const branchNameById = new Map(allBranchesData.map(b => [String(b._id), b.name]));

    const rows = employees.map(emp => {
      const empPunches = punchesByEmp.get(String(emp._id)) || [];
      const breakdown = calculateMonthlySalary(emp, empPunches, month, { branchAmutaMap });
      const row = existingByEmp.get(String(emp._id));
      const manual = row?.manual || {};
      // Commitment analysis: count auto-absences (committed days she didn't punch,
      // minus off-day workdays that offset). Only counts countable (approved/auto)
      // punches — same filter calculateMonthlySalary uses.
      const countablePunches = empPunches.filter(p => {
        const s = p.approval_status || 'auto';
        return s === 'auto' || s === 'approved';
      });
      const commitmentInfo = analyzeCommitment(commitmentByEmp.get(String(emp._id)), countablePunches, month);

      // Holiday pay (דמי חגים) — auto-computed only for hourly employees
      // who pass tenure + guard-day rules. Manager can still override via
      // manual.holiday_pay; we expose both so the UI can show the breakdown.
      const hourlyRate = emp.amuta_distribution?.[0]?.hourly_rate || 0;
      const avgDailyHours = (breakdown.hours.days_worked > 0)
        ? (breakdown.hours.total / breakdown.hours.days_worked)
        : 8;
      const holidayPayInfo = computeHolidayPay({
        employee: emp,
        monthYM: month,
        punches: countablePunches,
        commitment: commitmentByEmp.get(String(emp._id)),
        hourlyRate,
        avgDailyHours,
      });
      const empAdjustments = adjByEmp.get(String(emp._id)) || [];
      // Aggregate adjustments
      const adjTotals = empAdjustments.reduce((acc, a) => {
        if (a.status !== 'approved') return acc;
        if (a.type === 'money_add' || a.type === 'purchase_reimburse' || a.type === 'travel_add') acc.money_add += Number(a.amount) || 0;
        else if (a.type === 'money_deduct' || a.type === 'advance_request' || a.type === 'loan_request') acc.money_deduct += Math.abs(Number(a.amount) || 0);
        else if (a.type === 'hours_add' || a.type === 'hour_correction') acc.hours_delta += Number(a.hours) || 0;
        else if (a.type === 'hours_deduct') acc.hours_delta -= Math.abs(Number(a.hours) || 0);
        else if (a.type === 'other') acc.money_add += Number(a.amount) || 0;
        return acc;
      }, { money_add: 0, money_deduct: 0, hours_delta: 0 });
      return {
        employee_id: String(emp._id),
        full_name: emp.full_name,
        israeli_id: emp.israeli_id || '',
        branch_id: String(emp.branch_id),
        branch_name: branchNameById.get(String(emp.branch_id)) || '',
        position: emp.position || '',
        salary_type: emp.salary_type,
        salary_is_net: !!emp.salary_is_net,
        // Travel config so UI can show "16₪/day" inline
        travel_mode: emp.travel_mode || 'per_day',
        travel_per_day: emp.travel_per_day || 0,
        travel_monthly_flat: emp.travel_monthly_flat || 0,
        breakdown,
        manual: {
          sick_days:      manual.sick_days || 0,
          absence_days:   manual.absence_days || 0,
          vacation_days:  manual.vacation_days || 0,
          holiday_pay:    manual.holiday_pay || 0,
          advance_deduction_preset_id: manual.advance_deduction_preset_id?._id || manual.advance_deduction_preset_id || null,
          advance_deduction_preset: manual.advance_deduction_preset_id?.label
            ? {
                id: String(manual.advance_deduction_preset_id._id),
                label: manual.advance_deduction_preset_id.label,
                action: manual.advance_deduction_preset_id.action,
              }
            : null,
          advance_deduction_text: manual.advance_deduction_text || '',
          gift_card:   manual.gift_card   || { kind: 'empty', amount: null, text: '' },
          recreation:  manual.recreation  || { kind: 'empty', amount: null, text: '' },
          cibus:       manual.cibus       || { kind: 'empty', amount: null, text: '' },
          miluim:      manual.miluim      || { kind: 'empty', amount: null, text: '' },
          travel_override: manual.travel_override ?? null,
          notes: manual.notes || '',
          custom_values: manual.custom_values || {},
        },
        adjustments: empAdjustments,
        adj_totals: adjTotals,
        commitment: commitmentInfo.has_commitment ? {
          committed_days: commitmentInfo.committed_dates.length,
          off_days: commitmentInfo.off_dates.length,
          absent_days: commitmentInfo.absent_dates,         // ymd[] for tooltip
          off_day_workdays: commitmentInfo.off_day_workdays, // ymd[] of compensation
          net_absent: commitmentInfo.net_absent,
        } : null,
        holiday_pay_auto: {
          total_days: holidayPayInfo.total_days,
          total_pay: holidayPayInfo.total_pay,
          eligible: holidayPayInfo.eligible_days,
          ineligible: holidayPayInfo.ineligible_days,
        },
        loans_info: (() => {
          const list = Array.isArray(emp.loans) ? emp.loans : [];
          const active = list.filter(l => (l.installments_paid || 0) < (l.installments_total || 0));
          const monthDeduction = active.reduce((s, l) => s + (Number(l.installment_amount) || 0), 0);
          return {
            count: active.length,
            month_deduction: Math.round(monthDeduction * 100) / 100,
            loans: list.map(l => ({
              id: String(l._id),
              total_amount: l.total_amount,
              installment_amount: l.installment_amount,
              installments_total: l.installments_total,
              installments_paid: l.installments_paid || 0,
              started_at: l.started_at || null,
              notes: l.notes || '',
              active: (l.installments_paid || 0) < (l.installments_total || 0),
            })),
          };
        })(),
        vacation_info: (() => {
          // Pulled from PayrollMonth row if already populated; else null.
          // Detail endpoint /payroll-month/:id/vacation gives the full breakdown.
          return {
            balance_from_payslip: row?.vacation_balance_from_payslip ?? null,
            balance_recorded_at: row?.vacation_balance_recorded_at || null,
            request_ids: row?.vacation_request_ids?.map(String) || [],
          };
        })(),
        status: row?.status || 'draft',
      };
    });

    // Branch totals (for display strip)
    const totals = rows.reduce((acc, r) => {
      acc.employees += 1;
      acc.hours += r.breakdown.hours.total || 0;
      acc.base  += r.breakdown.components.base_salary || 0;
      return acc;
    }, { employees: 0, hours: 0, base: 0 });

    // Branches referenced by anyone's per_branch breakdown — these are the
    // column groups the UI should render (filter view scope + cross-branch hours).
    const referencedBranchIds = new Set();
    for (const r of rows) {
      Object.keys(r.breakdown.per_branch || {}).forEach(id => referencedBranchIds.add(id));
    }
    // Always include the in-scope branches even if no employee has any punches yet
    branches.forEach(b => referencedBranchIds.add(String(b._id)));

    const branchesInView = allBranchesData
      .filter(b => referencedBranchIds.has(String(b._id)))
      .map((b, idx) => ({
        id: String(b._id),
        name: b.name,
        amuta_id: b.amuta_id ? String(b.amuta_id) : null,
        // Stable color index — derived from the alphabetical position so it
        // stays the same across page reloads / month changes.
        color_index: idx,
      }));

    res.json({
      month,
      rows,
      amutot: amutot.map(a => ({ id: String(a._id), name: a.name, short_name: a.short_name })),
      branches: branches.map(b => ({ id: String(b._id), name: b.name, amuta_id: b.amuta_id ? String(b.amuta_id) : null })),
      branches_in_view: branchesInView,
      custom_columns: customColumns.map(c => ({
        id: String(c._id),
        month: c.month,
        label: c.label,
        kind: c.kind,
        position: c.position,
      })),
      totals,
    });
  } catch (err) { next(err); }
}

/**
 * PATCH /api/payroll-month/:employeeId?month=YYYY-MM
 * body: { manual: { ...partial fields... } }
 *
 * Upserts the (employee × month) row with the provided manual fields. All
 * manual fields are optional — only those present in the body are updated.
 */
async function upsertEntry(req, res, next) {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'month=YYYY-MM is required' });
    const { employeeId } = req.params;

    const emp = await Employee.findById(employeeId).select('branch_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const body = req.body?.manual || {};
    const setObj = {};
    const allowed = [
      'sick_days', 'absence_days', 'vacation_days', 'holiday_pay',
      'advance_deduction_preset_id', 'advance_deduction_text',
      'gift_card', 'recreation', 'cibus', 'miluim',
      'travel_override', 'notes', 'custom_values',
    ];
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        setObj[`manual.${k}`] = body[k];
      }
    }

    const row = await PayrollMonth.findOneAndUpdate(
      { employee_id: employeeId, month },
      {
        $set: setObj,
        $setOnInsert: { branch_id: emp.branch_id, employee_id: employeeId, month },
      },
      { new: true, upsert: true },
    ).populate('manual.advance_deduction_preset_id');

    // Auto-bump usage_count for the chosen preset (helps sort by popularity)
    if (body.advance_deduction_preset_id) {
      await PayrollPresetOption.findByIdAndUpdate(
        body.advance_deduction_preset_id,
        { $inc: { usage_count: 1 } },
      );
    }

    res.json({ ok: true, entry: row });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/:month/finalize?branch=<id>
 *
 * Freezes a month: each in-scope row gets status='finalized' and its
 * auto_snapshot is persisted. Once finalized the auto numbers won't be
 * recomputed even if punches change.
 */
async function finalizeMonth(req, res, next) {
  try {
    const { month } = req.params;
    const { branch } = req.query;

    const filter = {};
    if (branch) filter.branch_id = branch;

    const employees = await Employee.find({ ...filter, is_active: true })
      .populate('amuta_distribution.amuta_id', 'name short_name')
      .lean();

    const allBranches = await Branch.find({}).select('_id amuta_id').lean();
    const branchAmutaMap = new Map(
      allBranches.filter(b => b.amuta_id).map(b => [String(b._id), String(b.amuta_id)])
    );

    const { from, to } = parseMonthRange(month);
    const punches = await Punch.find({
      employee_id: { $in: employees.map(e => e._id) },
      timestamp: { $gte: from, $lt: to },
      ignored: { $ne: true },
    }).sort({ timestamp: 1 }).lean();
    const punchesByEmp = new Map();
    for (const p of punches) {
      const k = String(p.employee_id);
      if (!punchesByEmp.has(k)) punchesByEmp.set(k, []);
      punchesByEmp.get(k).push(p);
    }

    let updated = 0;
    for (const emp of employees) {
      const empPunches = punchesByEmp.get(String(emp._id)) || [];
      const snapshot = calculateMonthlySalary(emp, empPunches, month, { branchAmutaMap });
      await PayrollMonth.findOneAndUpdate(
        { employee_id: emp._id, month },
        {
          $set: {
            auto_snapshot: snapshot,
            status: 'finalized',
            finalized_at: new Date(),
            finalized_by: req.user.id,
          },
          $setOnInsert: { branch_id: emp.branch_id, employee_id: emp._id, month },
        },
        { upsert: true },
      );
      updated++;
    }

    res.json({ ok: true, updated });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/:month/reopen?branch=<id>
 * Sets status back to 'draft' so admin can keep editing.
 */
async function reopenMonth(req, res, next) {
  try {
    const { month } = req.params;
    const { branch } = req.query;
    const filter = { month };
    if (branch) filter.branch_id = branch;
    const result = await PayrollMonth.updateMany(filter, {
      $set: { status: 'draft', finalized_at: null, finalized_by: null },
    });
    res.json({ ok: true, modified: result.modifiedCount });
  } catch (err) { next(err); }
}

// ── Preset options CRUD ───────────────────────────────────────────────

async function listPresets(req, res, next) {
  try {
    const { field_name } = req.query;
    const filter = { is_active: true };
    if (field_name) filter.field_name = field_name;
    const options = await PayrollPresetOption.find(filter).sort({ usage_count: -1, label: 1 }).lean();
    res.json({ options: options.map(o => ({ ...o, id: String(o._id) })) });
  } catch (err) { next(err); }
}

async function createPreset(req, res, next) {
  try {
    const { field_name, label, action, action_params } = req.body;
    if (!field_name || !label) return res.status(400).json({ error: 'field_name and label are required' });
    const existing = await PayrollPresetOption.findOne({ field_name, label });
    if (existing) {
      return res.json({ option: { ...existing.toObject(), id: String(existing._id) }, existed: true });
    }
    const opt = await PayrollPresetOption.create({
      field_name,
      label,
      action: action || 'custom',
      action_params: action_params || {},
      created_by: req.user.id,
    });
    res.json({ option: { ...opt.toObject(), id: String(opt._id) }, existed: false });
  } catch (err) { next(err); }
}

async function updatePreset(req, res, next) {
  try {
    const { id } = req.params;
    const { label, action, action_params, is_active } = req.body;
    const opt = await PayrollPresetOption.findByIdAndUpdate(
      id,
      { $set: { ...(label != null && { label }), ...(action && { action }), ...(action_params && { action_params }), ...(is_active != null && { is_active }) } },
      { new: true },
    );
    if (!opt) return res.status(404).json({ error: 'option not found' });
    res.json({ option: { ...opt.toObject(), id: String(opt._id) } });
  } catch (err) { next(err); }
}

async function deletePreset(req, res, next) {
  try {
    const { id } = req.params;
    await PayrollPresetOption.findByIdAndUpdate(id, { $set: { is_active: false } });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// ── Amuta-branch mapping admin ───────────────────────────────────────

async function listAmutot(req, res, next) {
  try {
    const amutot = await Amuta.find({}).sort({ name: 1 }).lean();
    const branches = await Branch.find({}).select('_id name amuta_id').sort({ name: 1 }).lean();
    res.json({
      amutot: amutot.map(a => ({ ...a, id: String(a._id) })),
      branches: branches.map(b => ({ ...b, id: String(b._id) })),
    });
  } catch (err) { next(err); }
}

async function upsertAmuta(req, res, next) {
  try {
    const { id } = req.params;
    const { name, short_name, tax_id, is_active } = req.body;
    if (id === 'new') {
      const amuta = await Amuta.create({ name, short_name, tax_id });
      return res.json({ amuta: { ...amuta.toObject(), id: String(amuta._id) } });
    }
    const amuta = await Amuta.findByIdAndUpdate(
      id,
      { $set: { ...(name && { name }), ...(short_name != null && { short_name }), ...(tax_id != null && { tax_id }), ...(is_active != null && { is_active }) } },
      { new: true },
    );
    if (!amuta) return res.status(404).json({ error: 'amuta not found' });
    res.json({ amuta: { ...amuta.toObject(), id: String(amuta._id) } });
  } catch (err) { next(err); }
}

// ── Salary adjustments CRUD ─────────────────────────────────────────

async function listAdjustments(req, res, next) {
  try {
    const { month, employee_id, branch } = req.query;
    const filter = { status: { $ne: 'rejected' } };
    if (month) filter.month = month;
    if (employee_id) filter.employee_id = employee_id;
    if (branch && branch !== 'all') filter.branch_id = branch;
    const list = await SalaryAdjustment.find(filter)
      .populate('employee_id', 'full_name israeli_id')
      .populate('created_by', 'full_name')
      .sort({ created_at: -1 })
      .lean();
    res.json({ adjustments: list.map(a => ({ ...a, id: String(a._id) })) });
  } catch (err) { next(err); }
}

async function createAdjustment(req, res, next) {
  try {
    const { employee_id, month, type, amount, hours, reason } = req.body;
    if (!employee_id || !month || !type) {
      return res.status(400).json({ error: 'employee_id, month, type are required' });
    }
    const emp = await Employee.findById(employee_id).select('branch_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const adj = await SalaryAdjustment.create({
      employee_id,
      branch_id: emp.branch_id,
      month,
      type,
      amount: Number(amount) || 0,
      hours: Number(hours) || 0,
      reason: reason || '',
      created_by: req.user.id,
      status: 'approved', // branch managers' entries auto-approve
      decided_by: req.user.id,
      decided_at: new Date(),
    });
    res.json({ adjustment: { ...adj.toObject(), id: String(adj._id) } });
  } catch (err) { next(err); }
}

async function updateAdjustment(req, res, next) {
  try {
    const { id } = req.params;
    const setObj = {};
    ['amount', 'hours', 'reason', 'type', 'status'].forEach(k => {
      if (req.body[k] != null) setObj[k] = req.body[k];
    });
    const adj = await SalaryAdjustment.findByIdAndUpdate(id, { $set: setObj }, { new: true });
    if (!adj) return res.status(404).json({ error: 'adjustment not found' });
    res.json({ adjustment: { ...adj.toObject(), id: String(adj._id) } });
  } catch (err) { next(err); }
}

async function deleteAdjustment(req, res, next) {
  try {
    await SalaryAdjustment.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// ── Custom columns CRUD ─────────────────────────────────────────────

async function listCustomColumns(req, res, next) {
  try {
    const { month } = req.query;
    const filter = { is_active: true };
    if (month) filter.$or = [{ month }, { month: '*' }];
    const cols = await PayrollCustomColumn.find(filter).sort({ position: 1, created_at: 1 }).lean();
    res.json({ columns: cols.map(c => ({ ...c, id: String(c._id) })) });
  } catch (err) { next(err); }
}

async function createCustomColumn(req, res, next) {
  try {
    const { month, label, kind, position, persistent } = req.body;
    if (!month || !label) return res.status(400).json({ error: 'month and label are required' });
    if (!['text', 'number', 'number_or_text'].includes(kind)) {
      return res.status(400).json({ error: 'invalid kind' });
    }
    const col = await PayrollCustomColumn.create({
      month: persistent ? '*' : month,
      label: label.trim(),
      kind,
      position: position || 0,
      created_by: req.user.id,
    });
    res.json({ column: { ...col.toObject(), id: String(col._id) } });
  } catch (err) { next(err); }
}

async function updateCustomColumn(req, res, next) {
  try {
    const { id } = req.params;
    const { label, kind, position, is_active, month } = req.body;
    const setObj = {};
    if (label != null) setObj.label = String(label).trim();
    if (kind && ['text', 'number', 'number_or_text'].includes(kind)) setObj.kind = kind;
    if (position != null) setObj.position = Number(position);
    if (is_active != null) setObj.is_active = !!is_active;
    if (month) setObj.month = month;
    const col = await PayrollCustomColumn.findByIdAndUpdate(id, { $set: setObj }, { new: true });
    if (!col) return res.status(404).json({ error: 'column not found' });
    res.json({ column: { ...col.toObject(), id: String(col._id) } });
  } catch (err) { next(err); }
}

async function deleteCustomColumn(req, res, next) {
  try {
    const { id } = req.params;
    await PayrollCustomColumn.findByIdAndUpdate(id, { $set: { is_active: false } });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/:month/apply-auto-holidays?branch=<id>
 *
 * Bulk-applies the auto-computed דמי חגים value into manual.holiday_pay
 * for every eligible hourly employee in scope. Only writes when:
 *   - employee.salary_type === 'hourly'
 *   - holiday_pay_auto > 0
 *   - manual.holiday_pay is currently 0 / empty (we do NOT overwrite
 *     manager overrides)
 *
 * Returns { updated, skipped_already_set, skipped_not_eligible }.
 */
async function applyAutoHolidays(req, res, next) {
  try {
    const { month } = req.params;
    const { branch } = req.query;

    const branchFilter = { is_active: true };
    if (branch && branch !== 'all') branchFilter.branch_id = branch;

    // Same scope enforcement as getMonth
    const role = req.user?.role;
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length > 0 ? managed : fallback;
      if (branchFilter.branch_id && !allowed.includes(String(branchFilter.branch_id))) {
        return res.json({ updated: 0, skipped_already_set: 0, skipped_not_eligible: 0 });
      }
      if (!branchFilter.branch_id) branchFilter.branch_id = { $in: allowed };
    }

    const employees = await Employee.find(branchFilter).lean();
    const empIds = employees.map(e => e._id);

    const { from, to } = parseMonthRange(month);
    const punches = await Punch.find({
      employee_id: { $in: empIds },
      timestamp: { $gte: from, $lt: to },
      ignored: { $ne: true },
    }).sort({ timestamp: 1 }).lean();
    const punchesByEmp = new Map();
    for (const p of punches) {
      const k = String(p.employee_id);
      if (!punchesByEmp.has(k)) punchesByEmp.set(k, []);
      punchesByEmp.get(k).push(p);
    }

    const commitments = await EmployeeCommitment.find({ employee_id: { $in: empIds } }).lean();
    const commitmentByEmp = new Map(commitments.map(c => [String(c.employee_id), c]));

    const existing = await PayrollMonth.find({ employee_id: { $in: empIds }, month }).lean();
    const existingByEmp = new Map(existing.map(r => [String(r.employee_id), r]));

    let updated = 0;
    let skippedAlreadySet = 0;
    let skippedNotEligible = 0;

    for (const emp of employees) {
      if (emp.salary_type !== 'hourly') { skippedNotEligible++; continue; }

      const empPunches = (punchesByEmp.get(String(emp._id)) || []).filter(p => {
        const s = p.approval_status || 'auto';
        return s === 'auto' || s === 'approved';
      });
      const hourlyRate = emp.amuta_distribution?.[0]?.hourly_rate || 0;
      const daysWorked = new Set(empPunches.map(p => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(p.timestamp)))).size;
      const totalMinutes = (() => {
        const byDay = new Map();
        for (const p of empPunches) {
          const k = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(p.timestamp));
          if (!byDay.has(k)) byDay.set(k, []);
          byDay.get(k).push(p);
        }
        let total = 0;
        for (const ps of byDay.values()) {
          const sorted = ps.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
          for (let i = 0; i + 1 < sorted.length; i += 2) {
            total += Math.max(0, Math.round((new Date(sorted[i + 1].timestamp) - new Date(sorted[i].timestamp)) / 60000));
          }
        }
        return total;
      })();
      const avgDailyHours = daysWorked > 0 ? (totalMinutes / 60 / daysWorked) : 8;

      const info = computeHolidayPay({
        employee: emp,
        monthYM: month,
        punches: empPunches,
        commitment: commitmentByEmp.get(String(emp._id)),
        hourlyRate,
        avgDailyHours,
      });

      if (info.total_pay <= 0) { skippedNotEligible++; continue; }

      const cur = Number(existingByEmp.get(String(emp._id))?.manual?.holiday_pay) || 0;
      if (cur > 0) { skippedAlreadySet++; continue; }

      await PayrollMonth.findOneAndUpdate(
        { employee_id: emp._id, month },
        {
          $set: { 'manual.holiday_pay': info.total_pay },
          $setOnInsert: { branch_id: emp.branch_id, employee_id: emp._id, month },
        },
        { upsert: true },
      );
      updated++;
    }

    res.json({ updated, skipped_already_set: skippedAlreadySet, skipped_not_eligible: skippedNotEligible });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/:month/apply-vacation-requests?branch=<id>
 *
 * Retroactive sync: walks every approved EmployeeRequest with from_date
 * in the target month and applies it to manual.vacation_days. Idempotent
 * (vacation_request_ids tracks already-applied requests).
 */
async function applyVacationRequests(req, res, next) {
  try {
    const { month } = req.params;
    const { branch } = req.query;
    const { EmployeeRequest } = require('../models');

    const branchFilter = {};
    if (branch && branch !== 'all') branchFilter.branch_id = branch;

    const role = req.user?.role;
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length > 0 ? managed : fallback;
      if (branchFilter.branch_id && !allowed.includes(String(branchFilter.branch_id))) {
        return res.json({ updated: 0, skipped_already_applied: 0 });
      }
      if (!branchFilter.branch_id) branchFilter.branch_id = { $in: allowed };
    }

    const employees = await Employee.find({ is_active: true, ...branchFilter })
      .select('_id user_id branch_id').lean();
    const empByUser = new Map(employees.filter(e => e.user_id).map(e => [String(e.user_id), e]));
    const userIds = [...empByUser.keys()];

    const requests = await EmployeeRequest.find({
      user_id: { $in: userIds },
      type: 'vacation',
      status: 'approved',
      from_date: { $regex: `^${month}` },
    }).lean();

    function countWorkDays(fromYmd, toYmd) {
      const start = new Date(`${fromYmd}T12:00:00Z`);
      const end = new Date(`${toYmd}T12:00:00Z`);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
      let count = 0;
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const wd = d.getUTCDay();
        if (wd !== 6) count++;
      }
      return count;
    }

    let updated = 0;
    let skipped = 0;
    for (const r of requests) {
      const emp = empByUser.get(String(r.user_id));
      if (!emp) continue;
      const days = countWorkDays(r.from_date, r.to_date || r.from_date);
      if (days <= 0) continue;
      const existing = await PayrollMonth.findOne({ employee_id: emp._id, month }).lean();
      const alreadyApplied = (existing?.vacation_request_ids || []).map(String).includes(String(r._id));
      if (alreadyApplied) { skipped++; continue; }
      await PayrollMonth.findOneAndUpdate(
        { employee_id: emp._id, month },
        {
          $inc: { 'manual.vacation_days': days },
          $addToSet: { vacation_request_ids: r._id },
          $setOnInsert: { branch_id: emp.branch_id, employee_id: emp._id, month },
        },
        { upsert: true },
      );
      updated++;
    }

    res.json({ updated, skipped_already_applied: skipped, requests_examined: requests.length });
  } catch (err) { next(err); }
}

/**
 * POST /api/payroll-month/import-cibus?month=YYYY-MM
 * multipart: { cibus_file: <xlsx|csv> }
 *
 * Parses an exported Pluxee/Cibus report and writes each employee's monthly
 * total into PayrollMonth.manual.cibus. Matches employees by israeli_id
 * first, falls back to fuzzy name match within the system.
 *
 * Response: { matched, unmatched, total_amount, details: [...] }
 */
async function importCibus(req, res, next) {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'month=YYYY-MM is required' });
    if (!req.file) return res.status(400).json({ error: 'נדרש קובץ סיבוס' });

    let report;
    try {
      report = parseCibusReport(req.file.buffer, req.file.originalname);
    } catch (err) {
      return res.status(400).json({ error: err.message || 'שגיאה בקריאת קובץ סיבוס' });
    }

    // Enforce per-user branch scope on the employee lookup
    const role = req.user?.role;
    const branchScope = {};
    if (role && role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length > 0 ? managed : fallback;
      branchScope.branch_id = { $in: allowed };
    }

    const allEmployees = await Employee.find({ is_active: true, ...branchScope })
      .select('_id full_name israeli_id branch_id')
      .lean();
    const byId = new Map(allEmployees.filter(e => e.israeli_id).map(e => [e.israeli_id, e]));
    const normalizeName = (s) => (s || '').replace(/[()‘’“”"'.,]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const normalized = allEmployees.map(e => ({ emp: e, tokens: normalizeName(e.full_name).split(' ').filter(Boolean) }));

    const matched = [];
    const unmatched = [];
    let totalAmount = 0;

    for (const row of report.rows || []) {
      let emp = row.id ? byId.get(row.id) : null;
      if (!emp && row.name) {
        const target = normalizeName(row.name).split(' ').filter(Boolean);
        if (target.length > 0) {
          let best = null;
          let bestScore = 0;
          for (const cand of normalized) {
            let common = 0;
            for (const t of target) if (cand.tokens.includes(t)) common++;
            const required = target.length === 1 ? 1 : 2;
            if (common >= required && common > bestScore) {
              best = cand.emp;
              bestScore = common;
            }
          }
          emp = best;
        }
      }
      const amount = Number(row.amount) || 0;
      totalAmount += amount;
      if (!emp) {
        unmatched.push({ name: row.name, id: row.id, amount });
        continue;
      }
      await PayrollMonth.findOneAndUpdate(
        { employee_id: emp._id, month },
        {
          $set: {
            'manual.cibus': { kind: 'number', amount, text: '' },
          },
          $setOnInsert: { branch_id: emp.branch_id, employee_id: emp._id, month },
        },
        { upsert: true },
      );
      matched.push({
        employee_id: String(emp._id),
        employee_name: emp.full_name,
        israeli_id: emp.israeli_id,
        amount,
      });
    }

    res.json({
      matched_count: matched.length,
      unmatched_count: unmatched.length,
      total_amount: Math.round(totalAmount * 100) / 100,
      matched,
      unmatched,
      detected_columns: report.detected_columns,
      warning: report.warning || null,
    });
  } catch (err) { next(err); }
}

async function setBranchAmuta(req, res, next) {
  try {
    const { branchId } = req.params;
    const { amuta_id } = req.body;
    const branch = await Branch.findByIdAndUpdate(
      branchId,
      { $set: { amuta_id: amuta_id || null } },
      { new: true },
    );
    if (!branch) return res.status(404).json({ error: 'branch not found' });
    res.json({ branch: { ...branch.toObject(), id: String(branch._id) } });
  } catch (err) { next(err); }
}

module.exports = {
  getMonth,
  upsertEntry,
  finalizeMonth,
  reopenMonth,
  listPresets,
  createPreset,
  updatePreset,
  deletePreset,
  listAmutot,
  upsertAmuta,
  setBranchAmuta,
  listCustomColumns,
  createCustomColumn,
  updateCustomColumn,
  deleteCustomColumn,
  listAdjustments,
  createAdjustment,
  updateAdjustment,
  deleteAdjustment,
  importCibus,
  applyAutoHolidays,
  applyVacationRequests,
};
