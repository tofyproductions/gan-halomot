const { EmployeeRequest, Employee, PayrollMonth } = require('../models');

/**
 * Count week-days (Sun-Fri, Israel) from `from` to `to` inclusive (YYYY-MM-DD).
 * Saturdays excluded. Returns 1 if same day and not Saturday.
 */
function countWorkDays(fromYmd, toYmd) {
  const start = new Date(`${fromYmd}T12:00:00Z`);
  const end = new Date(`${toYmd}T12:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  let count = 0;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay(); // 0=Sun, 6=Sat
    if (wd !== 6) count++;
  }
  return count;
}

/**
 * Apply an approved vacation request to the PayrollMonth row for the month
 * the request starts in. Adds days_count to manual.vacation_days, records
 * the request id under vacation_request_ids. Idempotent — re-running with
 * the same request id will not double-add.
 */
async function applyVacationToPayroll(request) {
  if (request.type !== 'vacation' || request.status !== 'approved') return;
  // The request stores user_id; the payroll model stores employee_id.
  // Find the Employee linked to this user.
  const emp = await Employee.findOne({ user_id: request.user_id }).select('_id branch_id').lean();
  if (!emp) return;
  const days = countWorkDays(request.from_date, request.to_date || request.from_date);
  if (days <= 0) return;
  const month = request.from_date.slice(0, 7); // YYYY-MM
  const existing = await PayrollMonth.findOne({ employee_id: emp._id, month }).lean();
  const alreadyApplied = (existing?.vacation_request_ids || []).map(String).includes(String(request._id));
  if (alreadyApplied) return;
  await PayrollMonth.findOneAndUpdate(
    { employee_id: emp._id, month },
    {
      $inc: { 'manual.vacation_days': days },
      $addToSet: { vacation_request_ids: request._id },
      $setOnInsert: { branch_id: emp.branch_id, employee_id: emp._id, month },
    },
    { upsert: true, new: true },
  );
}

async function getMyRequests(req, res, next) {
  try {
    const requests = await EmployeeRequest.find({ user_id: req.user.id })
      .sort({ created_at: -1 })
      .lean();
    res.json({ requests });
  } catch (error) {
    next(error);
  }
}

async function createRequest(req, res, next) {
  try {
    const { type, from_date, to_date, reason, medical_file_data, medical_file_name } = req.body;

    if (!type || !from_date) {
      return res.status(400).json({ error: 'סוג בקשה ותאריך התחלה נדרשים' });
    }
    // Sick reports must include a medical attachment
    if (type === 'sick' && !medical_file_data) {
      return res.status(400).json({ error: 'חובה לצרף אישור רפואי לדיווח מחלה' });
    }

    const request = await EmployeeRequest.create({
      user_id: req.user.id,
      branch_id: req.user.branch_id || null,
      type,
      from_date,
      to_date: to_date || from_date,
      reason: reason || null,
      medical_file_data: medical_file_data || null,
      medical_file_name: medical_file_name || null,
    });

    res.status(201).json({ request });
  } catch (error) {
    next(error);
  }
}

// Manager endpoints
async function getAllRequests(req, res, next) {
  try {
    const filter = {};
    if (req.query.branch_id) filter.branch_id = req.query.branch_id;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.type) filter.type = req.query.type;

    const requests = await EmployeeRequest.find(filter)
      .populate('user_id', 'full_name role position')
      .sort({ created_at: -1 })
      .lean();

    res.json({ requests });
  } catch (error) {
    next(error);
  }
}

async function updateRequestStatus(req, res, next) {
  try {
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'סטטוס לא תקין' });
    }

    const request = await EmployeeRequest.findByIdAndUpdate(
      req.params.id,
      { status, reviewed_by: req.user.id, reviewed_at: new Date() },
      { new: true }
    );

    if (!request) return res.status(404).json({ error: 'בקשה לא נמצאה' });

    // Side-effect: approved vacation → push the days into the matching
    // PayrollMonth row. Failures don't block the status update.
    if (status === 'approved' && request.type === 'vacation') {
      try { await applyVacationToPayroll(request); }
      catch (err) { console.error('applyVacationToPayroll failed:', err.message); }
    }

    res.json({ request });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/employee-requests/vacation-for-month?employee_id=X&month=YYYY-MM
 * Returns all approved vacation requests for the employee in that month.
 * Used by the payroll table to show the request-by-request breakdown when
 * the manager clicks the vacation cell.
 */
async function listVacationForMonth(req, res, next) {
  try {
    const { employee_id, month } = req.query;
    if (!employee_id || !month) return res.status(400).json({ error: 'employee_id and month required' });
    const emp = await Employee.findById(employee_id).select('user_id').lean();
    if (!emp || !emp.user_id) return res.json({ requests: [] });
    const [y, m] = month.split('-');
    const prefix = `${y}-${m}`;
    const requests = await EmployeeRequest.find({
      user_id: emp.user_id,
      type: 'vacation',
      status: 'approved',
      from_date: { $regex: `^${prefix}` },
    }).sort({ from_date: 1 }).lean();
    res.json({
      requests: requests.map(r => ({
        id: String(r._id),
        from_date: r.from_date,
        to_date: r.to_date || r.from_date,
        reason: r.reason || '',
        days: countWorkDays(r.from_date, r.to_date || r.from_date),
      })),
    });
  } catch (error) { next(error); }
}

module.exports = {
  getMyRequests,
  createRequest,
  getAllRequests,
  updateRequestStatus,
  listVacationForMonth,
};
