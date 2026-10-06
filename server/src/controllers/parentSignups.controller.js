const { signups } = require('../services/parentSignups.service');
const { canAccessBranch } = require('../utils/branch-scope');

/**
 * מעקב הורים רשומים — who got into the portal, and who the office still has
 * to chase.
 *
 * Read-only, and management only. The rows carry ID numbers and mobile
 * numbers of families, so the screen is an office tool rather than something
 * the whole staff room opens: the question it answers — who to ring — is the
 * office's question.
 *
 * `branch` narrows; it never widens. Which branches the caller may see is
 * decided here from their own scope and not from what they asked for, the way
 * every other branch-scoped read in the system decides it.
 */
async function list(req, res, next) {
  try {
    const scope = req.branchScope; // null = every branch (system_admin, accountant)
    const asked = req.query.branch && req.query.branch !== 'all' ? String(req.query.branch) : null;

    // A branch outside the caller's scope is refused outright rather than
    // answered with an empty list: silence would read as "this branch has no
    // parents", which is a different and wrong statement.
    if (asked && !(await canAccessBranch(req, asked))) {
      return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
    }

    let branchIds = null;
    if (asked) branchIds = [asked];
    else if (Array.isArray(scope)) branchIds = scope.map(String);

    const data = await signups({ branchIds, classroom: req.query.classroom || '' });
    res.json(data);
  } catch (error) { next(error); }
}

module.exports = { list };
