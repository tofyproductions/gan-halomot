#!/usr/bin/env node
/**
 * The viewer who also runs a branch may act in it — on the SCREEN too.
 *
 * The server side of this has been right since the role shipped: auth.js swaps
 * a viewer's role to branch_manager for writes inside `managed_branch_ids` and
 * files everything else as a proposal, and viewer-auth-swap.test.js has
 * asserted it all along.
 *
 * The client never knew. `isManager` was a plain role test, `admin_viewer` is
 * not that role, and so every screen that asked it hid its controls: the
 * employees table's actions column, approving a punch or a request, fixing
 * attendance, the contact list, editing a gantt. The interface was refusing
 * requests the server was willing to accept — and the person it refused was
 * אלעד בורקוב, a partner in the business who also runs תל אביב - יפו, who
 * could see all ninety employees and edit none of them.
 *
 * The rules now live in client/src/hooks/roleFlags.js with no React in them,
 * which is what makes this an assertion about behaviour rather than a regular
 * expression pointed at a component.
 *
 *   node scripts/viewer-client-manager.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'client', 'src', 'hooks', 'roleFlags.js');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

/**
 * The module is an ES module and this is CommonJS. Rather than add a build
 * step for one file, the exports are turned into a callable object — the file
 * is deliberately free of imports and side effects so this is safe, and the
 * test suite for design tokens does the same thing for the same reason.
 */
function loadRules() {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), 'roleFlags.js must stay import-free');
  const body = src.replace(/export\s+function/g, 'function');
  const names = [...src.matchAll(/export\s+function\s+(\w+)/g)].map((m) => m[1]);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn { ${names.join(', ')} };`)();
}

const R = loadRules();

// The real records, as the database holds them.
const elad = { role: 'admin_viewer', full_name: 'אלעד בורקוב', branch_id: 'tlv', managed_branch_ids: ['tlv'] };
const viewerNoBranch = { role: 'admin_viewer', full_name: 'צופה ללא סניף', managed_branch_ids: [] };
const manager = { role: 'branch_manager', managed_branch_ids: ['ksaba'] };
const admin = { role: 'system_admin' };
const accountant = { role: 'accountant' };
const teacher = { role: 'teacher' };

console.log('\nthe bug this closes');

check('אלעד may act as a manager', () => assert.strictEqual(R.isManagerRole(elad), true));
check('...and is still a viewer, not a manager by role', () => {
  assert.strictEqual(R.isViewerRole(elad), true);
  assert.strictEqual(elad.role, 'admin_viewer');
});
check('...and is not an admin', () => assert.strictEqual(R.isAdminRole(elad), false));

console.log('\nand what it must not open');

check('a viewer with no branch is not a manager', () =>
  assert.strictEqual(R.isManagerRole(viewerNoBranch), false));
check('a viewer with the key absent entirely is not a manager', () =>
  assert.strictEqual(R.isManagerRole({ role: 'admin_viewer' }), false));
check('a teacher is not a manager', () => assert.strictEqual(R.isManagerRole(teacher), false));
check('an accountant is not a manager by this flag', () =>
  assert.strictEqual(R.isManagerRole(accountant), false));
check('nobody at all is not a manager', () => {
  assert.strictEqual(R.isManagerRole(null), false);
  assert.strictEqual(R.isManagerRole(undefined), false);
  assert.strictEqual(R.isManagerRole({}), false);
});

console.log('\nthe roles that already worked still do');

check('a branch manager is a manager', () => assert.strictEqual(R.isManagerRole(manager), true));
check('an admin is a manager', () => assert.strictEqual(R.isManagerRole(admin), true));

console.log('\nwhich branch — the half the screen still has to ask');

check('אלעד manages his own branch', () =>
  assert.strictEqual(R.managesBranchOf(elad, 'tlv'), true));
check('...and not another one', () =>
  assert.strictEqual(R.managesBranchOf(elad, 'ksaba'), false));
check('an id given as an object id compares as a string', () =>
  assert.strictEqual(R.managesBranchOf(elad, { toString: () => 'tlv' }), true));
check('no branch at all is not his', () => {
  assert.strictEqual(R.managesBranchOf(elad, null), false);
  assert.strictEqual(R.managesBranchOf(elad, undefined), false);
});
check('an admin manages every branch', () =>
  assert.strictEqual(R.managesBranchOf(admin, 'anything'), true));
check('a manager does not manage a branch she was not given', () =>
  assert.strictEqual(R.managesBranchOf(manager, 'tlv'), false));

console.log('\nthe cross-branch view is unchanged');

check('a viewer sees all branches', () => assert.strictEqual(R.canSeeAllBranchesRole(elad), true));
check('an accountant sees all branches', () => assert.strictEqual(R.canSeeAllBranchesRole(accountant), true));
check('a one-branch manager does not', () => assert.strictEqual(R.canSeeAllBranchesRole(manager), false));
check('a two-branch manager does', () =>
  assert.strictEqual(R.canSeeAllBranchesRole({ role: 'branch_manager', managed_branch_ids: ['a', 'b'] }), true));

console.log('\nthe screen that shows her every branch at once');

const EM = path.join(__dirname, '..', '..', 'client', 'src', 'components', 'employees', 'EmployeeManager.jsx');
const em = fs.readFileSync(EM, 'utf8');
check('the employees table gates its row actions per branch', () => {
  assert.ok(/canEditEmployee/.test(em), 'no per-row gate in EmployeeManager');
  assert.ok(/managesBranch\(/.test(em), 'the per-row gate does not ask which branch');
});
check('...and does not drop the cell, which would break the table', () => {
  // The column must exist on every row; only its contents are withheld.
  assert.ok(/!canEditEmployee\(emp\) \? \(/.test(em), 'the cell itself is conditional');
});

console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
