/**
 * Controller for the monthly payroll table — the one with per-amuta column
 * groups and manual fields (sick, vacation, gift card, etc.). Backed by the
 * `PayrollMonth` collection plus on-the-fly recomputation via payrollCalc.
 */
const {
  PayrollMonth, PayrollPresetOption, PayrollCustomColumn, Employee, Branch, Amuta, Punch,
} = require('../models');
const { calculateMonthlySalary } = require('../services/payrollCalc');

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

    // Determine which branches are in scope
    const branchFilter = {};
    if (branch) {
      branchFilter._id = branch;
    } else if (amuta) {
      branchFilter.amuta_id = amuta;
    }
    const branches = await Branch.find(branchFilter).select('_id name amuta_id').lean();
    if (branches.length === 0) {
      return res.json({ rows: [], amutot: [], branches: [], totals: {} });
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

    // Need ALL branches (not just in-scope) so cross-branch hours can still
    // be shown in the table — an employee from branch A may have punched at B.
    const allBranchesData = await Branch.find({}).select('_id name amuta_id').sort({ name: 1 }).lean();
    const branchNameById = new Map(allBranchesData.map(b => [String(b._id), b.name]));

    const rows = employees.map(emp => {
      const empPunches = punchesByEmp.get(String(emp._id)) || [];
      const breakdown = calculateMonthlySalary(emp, empPunches, month, { branchAmutaMap });
      const row = existingByEmp.get(String(emp._id));
      const manual = row?.manual || {};
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
};
