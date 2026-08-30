const { RateChangeRequest, Employee, Branch } = require('../models');
const terms = require('../services/employmentTerms');
const { resolveBranchScope, canAccessBranch } = require('../utils/branch-scope');

/**
 * העלאות שכר קבועות — request by the branch manager, applied by the office.
 *
 * The approval goes through employmentTerms.applyTermsChange: the change is
 * dated, past months keep paying what they paid, and the card is brought into
 * line. The one thing this controller must never do is assign the rate onto
 * the employee directly.
 */

function shape(r, empNames, branchNames) {
  return {
    id: String(r._id),
    employee_id: String(r.employee_id),
    employee_name: empNames.get(String(r.employee_id)) || '',
    branch_name: branchNames.get(String(r.branch_id)) || '',
    effective_date: r.effective_date,
    salary_type: r.salary_type,
    hourly_rate: r.hourly_rate,
    global_salary: r.global_salary,
    global_ot_rate: r.global_ot_rate,
    required_hours: r.required_hours,
    reason: r.reason || '',
    status: r.status,
    requested_by_name: r.requested_by_name || '',
    decided_by_name: r.decided_by_name || '',
    decided_note: r.decided_note || '',
    applied_effective_month: r.applied_effective_month || null,
    created_at: r.created_at,
  };
}

/** GET /api/rate-changes — pending first, then recent history, branch-scoped. */
async function list(req, res, next) {
  try {
    const scope = await resolveBranchScope(req);
    const filter = scope === null ? {} : { branch_id: { $in: scope } };
    const rows = await RateChangeRequest.find(filter)
      .sort({ status: 1, created_at: -1 }) // 'approved' < 'pending' < 'rejected' — resorted below
      .limit(100)
      .lean();
    rows.sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1)
      || new Date(b.created_at) - new Date(a.created_at));

    const [emps, branches] = await Promise.all([
      Employee.find({ _id: { $in: rows.map(r => r.employee_id) } }).select('full_name').lean(),
      Branch.find({}).select('name').lean(),
    ]);
    const empNames = new Map(emps.map(e => [String(e._id), e.full_name]));
    const branchNames = new Map(branches.map(b => [String(b._id), b.name]));
    res.json({
      requests: rows.map(r => shape(r, empNames, branchNames)),
      can_decide: ['system_admin', 'accountant'].includes(req.user?.role),
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/rate-changes
 * Body: { employee_id, effective_date, salary_type, hourly_rate?,
 *         global_salary?, global_ot_rate?, required_hours?, reason }
 */
async function create(req, res, next) {
  try {
    const b = req.body || {};
    const emp = await Employee.findById(b.employee_id)
      .select('full_name branch_id salary_type amuta_distribution terms_history start_date').lean();
    if (!emp) return res.status(404).json({ error: 'עובד/ת לא נמצא/ה' });
    if (!(await canAccessBranch(req, emp.branch_id))) {
      return res.status(403).json({ error: 'העובד/ת אינו/ה בסניף שבאחריותך' });
    }

    // The same validation approval will run — a request that can never be
    // applied should be refused when it is typed, not discovered months later.
    const plan = terms.planTermsChange(emp, b);
    if (plan.errors.length) return res.status(400).json({ error: plan.errors[0] });
    if (plan.nothingChanged) {
      return res.status(400).json({ error: 'התנאים שהוזנו זהים לתנאים הקיימים — אין מה לעדכן' });
    }

    const open = await RateChangeRequest.findOne({ employee_id: emp._id, status: 'pending' }).lean();
    if (open) {
      return res.status(409).json({ error: 'כבר קיימת בקשת העלאה ממתינה לעובד/ת — יש להמתין להכרעה' });
    }

    const doc = await RateChangeRequest.create({
      employee_id: emp._id,
      branch_id: emp.branch_id || null,
      effective_date: new Date(b.effective_date),
      salary_type: b.salary_type === 'global' ? 'global' : 'hourly',
      hourly_rate: b.hourly_rate ?? null,
      global_salary: b.global_salary ?? null,
      global_ot_rate: b.global_ot_rate ?? null,
      required_hours: b.required_hours ?? null,
      reason: String(b.reason || '').trim(),
      requested_by: req.user?.id || null,
      requested_by_name: req.user?.full_name || req.user?.username || '',
    });
    res.status(201).json({ id: String(doc._id), effective_month: plan.effective_month });
  } catch (err) { next(err); }
}

/** POST /api/rate-changes/:id/decide  { approve, note } — accountant/admin only. */
async function decide(req, res, next) {
  try {
    const doc = await RateChangeRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'בקשה לא נמצאה' });
    if (doc.status !== 'pending') return res.status(409).json({ error: 'הבקשה כבר הוכרעה' });

    const approve = !!req.body?.approve;
    if (!approve) {
      doc.status = 'rejected';
      doc.decided_by = req.user?.id || null;
      doc.decided_by_name = req.user?.full_name || '';
      doc.decided_at = new Date();
      doc.decided_note = String(req.body?.note || '').trim();
      await doc.save();
      return res.json({ ok: true, status: 'rejected' });
    }

    const emp = await Employee.findById(doc.employee_id);
    if (!emp) return res.status(404).json({ error: 'העובד/ת כבר לא במערכת' });

    // THE point of this model: the dated path, not a card assignment.
    const plan = terms.applyTermsChange(emp, {
      effective_date: doc.effective_date,
      salary_type: doc.salary_type,
      hourly_rate: doc.hourly_rate,
      global_salary: doc.global_salary,
      global_ot_rate: doc.global_ot_rate,
      required_hours: doc.required_hours,
      note: `העלאה שנקבעה ע"י ${doc.requested_by_name || 'מנהל/ת הסניף'}${doc.reason ? ` — ${doc.reason}` : ''}`,
    }, { id: req.user?.id || null, full_name: req.user?.full_name || '' });
    if (plan.errors.length) return res.status(400).json({ error: plan.errors[0] });
    await emp.save();

    doc.status = 'approved';
    doc.decided_by = req.user?.id || null;
    doc.decided_by_name = req.user?.full_name || '';
    doc.decided_at = new Date();
    doc.decided_note = String(req.body?.note || '').trim();
    doc.applied_effective_month = plan.effective_month;
    await doc.save();

    res.json({ ok: true, status: 'approved', effective_month: plan.effective_month });
  } catch (err) { next(err); }
}

module.exports = { list, create, decide };
