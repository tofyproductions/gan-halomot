const { EmployeeRequest, Employee, PayrollMonth, EmployeeCommitment } = require('../models');
const { scanSickNote } = require('../services/sickNoteScan');
const { workingWeekdays } = require('../services/commitmentAnalysis');

/**
 * Count working days from `from` to `to` inclusive (YYYY-MM-DD).
 * Saturday is always excluded. If `workDays` is given (array of weekday
 * numbers 0=Sun … 6=Sat — the employee's working days), only those weekdays
 * count, so an employee's regular day off never counts as a sick/vacation day.
 */
function countWorkDays(fromYmd, toYmd, workDays = null) {
  const start = new Date(`${fromYmd}T12:00:00Z`);
  const end = new Date(`${toYmd}T12:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const allowed = Array.isArray(workDays) && workDays.length
    ? new Set(workDays.map(Number))
    : null;
  let count = 0;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay(); // 0=Sun … 6=Sat
    if (wd === 6) continue;                       // Saturday always off
    if (allowed && !allowed.has(wd)) continue;    // employee's day off
    count++;
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

/**
 * Apply an approved sick request to the PayrollMonth row for its start month.
 * Counts only the employee's working days (Saturday + day-off excluded), adds
 * them to manual.sick_days, and records the request id under sick_request_ids.
 * Idempotent.
 */
async function resolveEmployeeForRequest(request) {
  if (request.employee_id) {
    return Employee.findById(request.employee_id).select('_id branch_id work_days user_id').lean();
  }
  if (request.user_id) {
    return Employee.findOne({ user_id: request.user_id }).select('_id branch_id work_days user_id').lean();
  }
  return null;
}

/**
 * Recompute manual.sick_days for (employee, month) as the exact sum of work-days
 * across ALL approved sick requests in that month. This is the single source of
 * truth — using a recompute (not $inc) means the count never drifts when a
 * request is added/edited/deleted, or after a manual reset.
 */
async function syncSickDaysForMonth(emp, month) {
  if (!emp || !month) return;
  const ownerMatch = emp.user_id
    ? { $or: [{ employee_id: emp._id }, { user_id: emp.user_id }] }
    : { employee_id: emp._id };
  const requests = await EmployeeRequest.find({
    ...ownerMatch,
    type: 'sick',
    status: 'approved',
    from_date: { $regex: `^${month}` },
  }).lean();
  // Count by the employee's REAL working days (commitment schedule), falling back
  // to work_days — so a day she actually works (e.g. Friday) isn't dropped.
  const commitment = await EmployeeCommitment.findOne({ employee_id: emp._id }).lean();
  const wd = workingWeekdays(commitment, emp.work_days);
  const total = requests.reduce(
    (s, r) => s + countWorkDays(r.from_date, r.to_date || r.from_date, wd), 0,
  );
  const ids = requests.map(r => r._id);
  await PayrollMonth.findOneAndUpdate(
    { employee_id: emp._id, month },
    {
      $set: { 'manual.sick_days': total, sick_request_ids: ids },
      $setOnInsert: { branch_id: emp.branch_id, employee_id: emp._id, month },
    },
    { upsert: true, new: true },
  );
}

// Apply/un-apply a sick request = recompute the month's total from approved
// requests. Kept as named wrappers so existing call sites stay readable.
async function applySickToPayroll(request) {
  if (request.type !== 'sick') return;
  const emp = await resolveEmployeeForRequest(request);
  await syncSickDaysForMonth(emp, request.from_date.slice(0, 7));
}
async function unapplySickFromPayroll(request) {
  if (request.type !== 'sick') return;
  const emp = await resolveEmployeeForRequest(request);
  await syncSickDaysForMonth(emp, request.from_date.slice(0, 7));
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
    if (req.query.status) filter.status = req.query.status;
    if (req.query.type) filter.type = req.query.type;

    // Branch managers see only their managed branches; accountant/admin see all.
    const role = req.user.role;
    if (role !== 'system_admin' && role !== 'accountant') {
      const managed = (req.user.managed_branch_ids || []).map(String);
      const fallback = req.user.branch_id ? [String(req.user.branch_id)] : [];
      const allowed = managed.length > 0 ? managed : fallback;
      if (allowed.length === 0) return res.json({ requests: [] });
      filter.branch_id = { $in: allowed };
    } else if (req.query.branch_id) {
      filter.branch_id = req.query.branch_id;
    }

    const requests = await EmployeeRequest.find(filter)
      .populate('user_id', 'full_name role position')
      .sort({ created_at: -1 })
      .lean();

    res.json({
      requests: requests.map(r => ({
        ...r,
        has_file: !!r.medical_file_data,
        medical_file_data: undefined, // don't ship base64 in the list
      })),
    });
  } catch (error) {
    next(error);
  }
}

async function updateRequestStatus(req, res, next) {
  try {
    const action = req.body.status; // 'approved' (advance one stage) | 'rejected'
    if (!['approved', 'rejected'].includes(action)) {
      return res.status(400).json({ error: 'סטטוס לא תקין' });
    }
    const request = await EmployeeRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'בקשה לא נמצאה' });

    const role = req.user.role;
    const isFinal = role === 'system_admin' || role === 'accountant';
    const isManager = role === 'branch_manager' || role === 'system_admin';

    if (action === 'rejected') {
      request.status = 'rejected';
      request.reviewed_by = req.user.id;
      request.reviewed_at = new Date();
    } else {
      const st = request.status;
      if ((st === 'pending_manager' || st === 'pending') && isManager) {
        // Stage 1 → forward to accountant.
        request.status = 'pending_accountant';
        request.manager_reviewed_by = req.user.id;
        request.manager_reviewed_at = new Date();
      } else if (st === 'pending_accountant' && isFinal) {
        // Stage 2 → final approval; only now applied to payroll.
        request.status = 'approved';
        request.reviewed_by = req.user.id;
        request.reviewed_at = new Date();
      } else {
        return res.status(403).json({ error: 'אין הרשאה לאשר את הבקשה בשלב זה' });
      }
    }
    await request.save();

    // Apply to payroll only once fully approved by the accountant.
    if (request.status === 'approved' && request.type === 'vacation') {
      try { await applyVacationToPayroll(request); }
      catch (err) { console.error('applyVacationToPayroll failed:', err.message); }
    }
    if (request.status === 'approved' && request.type === 'sick') {
      try { await applySickToPayroll(request); }
      catch (err) { console.error('applySickToPayroll failed:', err.message); }
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

/**
 * GET /api/employee-requests/sick-for-month?employee_id=X&month=YYYY-MM
 * Approved sick requests for the employee in that month, with work-day counts
 * and whether a medical certificate is attached.
 */
async function listSickForMonth(req, res, next) {
  try {
    const { employee_id, month } = req.query;
    if (!employee_id || !month) return res.status(400).json({ error: 'employee_id and month required' });
    const emp = await Employee.findById(employee_id).select('user_id work_days').lean();
    if (!emp) return res.json({ requests: [] });
    const commitment = await EmployeeCommitment.findOne({ employee_id: emp._id }).lean();
    const wd = workingWeekdays(commitment, emp.work_days);
    const [y, m] = month.split('-');
    const prefix = `${y}-${m}`;
    const ownerMatch = emp.user_id
      ? { $or: [{ employee_id: emp._id }, { user_id: emp.user_id }] }
      : { employee_id: emp._id };
    const requests = await EmployeeRequest.find({
      ...ownerMatch,
      type: 'sick',
      status: 'approved',
      from_date: { $regex: `^${prefix}` },
    }).sort({ from_date: 1 }).lean();
    // Authoritative paid sick-days for the month (what the salary uses).
    const pm = await PayrollMonth.findOne({ employee_id: emp._id, month }).select('manual.sick_days').lean();
    res.json({
      sick_days: Number(pm?.manual?.sick_days) || 0,
      requests: requests.map(r => ({
        id: String(r._id),
        from_date: r.from_date,
        to_date: r.to_date || r.from_date,
        reason: r.reason || '',
        days: countWorkDays(r.from_date, r.to_date || r.from_date, wd),
        has_file: !!r.medical_file_data,
        file_name: r.medical_file_name || '',
        pay_from_first_day: !!r.pay_from_first_day,
      })),
    });
  } catch (error) { next(error); }
}

/**
 * GET /api/employee-requests/pending-for-employee?employee_id=X&type=sick
 * Pending requests for one employee (manager view), including the cert flag.
 */
async function listPendingForEmployee(req, res, next) {
  try {
    const { employee_id, type } = req.query;
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    const emp = await Employee.findById(employee_id).select('user_id').lean();
    if (!emp) return res.json({ requests: [] });
    const ownerMatch = emp.user_id
      ? { $or: [{ employee_id: emp._id }, { user_id: emp.user_id }] }
      : { employee_id: emp._id };
    const filter = {
      ...ownerMatch,
      status: { $in: ['pending', 'pending_manager', 'pending_accountant'] },
    };
    if (type) filter.type = type;
    const requests = await EmployeeRequest.find(filter).sort({ from_date: 1 }).lean();
    res.json({
      requests: requests.map(r => ({
        id: String(r._id),
        type: r.type,
        status: r.status,
        from_date: r.from_date,
        to_date: r.to_date || r.from_date,
        reason: r.reason || '',
        has_file: !!r.medical_file_data,
        file_name: r.medical_file_name || '',
      })),
    });
  } catch (error) { next(error); }
}

/**
 * POST /api/employee-requests/admin
 * Manager creates an already-approved request on behalf of an employee
 * (employee_id), optionally with a medical certificate, and applies it to
 * payroll. Used by the salary table's sick dialog.
 */
async function createAdminRequest(req, res, next) {
  try {
    const { employee_id, type, from_date, to_date, reason, medical_file_data, medical_file_name, pay_from_first_day } = req.body;
    if (!employee_id || !type || !from_date) {
      return res.status(400).json({ error: 'עובד, סוג ותאריך התחלה נדרשים' });
    }
    const emp = await Employee.findById(employee_id).select('user_id branch_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    // Manager-created: stage-1 is implicitly done, so it goes straight to the
    // accountant. Accountant/admin-created is approved immediately (final).
    const role = req.user.role;
    const isFinal = role === 'system_admin' || role === 'accountant';
    const status = isFinal ? 'approved' : 'pending_accountant';

    const request = await EmployeeRequest.create({
      user_id: emp.user_id || null,
      employee_id: emp._id,
      branch_id: emp.branch_id || null,
      type,
      from_date,
      to_date: to_date || from_date,
      reason: reason || null,
      medical_file_data: medical_file_data || null,
      medical_file_name: medical_file_name || null,
      pay_from_first_day: !!pay_from_first_day,
      status,
      manager_reviewed_by: req.user.id,
      manager_reviewed_at: new Date(),
      reviewed_by: isFinal ? req.user.id : null,
      reviewed_at: isFinal ? new Date() : null,
    });

    if (status === 'approved' && type === 'sick') {
      try { await applySickToPayroll(request); } catch (e) { console.error('applySickToPayroll failed:', e.message); }
    } else if (status === 'approved' && type === 'vacation') {
      try { await applyVacationToPayroll(request); } catch (e) { console.error('applyVacationToPayroll failed:', e.message); }
    }
    res.status(201).json({ request });
  } catch (error) { next(error); }
}

/**
 * GET /api/employee-requests/:id/medical-file
 * Returns the stored certificate (base64) for preview/download by a manager.
 */
async function getMedicalFile(req, res, next) {
  try {
    const r = await EmployeeRequest.findById(req.params.id).select('medical_file_data medical_file_name').lean();
    if (!r || !r.medical_file_data) return res.status(404).json({ error: 'אין קובץ מצורף' });
    res.json({ data: r.medical_file_data, name: r.medical_file_name || 'אישור מחלה' });
  } catch (error) { next(error); }
}

/**
 * DELETE /api/employee-requests/:id
 * Delete a request and reverse its payroll effect (sick days).
 */
async function deleteRequest(req, res, next) {
  try {
    const request = await EmployeeRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'בקשה לא נמצאה' });
    // Delete first, then recompute the month's total from the remaining requests.
    const emp = request.type === 'sick' ? await resolveEmployeeForRequest(request) : null;
    const month = request.from_date.slice(0, 7);
    await EmployeeRequest.deleteOne({ _id: request._id });
    if (emp) {
      try { await syncSickDaysForMonth(emp, month); }
      catch (err) { console.error('syncSickDaysForMonth failed:', err.message); }
    }
    res.json({ message: 'נמחק' });
  } catch (error) { next(error); }
}

/**
 * PUT /api/employee-requests/:id/admin
 * Edit a sick/vacation request's dates / reason / certificate, re-syncing the
 * payroll day count when it's an approved sick request.
 */
async function editAdminRequest(req, res, next) {
  try {
    const request = await EmployeeRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'בקשה לא נמצאה' });
    const { from_date, to_date, reason, medical_file_data, medical_file_name, pay_from_first_day } = req.body;

    const oldMonth = request.from_date.slice(0, 7);
    if (from_date) request.from_date = from_date;
    if (to_date !== undefined) request.to_date = to_date || request.from_date;
    if (reason !== undefined) request.reason = reason || null;
    if (pay_from_first_day !== undefined) request.pay_from_first_day = !!pay_from_first_day;
    if (medical_file_data) { request.medical_file_data = medical_file_data; request.medical_file_name = medical_file_name || request.medical_file_name; }
    await request.save();

    // Recompute the affected month(s) — covers the case where the edit moved the
    // sick period to a different month.
    if (request.type === 'sick') {
      const emp = await resolveEmployeeForRequest(request);
      const newMonth = request.from_date.slice(0, 7);
      try {
        await syncSickDaysForMonth(emp, newMonth);
        if (oldMonth !== newMonth) await syncSickDaysForMonth(emp, oldMonth);
      } catch (err) { console.error('syncSickDaysForMonth failed:', err.message); }
    }
    res.json({ request });
  } catch (error) { next(error); }
}

/**
 * POST /api/employee-requests/sync-sick { employee_id, month }
 * Recompute manual.sick_days for an employee/month from the approved requests.
 * Used by the sick dialog to fix a count that drifted from the requests.
 */
async function syncSickDays(req, res, next) {
  try {
    const { employee_id, month } = req.body;
    if (!employee_id || !month) return res.status(400).json({ error: 'employee_id and month required' });
    const emp = await Employee.findById(employee_id).select('_id branch_id work_days user_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });
    await syncSickDaysForMonth(emp, month);
    res.json({ ok: true });
  } catch (error) { next(error); }
}

/**
 * POST /api/employee-requests/scan-medical
 * Body: { file_data (base64), file_name, mime_type?, employee_id? }
 * Reads a sick certificate with Claude vision and returns the extracted dates /
 * day count as a SUGGESTION for the accountant to confirm (never auto-applied).
 */
async function scanMedical(req, res, next) {
  try {
    const { file_data, file_name, mime_type, employee_id } = req.body;
    if (!file_data) return res.status(400).json({ error: 'נדרש קובץ לסריקה' });

    let detected;
    try {
      detected = await scanSickNote(file_data, file_name, mime_type);
    } catch (e) {
      // NO_API_KEY → 501 (feature not configured); other scan errors → 422.
      const status = e.code === 'NO_API_KEY' ? 501 : 422;
      return res.status(status).json({ error: e.message || 'שגיאה בסריקה', code: e.code || null });
    }

    // When dates were detected and we know the employee, also suggest the
    // work-day count the salary will actually use (Sat + day-off excluded).
    let suggested_work_days = null;
    if (detected?.from_date && employee_id) {
      const emp = await Employee.findById(employee_id).select('work_days').lean();
      suggested_work_days = countWorkDays(detected.from_date, detected.to_date || detected.from_date, emp?.work_days);
    }
    res.json({ detected, suggested_work_days });
  } catch (error) { next(error); }
}

module.exports = {
  getMyRequests,
  createRequest,
  scanMedical,
  getAllRequests,
  updateRequestStatus,
  listVacationForMonth,
  listSickForMonth,
  listPendingForEmployee,
  createAdminRequest,
  editAdminRequest,
  deleteRequest,
  syncSickDays,
  getMedicalFile,
};
