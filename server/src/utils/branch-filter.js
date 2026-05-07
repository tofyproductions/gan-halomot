/**
 * Build a branch filter for MongoDB queries.
 * If branch query param is provided, filters by branch_id.
 * If not provided, returns empty filter (show all).
 */
function getBranchFilter(req, field = 'branch_id') {
  const branchId = req.query.branch;
  // 'all' is the cross-branch admin view sentinel — treat it like no filter.
  if (!branchId || branchId === 'all') return {};
  return { [field]: branchId };
}

module.exports = { getBranchFilter };
