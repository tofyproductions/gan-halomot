const { EmployeeRequest } = require('../models');

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
    res.json({ request });
  } catch (error) {
    next(error);
  }
}

module.exports = { getMyRequests, createRequest, getAllRequests, updateRequestStatus };
