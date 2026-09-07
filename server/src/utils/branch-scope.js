const { User } = require('../models');
const { isRead } = require('./viewer');
const { ADMIN_VIEWER } = require('../constants/roles');

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
  // The viewer reads every branch and writes only the ones she manages. A
  // viewer with no managed branches writes nowhere — her own branch_id is
  // where she is listed, not what she runs.
  if (role === ADMIN_VIEWER) return isRead(req) ? null : managed;
  if (managed.length) return managed;
  return ownBranch ? [ownBranch] : [];
}

/** Whether this request may work on this branch. */
async function canAccessBranch(req, branchId) {
  const scope = await resolveBranchScope(req);
  if (scope === null) return true;
  return scope.includes(String(branchId));
}

/**
 * Which branches a READ may materialize into.
 *
 * Some GETs write. `payrollMonth#getMonth` and `payroll#attendanceByMonth`
 * both run the fixed-schedule and closure-completion fillers before reading
 * the grid, and those fillers INSERT Punch documents stamped
 * `approval_status: 'approved'`, `created_by`/`approval_decided_by` = the
 * caller. Harmless for an admin, whose read scope and write scope are the
 * same thing. Not harmless for a viewer: her read scope is every branch, so
 * merely opening the salary screen would file approved punches into branches
 * she does not run, in her name — the exact write the whole proposal
 * mechanism exists to prevent.
 *
 * So the read stays all-branch and the side effect is narrowed to what she
 * may actually write. `actual_role` is set by middleware/auth.js only on a
 * read it swapped; every other caller gets the list back untouched.
 */
function materializeScope(req, readBranchIds) {
  if (req?.user?.actual_role !== ADMIN_VIEWER) return readBranchIds;
  const managed = (req.user.managed_branch_ids || []).map(String);
  if (managed.length === 0) return [];
  return (readBranchIds || []).filter(id => managed.includes(String(id)));
}

module.exports = { resolveBranchScope, canAccessBranch, materializeScope };
