const { User, Registration } = require('../models');
const { isRead } = require('./viewer');
const { ADMIN_VIEWER, BRANCH_MANAGING_ROLES } = require('../constants/roles');
const { getBranchFilter } = require('./branch-filter');

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
  /**
   * A WRITE GRANT on a screen is a grant for every branch.
   *
   * `clicktac_write` (middleware/auth.js#requireTabWrite,
   * client/src/config/tabs.js) exists for the one person the office wants
   * filing רישום חיצוני — the ministry file for כפר סבא, the ClickTac export
   * for תל אביב, all of them. Scoping her to whatever branches happen to hang
   * off her account would grant the permission and then refuse the work.
   *
   * The flag is request-local and set in exactly one place: requireTabWrite,
   * on a request that just passed the grant. Nothing in a token or a database
   * row can produce it.
   */
  if (req?.tabWriteGrant) return null;

  const uid = req.user?.id || req.user?._id;
  let role = req.user?.role;
  let managed = (req.user?.managed_branch_ids || []).map(String);
  let ownBranch = req.user?.branch_id ? String(req.user.branch_id) : null;
  let classroomIds = (req.user?.classroom_ids || []).map(String);

  if (uid) {
    try {
      const dbUser = await User.findById(uid)
        .select('role managed_branch_ids branch_id classroom_ids is_active').lean();
      // Stashed for attachBranchScope's is_active check — the read already
      // happened, the middleware just needs its result.
      if (req && dbUser) req.userRecord = dbUser;
      if (dbUser) {
        role = dbUser.role;
        managed = (dbUser.managed_branch_ids || []).map(String);
        ownBranch = dbUser.branch_id ? String(dbUser.branch_id) : null;
        classroomIds = (dbUser.classroom_ids || []).map(String);
      }
    } catch { /* fall back to the token */ }
  }

  if (role === 'system_admin' || role === 'accountant') return null;
  // The viewer reads every branch and writes only the ones she manages. A
  // viewer with no managed branches writes nowhere — her own branch_id is
  // where she is listed, not what she runs.
  if (role === ADMIN_VIEWER) return isRead(req) ? null : managed;
  /**
   * `managed_branch_ids` הוא שדה של הנהלה, ועל שורה של גננת הוא רעש.
   *
   * עד עכשיו הוא **החליף** את הסניף שלה: מובילת כיתה בקפלן שעל השורה שלה
   * נשאר בטעות משה דיין קיבלה 403 על הסניף שבו היא עובדת — המסך אמר "אין לך
   * הרשאה לצפות בסניף המבוקש" והיא לא יכלה לעשות דבר. אצל מי שלא מנהל
   * סניפים, השיוך שלו הוא הסניף שלו, נקודה.
   */
  if (!BRANCH_MANAGING_ROLES.includes(role)) {
    /**
     * גננת שמשויכת לכיתה בסניף אחר עובדת שם.
     *
     * השיוך לכיתות הוא מה שמגדיר איפה היא עובדת, ולכן הסניפים של הכיתות
     * האלה נכנסים להרשאה יחד עם הסניף הרשום שלה. בלי זה, לשייך אותה לחדר
     * בסניף שני היה נותן לה כיתה שהיא רואה אבל כל בקשה עליה נדחית ב-403 —
     * הרשאה שניתנה ומיד נשללת היא גרועה מהרשאה שלא ניתנה.
     */
    const branches = new Set(ownBranch ? [ownBranch] : []);
    if (classroomIds.length) {
      const { Classroom } = require('../models');
      const rooms = await Classroom.find({ _id: { $in: classroomIds } })
        .select('branch_id').lean();
      rooms.forEach((r) => r.branch_id && branches.add(String(r.branch_id)));
    }
    return [...branches];
  }
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
 * may actually write. `actual_role` is set by middleware/auth.js whenever it
 * serves a viewer as somebody else — the read swap, and the branch_manager
 * write fallback; every other caller gets the list back untouched. (Only the
 * two GETs above call this, so the write fallback never reaches it.)
 */
function materializeScope(req, readBranchIds) {
  if (req?.user?.actual_role !== ADMIN_VIEWER) return readBranchIds;
  const managed = (req.user.managed_branch_ids || []).map(String);
  if (managed.length === 0) return [];
  return (readBranchIds || []).filter(id => managed.includes(String(id)));
}

/**
 * The registration ids this request may touch — for models that carry no
 * branch_id of their own (Child, Document) and reach a branch only through
 * their Registration. Returns null for "all branches" (admin/accountant), or
 * the concrete id list otherwise. Uses getBranchFilter so an admin narrowing
 * with ?branch and a manager scoped to her branches go through one code path.
 */
async function registrationIdsInScope(req) {
  const bf = getBranchFilter(req, 'branch_id');
  if (Object.keys(bf).length === 0) return null; // admin, no branch narrowing → all
  return Registration.find(bf).distinct('_id');
}

/**
 * Ownership check for a resource that reaches a branch through a Registration.
 * Fails closed: an admin passes, an unknown/foreign registration is refused.
 */
async function canAccessRegistration(req, registrationId) {
  const bf = getBranchFilter(req, 'branch_id');
  if (Object.keys(bf).length === 0) return true; // admin, all branches
  if (!registrationId) return false;
  const reg = await Registration.findOne({ _id: registrationId, ...bf }).select('_id').lean();
  return !!reg;
}

module.exports = {
  resolveBranchScope, canAccessBranch, materializeScope,
  registrationIdsInScope, canAccessRegistration,
};
