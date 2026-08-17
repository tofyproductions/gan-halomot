const { PickupAuthorization } = require('../models');
const { normalizePhone } = require('../services/sms.service');
const { loadOwnChild } = require('./parentPortal.controller');

/**
 * The people a family says may collect their child.
 *
 * Adding waits for the gan. REMOVING DOES NOT — see models/PickupAuthorization.
 * A parent taking somebody off this list is answering a question that should
 * never queue behind an office, and the one direction that can only make the
 * list shorter needs no gate.
 *
 * A rejected or revoked entry stays in the record and leaves the screen. The
 * family sees why it was refused; nobody sees a name that is no longer
 * authorised sitting in a list of people who are.
 */

/** What a parent may see about one entry. Never the raw document. */
function toJson(p) {
  return {
    id: p._id,
    name: p.name,
    phone: p.phone,
    relation: p.relation,
    status: p.status,
    reject_reason: p.reject_reason || '',
    created_at: p.created_at,
    decided_at: p.decided_at,
  };
}

/** GET /api/parent/children/:childId/pickup */
async function list(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  const rows = await PickupAuthorization.find({
    child_id: own.child._id,
    status: { $in: ['pending', 'approved', 'rejected'] },
  }).sort({ created_at: -1 }).lean();

  res.json({ people: rows.map(toJson) });
}

/** POST /api/parent/children/:childId/pickup  { name, phone, relation } */
async function add(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'חסר שם' });

  // Rejected here rather than saved as typed: the staff ring this number, and
  // one that is not an Israeli mobile is a number nobody can use.
  const raw = String(req.body?.phone || '').trim();
  const phone = raw ? normalizePhone(raw) : '';
  if (raw && !phone) return res.status(400).json({ error: 'מספר הטלפון אינו תקין' });

  const { child, account } = own;
  await PickupAuthorization.create({
    child_id: child._id,
    classroom_id: child.classroom_id?._id || child.classroom_id || null,
    branch_id: child.classroom_id?.branch_id || null,
    child_name: child.child_name,
    name,
    phone: phone || '',
    relation: String(req.body?.relation || '').trim().slice(0, 60),
    added_by: account._id,
    added_by_name: account.full_name || '',
  });

  return list(req, res);
}

/**
 * DELETE /api/parent/children/:childId/pickup/:id
 *
 * Immediate, whatever the state. Withdrawing a request that is still waiting
 * and revoking one the gan already approved are the same act from the family's
 * side, and neither of them should need permission.
 */
async function revoke(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  await PickupAuthorization.updateOne(
    // Scoped to this child, so an id from another family changes nothing.
    { _id: req.params.id, child_id: own.child._id },
    { $set: { status: 'revoked', revoked_at: new Date() } },
  );

  return list(req, res);
}

module.exports = { list, add, revoke };
