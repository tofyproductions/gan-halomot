const mongoose = require('mongoose');
const { ProposedChange, User } = require('../models');
const { applyProposal } = require('../services/proposedChanges.service');
const { ADMIN_VIEWER } = require('../constants/roles');

/** A replay that never reported back is abandoned after this long. */
const STALE_APPLYING_MS = 2 * 60 * 1000;

const NOT_FOUND = 'ההצעה לא נמצאה';

/**
 * The guarded claim below cannot tell "gone" from "already decided" — both
 * come back null — so an id that does not exist is looked up once first and
 * answered 404. The claim's own null still means 409.
 */
async function exists(id) {
  // A malformed id is not a server fault: findById would throw a CastError
  // that the error handler turns into 500, on a URL a person mistyped or a
  // stale link carried. There is no such proposal — say so.
  if (!mongoose.isValidObjectId(id)) return false;
  return !!await ProposedChange.findById(id).select('_id').lean();
}

/**
 * The role the person actually holds, not the one this read is being served
 * under. authMiddleware presents a viewer's READ as `system_admin` so every
 * list she opens covers all branches; `actual_role` is what she really is,
 * and this screen is one of the few that has to know — the queue she sees is
 * her own, not the organisation's.
 */
function realRole(user) {
  return user?.actual_role || user?.role;
}

function decides(user) {
  const role = realRole(user);
  return role === 'system_admin' || role === 'accountant';
}

/** findOneAndUpdate hands back a document; the response wants a plain object. */
function plain(doc) {
  return doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
}

function decisionFields(req, note) {
  return {
    decided_by: req.user.id,
    decided_by_name: req.user.full_name || '',
    decided_at: new Date(),
    decision_note: note || '',
  };
}

/** GET /api/proposed-changes?status=pending  — approvers: all; viewer: own. */
async function list(req, res, next) {
  try {
    const filter = {};
    if (req.query.status) {
      // A row mid-replay is still on the approver's "ממתין" tab — it has not
      // reached approved/failed yet, and it must not vanish while it runs.
      filter.status = req.query.status === 'pending'
        ? { $in: ['pending', 'applying'] }
        : req.query.status;
    }
    if (!decides(req.user)) filter.requested_by = req.user.id;
    const items = await ProposedChange.find(filter).sort({ created_at: -1 }).limit(200).lean();
    const pending_count = decides(req.user)
      ? await ProposedChange.countDocuments({ status: 'pending' })
      : 0;
    res.json({ items, pending_count });
  } catch (err) { next(err); }
}

/**
 * GET /api/proposed-changes/count
 * The badge. A viewer counts her own queue — the org-wide backlog is not
 * hers to see, and the read gate would otherwise hand it to her.
 */
async function count(req, res, next) {
  try {
    const filter = { status: 'pending' };
    // Load-bearing, not dead: the read swap lets a viewer reach this endpoint
    // as `system_admin`, so without the real role she would get the badge for
    // the whole organisation's backlog.
    if (realRole(req.user) === ADMIN_VIEWER) filter.requested_by = req.user.id;
    const pending_count = await ProposedChange.countDocuments(filter);
    res.json({ pending_count });
  } catch (err) { next(err); }
}

/**
 * Replay a claimed row and write down what happened.
 * The row is already `applying`, so this always leaves it approved or failed.
 */
async function runApply(doc, req) {
  const approver = await User.findById(req.user.id)
    .select('email full_name role branch_id managed_branch_ids').lean();
  if (!approver) {
    // A deleted (or renamed-away) approver is not a crash: the claim is
    // already on the row, so it has to be closed rather than left applying.
    const failed = { status: 'failed', apply_status: null, apply_error: 'המאשר לא נמצא' };
    await ProposedChange.updateOne({ _id: doc._id }, { $set: failed });
    return { ...plain(doc), ...failed };
  }
  const result = await applyProposal(doc, { ...approver, id: String(approver._id) }, {
    tenantSlug: req.tenant ? req.tenant.slug : undefined,
    // The approver is on this request; the stored host came off the viewer's.
    host: req.headers?.host,
  });
  const outcome = {
    status: result.ok ? 'approved' : 'failed',
    apply_status: result.status,
    apply_error: result.ok ? '' : result.error,
  };
  await ProposedChange.updateOne({ _id: doc._id }, { $set: outcome });
  return { ...plain(doc), ...outcome };
}

/**
 * POST /api/proposed-changes/:id/decide { decision: 'approve'|'reject', note }
 *
 * Approving claims the row first (pending → applying) and only then replays:
 * two approvers pressing at once would otherwise both pass a `status ===
 * 'pending'` read and send the same write twice. The second claim finds
 * nothing and gets 409.
 */
async function decide(req, res, next) {
  try {
    const { decision, note } = req.body || {};
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'decision חייב להיות approve או reject' });
    }
    if (!await exists(req.params.id)) return res.status(404).json({ error: NOT_FOUND });
    const claimed = await ProposedChange.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { ...decisionFields(req, note), status: decision === 'reject' ? 'rejected' : 'applying' } },
      { new: true },
    );
    if (!claimed) return res.status(409).json({ error: 'ההצעה כבר הוכרעה' });
    if (decision === 'reject') return res.json({ proposal: plain(claimed) });
    return res.json({ proposal: await runApply(claimed, req) });
  } catch (err) { next(err); }
}

/**
 * POST /api/proposed-changes/:id/retry — a failed apply, tried again.
 * Also picks up a row stuck in `applying` past STALE_APPLYING_MS: that is a
 * replay whose process died, and nothing else will ever close it.
 */
async function retry(req, res, next) {
  try {
    if (!await exists(req.params.id)) return res.status(404).json({ error: NOT_FOUND });
    const stale = new Date(Date.now() - STALE_APPLYING_MS);
    const claimed = await ProposedChange.findOneAndUpdate(
      {
        _id: req.params.id,
        $or: [
          { status: { $in: ['failed'] } },
          { status: 'applying', decided_at: { $lt: stale } },
        ],
      },
      {
        $set: {
          status: 'applying',
          decided_by: req.user.id,
          decided_by_name: req.user.full_name || '',
          decided_at: new Date(),
        },
      },
      { new: true },
    );
    if (!claimed) return res.status(409).json({ error: 'אפשר לנסות שוב רק הצעה שנכשלה' });
    return res.json({ proposal: await runApply(claimed, req) });
  } catch (err) { next(err); }
}

module.exports = { list, count, decide, retry };
