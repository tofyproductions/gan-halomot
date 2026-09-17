/**
 * What a person may do, decided from their user record and nothing else.
 *
 * Pulled out of useAuth so it can be asserted with real user shapes under
 * plain node (server/scripts/viewer-client-manager.test.js) instead of being
 * read back out of a React file by a regular expression. The rules here decide
 * whether a CONTROL EXISTS; the server decides what pressing it does.
 *
 * No React, no imports, no side effects.
 */

const ADMIN_VIEWER = 'admin_viewer';

function managedCount(user) {
  return (user?.managed_branch_ids || []).length;
}

export function isAdminRole(user) {
  return user?.role === 'system_admin';
}

export function isViewerRole(user) {
  return user?.role === ADMIN_VIEWER;
}

/**
 * May this person act as a branch manager?
 *
 * It used to be a plain role test, and `admin_viewer` is not that role — so
 * every screen that asked hid its controls from her: the employees table's
 * actions column, approving a punch or a request, fixing attendance, the
 * contact list, editing a gantt.
 *
 * Meanwhile the server had always said yes. `middleware/auth.js` swaps a
 * viewer's role to `branch_manager` for writes inside `managed_branch_ids`,
 * and files everything else as a proposal. The interface was refusing requests
 * the server was willing to accept, and the person it refused was a partner in
 * the business who also runs a branch.
 *
 * Widening it here is safe because this flag never decides WHICH branch. The
 * server does, and outside hers every one of these actions becomes a proposal
 * rather than a write.
 *
 * A viewer with no managed branch is not a manager: she has no branch to be
 * one of, and every write she makes is queued for approval regardless.
 */
export function isManagerRole(user) {
  return user?.role === 'branch_manager'
    || isAdminRole(user)
    || (isViewerRole(user) && managedCount(user) > 0);
}

/**
 * May this person edit rows belonging to this branch, directly?
 *
 * An admin may edit anywhere. Everyone else is limited to the branches they
 * hold — which for most people is invisible, because the server only ever
 * sends them their own branches. The viewer is the one person who is sent
 * every branch, so she is the one for whom this question has a real answer.
 */
export function managesBranchOf(user, branchId) {
  if (isAdminRole(user)) return true;
  if (!branchId) return false;
  return (user?.managed_branch_ids || []).map(String).includes(String(branchId));
}

/**
 * May this person use the cross-branch "כל הסניפים" view?
 *
 * Admins and accountants always (payroll is consolidated across branches),
 * viewers always (seeing everything is the whole point of the role), and a
 * manager who holds more than one branch.
 */
export function canSeeAllBranchesRole(user) {
  return isAdminRole(user)
    || user?.role === 'accountant'
    || isViewerRole(user)
    || managedCount(user) > 1;
}
