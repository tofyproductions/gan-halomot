/**
 * Who runs this gan — the one answer, for every place that needs to reach her.
 *
 * Eight queries asked this independently and all eight asked `role:
 * 'branch_manager'`, which is a question about a job title. It stopped being
 * the same question the day admin_viewer shipped: constants/roles.js has said
 * ever since that a viewer "acts as a branch manager inside its own
 * managed_branch_ids", and not one query was taught to read it.
 *
 * תל אביב - יפו has no branch_manager. Its manager is an admin_viewer, so all
 * eight returned an empty list — no punch reminder, no lead, no task, no
 * payslip, no letter issuer, no push notification — and the screen reported
 * "לא מוגדר מנהל לסניף זה", which was true of the query and false of the gan.
 *
 * A rule that lives in eight WHERE clauses is eight rules. This is one.
 *
 * ── The three parts of the answer ──
 *
 * ROLE. A branch_manager, or an admin_viewer covering this branch. For a
 * branch_manager, `branch_id` still stands in for an empty
 * `managed_branch_ids` — that fallback predates the multi-branch field and
 * older accounts rely on it. For a viewer it deliberately does NOT: a viewer
 * reads every branch, so `branch_id` on that account is a home branch like any
 * teacher's, and treating it as a claim to RUN the branch would quietly hand a
 * gan's payroll mail to somebody filed there for convenience.
 *
 * ACTIVE. Three of the eight never filtered `is_active`, so a manager who left
 * kept receiving payroll mail at her old address. Absent means active — the
 * field arrived after most accounts did, and a missing flag must not silence
 * somebody who is still here.
 *
 * NOT A TEST ACCOUNT. "Google Reviewer" exists so Google can sign in and review
 * the store build, and is filed as a branch_manager of כפר סבא - קפלן. It sat
 * in the recipient list beside the real manager, receiving her reminders and
 * her staff's payslips. The flag takes an account out of the mail without
 * touching its ability to log in, which is the whole reason it exists.
 *
 * ── What this is NOT ──
 *
 * Not permission. Nothing here decides what anybody may READ or WRITE; that is
 * middleware/auth.js and utils/viewer.js, and it has its own rules. A viewer
 * reached through this file still writes as a proposal. This answers one
 * question only: when the system has something to say about a branch, who
 * hears it.
 */

const { ADMIN_VIEWER } = require('../constants/roles');

/** The roles that can run a branch. Exported so callers can say why, not just who. */
const MANAGER_ROLES = ['branch_manager', ADMIN_VIEWER];

/** An account that is not switched off. Absent means active — see above. */
const IS_ACTIVE = { $ne: false };

/** An account that is not a stand-in for a person. Absent means real. */
const NOT_TEST = { $ne: true };

/**
 * The role clauses, as an array, so a caller can lay them beside its own.
 *
 * agent.controller asks for system admins AND this branch's managers in one
 * query; returning the pieces lets it write that as one `$or` instead of two
 * round trips or a hand-copied clause that drifts.
 */
function branchManagerClauses(branchId) {
  return [
    // The manager's own branch_id still counts — accounts predating
    // managed_branch_ids have nothing else.
    { role: 'branch_manager', $or: [{ managed_branch_ids: branchId }, { branch_id: branchId }] },
    // The viewer's does not. Only branches she was explicitly given.
    { role: ADMIN_VIEWER, managed_branch_ids: branchId },
  ];
}

/**
 * The whole filter: who runs this branch, is still here, and is a real person.
 *
 * `extra` is merged in first so a caller can add its own conditions (an email
 * that exists, a name sort's projection) without being able to quietly drop the
 * three that make this correct.
 */
function branchManagerFilter(branchId, extra = {}) {
  return {
    ...extra,
    is_active: IS_ACTIVE,
    is_test_account: NOT_TEST,
    $or: branchManagerClauses(branchId),
  };
}

/**
 * The same question for several branches at once, for the screens that build a
 * table. `$in` against an array field matches on membership, exactly as the
 * single-branch form does against one value.
 */
function branchManagersFilter(branchIds, extra = {}) {
  const ids = (Array.isArray(branchIds) ? branchIds : [branchIds]).filter(Boolean);
  return {
    ...extra,
    is_active: IS_ACTIVE,
    is_test_account: NOT_TEST,
    $or: [
      { role: 'branch_manager', $or: [{ managed_branch_ids: { $in: ids } }, { branch_id: { $in: ids } }] },
      { role: ADMIN_VIEWER, managed_branch_ids: { $in: ids } },
    ],
  };
}

/**
 * Which of `branchIds` this user covers — the read side of the same rule.
 *
 * The bulk query returns people; the caller then has to file each one under the
 * branches she runs, and doing that by hand is where the viewer gets dropped a
 * second time.
 */
function branchesCoveredBy(user, branchIds) {
  const wanted = new Set((branchIds || []).map(String));
  const managed = (user.managed_branch_ids || []).map(String);
  const covers = managed.length
    ? managed
    // Only a branch_manager falls back to branch_id.
    : (user.role === 'branch_manager' && user.branch_id ? [String(user.branch_id)] : []);
  return covers.filter(id => wanted.has(id));
}

module.exports = {
  MANAGER_ROLES,
  branchManagerClauses,
  branchManagerFilter,
  branchManagersFilter,
  branchesCoveredBy,
};
