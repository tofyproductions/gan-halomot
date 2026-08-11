const { User } = require('../models');

/**
 * Which branches this request may act on — read from the DATABASE, not the JWT.
 *
 * The token carries `managed_branch_ids`, and it is stale exactly when it
 * matters most: the moment an admin grants somebody more branches, every token
 * already in the wild still says the old list. The branch dropdown is served by
 * branch.controller, which re-reads the user, so the user sees the new branch —
 * and then every endpoint that trusted the token refused it. Granted access
 * that produces a visible 403 is worse than no access at all.
 *
 * Returns null for "all branches" (system_admin, accountant), otherwise the
 * list of ids. Falls back to the token, and then to the user's own branch, so
 * a database hiccup denies rather than opens.
 */
async function resolveBranchScope(req) {
  const uid = req.user?.id || req.user?._id;
  let role = req.user?.role;
  let managed = (req.user?.managed_branch_ids || []).map(String);
  let ownBranch = req.user?.branch_id ? String(req.user.branch_id) : null;

  if (uid) {
    try {
      const dbUser = await User.findById(uid)
        .select('role managed_branch_ids branch_id').lean();
      if (dbUser) {
        role = dbUser.role;
        managed = (dbUser.managed_branch_ids || []).map(String);
        ownBranch = dbUser.branch_id ? String(dbUser.branch_id) : null;
      }
    } catch { /* fall back to the token */ }
  }

  if (role === 'system_admin' || role === 'accountant') return null;
  if (managed.length) return managed;
  return ownBranch ? [ownBranch] : [];
}

/** Whether this request may work on this branch. */
async function canAccessBranch(req, branchId) {
  const scope = await resolveBranchScope(req);
  if (scope === null) return true;
  return scope.includes(String(branchId));
}

module.exports = { resolveBranchScope, canAccessBranch };
