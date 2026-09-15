/**
 * Build a MongoDB branch filter that is ALWAYS clamped to what the caller may
 * see. The branch boundary is decided on the server from the caller's role and
 * managed branches (req.branchScope, set once by the attachBranchScope
 * middleware) — never from the client's ?branch parameter alone.
 *
 * req.branchScope is either:
 *   - null  → all branches (system_admin / accountant)
 *   - [ids] → exactly these branch ids (branch_manager and anyone with
 *             managed_branch_ids); an empty array means "no branch" → match nothing
 *
 * ?branch may only NARROW within that scope. The middleware already rejects a
 * ?branch outside the scope with 403, so by the time we get here it is safe.
 *
 * Fails closed: if the middleware never ran (req.branchScope === undefined) a
 * non-admin caller gets a match-nothing filter rather than the whole network.
 */
function getBranchFilter(req, field = 'branch_id') {
  const scope = req.branchScope;
  const q = req.query.branch;

  // All-branches scope (admin/accountant). Honor an explicit single-branch pick.
  if (scope === null) {
    if (!q || q === 'all') return {};
    return { [field]: q };
  }

  const ids = Array.isArray(scope) ? scope.map(String) : [];

  // Narrowing to one branch — validated in-scope by the middleware.
  if (q && q !== 'all') return { [field]: q };

  // No narrowing: everything the caller is scoped to. Empty scope → nothing.
  if (!ids.length) return { [field]: { $in: [] } };
  return { [field]: { $in: ids } };
}

module.exports = { getBranchFilter };
