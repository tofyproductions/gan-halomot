const { PickupAuthorization } = require('../models');
const { resolveBranchScope, canAccessBranch } = require('../utils/branch-scope');

/**
 * מורשי איסוף — the staff side of who may collect a child.
 *
 * Two lists in one screen. The queue is what families have asked for and
 * nobody has answered; the roll is who may actually walk out with a child
 * today, which is the list the person at the door needs and the reason this
 * exists at all.
 *
 * Approving is a real decision and the screen says what it rests on: this
 * system holds a name, a telephone number and a relationship, and identity is
 * checked at the door against a document. Nothing here can verify a person.
 */

async function scopeFilter(req) {
  const scope = await resolveBranchScope(req);
  return scope === null ? {} : { branch_id: { $in: scope } };
}

function toJson(p) {
  return {
    id: p._id,
    child_id: p.child_id,
    child_name: p.child_name,
    name: p.name,
    phone: p.phone,
    relation: p.relation,
    status: p.status,
    added_by_name: p.added_by_name,
    created_at: p.created_at,
    decided_by_name: p.decided_by_name,
    decided_at: p.decided_at,
    reject_reason: p.reject_reason || '',
  };
}

/** GET /api/pickup?status=&branch= */
async function list(req, res, next) {
  try {
    const filter = await scopeFilter(req);
    filter.status = req.query.status || 'pending';
    if (req.query.branch && req.query.branch !== 'all') {
      if (!(await canAccessBranch(req, req.query.branch))) {
        return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
      }
      filter.branch_id = req.query.branch;
    }
    const rows = await PickupAuthorization.find(filter)
      .sort({ created_at: -1 }).limit(400).lean();
    res.json({ people: rows.map(toJson) });
  } catch (e) { next(e); }
}

/**
 * POST /api/pickup/:id/decide  { approve, reason }
 *
 * Guarded on `pending`, so a second press cannot re-approve something a parent
 * has since revoked — which is the one direction that would matter.
 */
async function decide(req, res, next) {
  try {
    const doc = await PickupAuthorization.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'לא נמצא' });
    if (!(await canAccessBranch(req, doc.branch_id))) {
      return res.status(404).json({ error: 'לא נמצא' });
    }
    if (doc.status !== 'pending') {
      return res.status(409).json({ error: 'הבקשה כבר טופלה' });
    }

    const approve = !!req.body.approve;
    if (!approve && !String(req.body.reason || '').trim()) {
      return res.status(400).json({ error: 'יש לכתוב למה הבקשה נדחתה' });
    }

    doc.status = approve ? 'approved' : 'rejected';
    doc.decided_by = req.user.id;
    doc.decided_by_name = req.user.name || '';
    doc.decided_at = new Date();
    doc.reject_reason = approve ? '' : String(req.body.reason).trim().slice(0, 300);
    await doc.save();

    res.json(toJson(doc));
  } catch (e) { next(e); }
}

/**
 * POST /api/pickup/:id/revoke  { reason }
 *
 * The gan withdrawing an authorisation it granted. Separate from the parent's
 * own revoke and recorded against a staff member, because "the gan took this
 * away" and "the family took this away" are different facts about the same
 * name and the difference matters when somebody asks later.
 */
async function revoke(req, res, next) {
  try {
    const doc = await PickupAuthorization.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'לא נמצא' });
    if (!(await canAccessBranch(req, doc.branch_id))) {
      return res.status(404).json({ error: 'לא נמצא' });
    }
    if (doc.status !== 'approved') {
      return res.status(409).json({ error: 'אפשר לבטל רק אישור פעיל' });
    }
    doc.status = 'revoked';
    doc.revoked_at = new Date();
    doc.decided_by = req.user.id;
    doc.decided_by_name = req.user.name || '';
    doc.reject_reason = String(req.body?.reason || '').trim().slice(0, 300);
    await doc.save();
    res.json(toJson(doc));
  } catch (e) { next(e); }
}

module.exports = { list, decide, revoke };
