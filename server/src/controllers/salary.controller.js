const { SalaryRequest, User } = require('../models');

async function getAll(req, res, next) {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;

    // Non-admins see only their own requests
    if (req.user.role !== 'system_admin') {
      filter.requested_by = req.user.id;
    }

    const requests = await SalaryRequest.find(filter)
      .populate('user_id', 'full_name position branch_id')
      .populate('requested_by', 'full_name')
      .populate('decided_by', 'full_name')
      .sort({ created_at: -1 })
      .lean();

    res.json({
      requests: requests.map(r => ({
        ...r, id: r._id,
        employee_name: r.user_id?.full_name || '',
        employee_position: r.user_id?.position || '',
        requester_name: r.requested_by?.full_name || '',
        decider_name: r.decided_by?.full_name || '',
      })),
    });
  } catch (error) { next(error); }
}

async function create(req, res, next) {
  try {
    const { user_id, new_salary, reason } = req.body;
    if (!user_id || !new_salary) {
      return res.status(400).json({ error: 'user_id and new_salary are required' });
    }

    const employee = await User.findById(user_id);
    if (!employee) return res.status(404).json({ error: 'עובד לא נמצא' });

    // Check pending request exists
    const pending = await SalaryRequest.findOne({ user_id, status: 'pending' });
    if (pending) {
      return res.status(400).json({ error: 'כבר קיימת בקשה ממתינה לעובד זה' });
    }

    const request = await SalaryRequest.create({
      user_id,
      requested_by: req.user.id,
      current_salary: employee.salary || 0,
      new_salary,
      reason: reason || '',
    });

    res.status(201).json({ request: { ...request.toObject(), id: request._id } });
  } catch (error) { next(error); }
}

async function approve(req, res, next) {
  try {
    const request = await SalaryRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'בקשה לא נמצאה' });
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'בקשה כבר טופלה' });
    }

    // Update salary
    await User.findByIdAndUpdate(request.user_id, { salary: request.new_salary });

    request.status = 'approved';
    request.decided_by = req.user.id;
    request.decided_at = new Date();
    request.decided_note = req.body.note || '';
    await request.save();

    res.json({ message: 'בקשת השכר אושרה', request: { ...request.toObject(), id: request._id } });
  } catch (error) { next(error); }
}

async function reject(req, res, next) {
  try {
    const request = await SalaryRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'בקשה לא נמצאה' });
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'בקשה כבר טופלה' });
    }

    request.status = 'rejected';
    request.decided_by = req.user.id;
    request.decided_at = new Date();
    request.decided_note = req.body.note || '';
    await request.save();

    res.json({ message: 'בקשת השכר נדחתה', request: { ...request.toObject(), id: request._id } });
  } catch (error) { next(error); }
}

module.exports = { getAll, create, approve, reject };
