const { DataDeletionRequest } = require('../models');
const dataDeletion = require('../services/dataDeletion.service');

/** Staff: "I want my account deleted." One pending request at a time. */
async function requestStaff(req, res) {
  const existing = await DataDeletionRequest.findOne({ user_id: req.user.id, status: 'pending' });
  if (existing) return res.json({ ok: true, already_pending: true });
  await DataDeletionRequest.create({ user_id: req.user.id });
  res.json({ ok: true });
}

/** Parent portal: same, for a ParentAccount. */
async function requestParent(req, res) {
  const existing = await DataDeletionRequest.findOne({ parent_id: req.parent.pid, status: 'pending' });
  if (existing) return res.json({ ok: true, already_pending: true });
  await DataDeletionRequest.create({ parent_id: req.parent.pid });
  res.json({ ok: true });
}

/** Admin: the queue the office works through. */
async function adminList(req, res) {
  const requests = await DataDeletionRequest.find({ status: 'pending' })
    .populate('user_id', 'full_name email role')
    .populate('parent_id', 'full_name phone id_number')
    .sort({ requested_at: 1 });
  res.json({ requests });
}

/**
 * Admin: actually run the anonymization for one request.
 *
 * The only place `dataDeletion.service` is ever called from — a request sits
 * here, visible with a name on it, until someone at the gan deliberately
 * decides to act on it.
 */
async function adminComplete(req, res) {
  const request = await DataDeletionRequest.findById(req.params.id);
  if (!request) return res.status(404).json({ error: 'הבקשה לא נמצאה' });
  if (request.status === 'completed') return res.json({ ok: true, already_completed: true });

  if (request.user_id) await dataDeletion.completeEmployeeDeletion(request.user_id);
  else await dataDeletion.completeParentDeletion(request.parent_id);

  request.status = 'completed';
  request.completed_at = new Date();
  request.completed_by = req.user.id;
  await request.save();

  res.json({ ok: true });
}

module.exports = { requestStaff, requestParent, adminList, adminComplete };
