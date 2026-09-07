const { ProposedChange, User } = require('../models');
const { applyProposal } = require('../services/proposedChanges.service');
const { ADMIN_VIEWER } = require('../constants/roles');

function decides(user) {
  return user?.role === 'system_admin' || user?.role === 'accountant';
}

/** GET /api/proposed-changes?status=pending  — approvers: all; viewer: own. */
async function list(req, res, next) {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (!decides(req.user)) filter.requested_by = req.user.id;
    const items = await ProposedChange.find(filter).sort({ created_at: -1 }).limit(200).lean();
    const pending_count = decides(req.user) ? await ProposedChange.countDocuments({ status: 'pending' }) : 0;
    res.json({ items, pending_count });
  } catch (err) { next(err); }
}

/** GET /api/proposed-changes/count */
async function count(req, res, next) {
  try {
    const pending_count = await ProposedChange.countDocuments({ status: 'pending' });
    res.json({ pending_count });
  } catch (err) { next(err); }
}

async function runApply(doc, req) {
  const approver = await User.findById(req.user.id)
    .select('email full_name role branch_id managed_branch_ids').lean();
  const result = await applyProposal(doc, { ...approver, id: String(approver._id) }, {
    tenantSlug: req.tenant ? req.tenant.slug : undefined,
  });
  doc.apply_status = result.status;
  doc.apply_error = result.ok ? '' : result.error;
  doc.status = result.ok ? 'approved' : 'failed';
}

/** POST /api/proposed-changes/:id/decide { decision: 'approve'|'reject', note } */
async function decide(req, res, next) {
  try {
    const { decision, note } = req.body || {};
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'decision חייב להיות approve או reject' });
    }
    const doc = await ProposedChange.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ההצעה לא נמצאה' });
    if (doc.status !== 'pending') return res.status(409).json({ error: 'ההצעה כבר הוכרעה' });

    doc.decided_by = req.user.id;
    doc.decided_by_name = req.user.full_name || '';
    doc.decided_at = new Date();
    doc.decision_note = note || '';
    if (decision === 'reject') {
      doc.status = 'rejected';
    } else {
      await runApply(doc, req);
    }
    await doc.save();
    res.json({ proposal: doc });
  } catch (err) { next(err); }
}

/** POST /api/proposed-changes/:id/retry — a failed apply, tried again. */
async function retry(req, res, next) {
  try {
    const doc = await ProposedChange.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ההצעה לא נמצאה' });
    if (doc.status !== 'failed') return res.status(409).json({ error: 'אפשר לנסות שוב רק הצעה שנכשלה' });
    doc.decided_by = req.user.id;
    doc.decided_by_name = req.user.full_name || '';
    doc.decided_at = new Date();
    await runApply(doc, req);
    await doc.save();
    res.json({ proposal: doc });
  } catch (err) { next(err); }
}

module.exports = { list, count, decide, retry, ADMIN_VIEWER };
