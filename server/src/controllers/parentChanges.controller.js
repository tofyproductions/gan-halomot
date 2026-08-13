const { ParentPortalChange, ParentAccount } = require('../models');

/**
 * What parents changed about their own children, for the staff to read.
 *
 * This is an acknowledgement screen, not an approval one. The gan's rule is
 * that a parent corrects their own details without waiting for anyone — so by
 * the time a row appears here the change is already live, and marking it seen
 * records that somebody at the gan knows, not that they permitted it.
 *
 * That distinction is the whole reason the screen exists. An allergy edited at
 * eleven at night is true from eleven at night; the only question is whether
 * anyone finds out before breakfast. So health sorts above everything else,
 * unread above read, and a row is never deleted — it is a record of what the
 * family said and when.
 */

/** The branches this user may read. Empty means "everything". */
function branchScope(user) {
  if (user.role === 'system_admin' || user.role === 'accountant') return null;
  const managed = (user.managed_branch_ids || []).map(String);
  const own = user.branch_id ? [String(user.branch_id)] : [];
  const all = [...new Set([...managed, ...own].filter(Boolean))];
  return all.length ? all : null;
}

/**
 * The list.
 *
 * Unread first, then health before everything else, then newest. Sorted in
 * that order deliberately: an unread house number still outranks an
 * acknowledged allergy, because the acknowledged one has already been read by
 * somebody and the unread one has not been read by anyone.
 */
async function list(req, res) {
  const scope = branchScope(req.user);
  const query = {};
  if (scope) {
    // A change recorded before the child had a classroom has no branch. Those
    // stay visible to everyone rather than falling into a hole nobody reads.
    query.$or = [{ branch_id: { $in: scope } }, { branch_id: null }];
  }
  if (req.query.status === 'unseen') query.seen_at = null;

  // The database sorts by what it can order meaningfully — unread first, then
  // newest — and the cap keeps that end. Severity is NOT sorted here: it is a
  // string, and "normal" sorts after "high" alphabetically, which put every
  // medical change at the BOTTOM of the screen built to surface them.
  const rows = await ParentPortalChange.find(query)
    .sort({ seen_at: 1, created_at: -1 })
    .limit(300)
    .lean();

  // Unread before read, health before the rest, newest first — applied here
  // where "health outranks an address" can be said in the one way it means.
  const rank = (r) => (r.seen_at ? 2 : 0) + (r.severity === 'high' ? 0 : 1);
  rows.sort((a, b) => rank(a) - rank(b) || new Date(b.created_at) - new Date(a.created_at));

  const unseen = await ParentPortalChange.countDocuments({ ...query, seen_at: null });

  // Which of the nominated accounts are still waiting. Asked once for the page
  // rather than per row.
  const relatedIds = rows.map(r => r.related_account_id).filter(Boolean);
  const stillShut = relatedIds.length
    ? await ParentAccount.find({ _id: { $in: relatedIds }, access_approved: false }).select('_id').lean()
    : [];
  const pendingAccess = new Set(stillShut.map(a => String(a._id)));

  return res.json({
    unseen,
    changes: rows.map(r => ({
      id: r._id,
      parent_name: r.parent_name,
      child_name: r.child_name,
      category: r.category,
      severity: r.severity,
      changes: r.changes,
      created_at: r.created_at,
      seen_at: r.seen_at,
      seen_by_name: r.seen_by_name || '',
      // Only a second_parent row carries a decision, and only while the
      // account it points at is still shut.
      awaiting_access: r.category === 'second_parent'
        && !!r.related_account_id
        && pendingAccess.has(String(r.related_account_id)),
    })),
  });
}

/** How many are still unread — for the badge on the menu. */
async function unseenCount(req, res) {
  const scope = branchScope(req.user);
  const query = { seen_at: null };
  if (scope) query.$or = [{ branch_id: { $in: scope } }, { branch_id: null }];
  return res.json({ unseen: await ParentPortalChange.countDocuments(query) });
}

/**
 * Mark one row read.
 *
 * Idempotent, and the first reader keeps their name on it: a second person
 * opening the screen has not discovered anything, and overwriting would erase
 * who actually saw the allergy first.
 */
async function markSeen(req, res) {
  const row = await ParentPortalChange.findById(req.params.id);
  if (!row) return res.status(404).json({ error: 'לא נמצא' });

  const scope = branchScope(req.user);
  if (scope && row.branch_id && !scope.includes(String(row.branch_id))) {
    return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
  }

  if (!row.seen_at) {
    row.seen_at = new Date();
    row.seen_by = req.user.id;
    row.seen_by_name = req.user.full_name || '';
    await row.save();
  }

  return res.json({ ok: true, seen_at: row.seen_at, seen_by_name: row.seen_by_name });
}

/**
 * Open the door for a second parent the other parent nominated.
 *
 * The details have been on the child since the moment they were typed — the
 * gan needs a second contact for a child today, not once a queue is read. What
 * waits here is only ACCESS: the right to open the portal and read the
 * contract, the payments and the day.
 *
 * Which is why it is a decision and not an acknowledgement. One parent naming
 * a second person is a claim about a family, and the gan is the one that knows
 * whether it holds.
 *
 * Refusing is not a button. An account left unapproved simply stays shut, and
 * a change that turns out to be wrong is a conversation with the family and a
 * correction in the office — not a rejection recorded against a parent by
 * whoever happened to open this screen.
 */
async function approveAccess(req, res) {
  const row = await ParentPortalChange.findById(req.params.id);
  if (!row) return res.status(404).json({ error: 'לא נמצא' });
  if (row.category !== 'second_parent' || !row.related_account_id) {
    return res.status(400).json({ error: 'לשורה זו אין גישה לאשר' });
  }

  const scope = branchScope(req.user);
  if (scope && row.branch_id && !scope.includes(String(row.branch_id))) {
    return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
  }

  const account = await ParentAccount.findById(row.related_account_id);
  if (!account) return res.status(404).json({ error: 'החשבון לא נמצא' });

  if (!account.access_approved) {
    account.access_approved = true;
    account.access_approved_by = req.user.id;
    account.access_approved_at = new Date();
    await account.save();
  }

  // Approving is also reading it. Asking for two taps on one decision only
  // teaches people to tap twice.
  if (!row.seen_at) {
    row.seen_at = new Date();
    row.seen_by = req.user.id;
    row.seen_by_name = req.user.full_name || '';
    await row.save();
  }

  return res.json({ ok: true, access_approved: true, seen_at: row.seen_at });
}

module.exports = { list, unseenCount, markSeen, approveAccess };
