/**
 * Pure unit test for the branch boundary filter. No database — getBranchFilter
 * is a pure function of req.branchScope (set by attachBranchScope) and
 * req.query.branch. Run: node scripts/branch-scope-filter.test.js
 */
const assert = require('assert');
const { getBranchFilter } = require('../src/utils/branch-filter');

const req = (branchScope, branch) => ({ branchScope, query: branch ? { branch } : {} });
let n = 0;
const ok = (label, actual, expected) => {
  assert.deepStrictEqual(actual, expected, `${label}\n  got ${JSON.stringify(actual)}\n  want ${JSON.stringify(expected)}`);
  n++;
};

// Admin / accountant — scope null = all branches
ok('admin, no branch → all', getBranchFilter(req(null)), {});
ok('admin, branch=all → all', getBranchFilter(req(null, 'all')), {});
ok('admin, branch=B1 → narrow', getBranchFilter(req(null, 'B1')), { branch_id: 'B1' });

// Manager scoped to two branches
ok('manager, no branch → own branches', getBranchFilter(req(['B1', 'B2'])), { branch_id: { $in: ['B1', 'B2'] } });
ok('manager, branch=all → own branches', getBranchFilter(req(['B1', 'B2'], 'all')), { branch_id: { $in: ['B1', 'B2'] } });
ok('manager, branch=B1 (in scope) → narrow', getBranchFilter(req(['B1', 'B2'], 'B1')), { branch_id: 'B1' });

// Empty scope — a user with no branch matches nothing, never everything
ok('empty scope → match nothing', getBranchFilter(req([])), { branch_id: { $in: [] } });

// Fail closed: middleware never ran (undefined) → non-admin behavior, match nothing
ok('undefined scope → match nothing', getBranchFilter(req(undefined)), { branch_id: { $in: [] } });

// Custom field name is honored
ok('custom field', getBranchFilter(req(['B1']), undefined, 'x'), { branch_id: { $in: ['B1'] } });
ok('custom field arg', getBranchFilter({ branchScope: ['B1'], query: {} }, 'branch'), { branch: { $in: ['B1'] } });

console.log(`✓ branch-filter: ${n} assertions passed`);
