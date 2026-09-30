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

/**
 * ── Turning those people into addresses mail can actually reach ─────────────
 *
 * Every caller that MAILS a branch's managers wrote the same line —
 * `managers.map(m => m.email).filter(Boolean)` — and `filter(Boolean)` asks
 * whether a string is present, not whether a mailbox is.
 *
 * Most logins in this system carry a synthetic handle built from the ת"ז,
 * `<ת"ז>@gan-halomot.local` (services/userSync.js). It is a correct LOGIN and
 * it is not a mailbox: `.local` is a reserved suffix that resolves nowhere, so
 * every message addressed to one fails and bounces. Five places already guard
 * against it — order.controller, order-dispatch, payslipAudit, payrollMonth and
 * office-recipients — and the eight that mail branch managers did not, so a
 * manager whose account was created from her employee row and never given a
 * real address received nothing: no punch reminder, no candidate, no lead, no
 * payslip, no contract, no letter. Found on 30.09.2026 with two live managers in
 * exactly that state, covering three of the four branches.
 *
 * WHY THE FALLBACK AND NOT JUST THE FILTER. Dropping the address silently turns
 * a bounce into nothing at all, and this codebase has already decided which of
 * those is worse: office-recipients says "a fault report that reaches the wrong
 * person is a nuisance; one that reaches nobody is the failure this whole system
 * exists to prevent." So when a branch has no reachable manager the message goes
 * to the office instead, carrying a line that says who it was meant for. The
 * work still gets done by somebody, and the missing address announces itself.
 *
 * `isRealEmail` is office-recipients' — one definition of "an address mail can
 * reach", so the two services cannot drift into disagreeing about it.
 */
const { isRealEmail, officeEmails } = require('./office-recipients.service');

/**
 * @param {Array}  managers  the user docs a branchManager*Filter query returned
 * @param {String} opts.what a few words naming the message, for the notice line
 * @param {String} opts.branchName  for the notice line
 * @returns {{ to: String[], notice: String, unreachable: Array, fell_back: Boolean }}
 *          `notice` is an HTML paragraph to put at the top of the body, or ''.
 */
async function mailableManagerEmails(managers, { what = 'הודעה', branchName = '' } = {}) {
  const list = Array.isArray(managers) ? managers : [];
  const to = [...new Set(list.map(m => m?.email).filter(isRealEmail))];
  const unreachable = list
    .filter(m => m?.email && !isRealEmail(m.email))
    .map(m => ({ name: m.full_name || '', email: m.email }));

  if (to.length) {
    // Somebody real is on the list. A second manager without an address is not
    // worth a notice on a message that reached its manager anyway — the daily
    // alert below is where that belongs.
    if (unreachable.length) warnUnreachable(unreachable, branchName);
    return { to, notice: '', unreachable, fell_back: false };
  }

  warnUnreachable(unreachable, branchName);
  const office = await officeEmails('system_faults');
  const who = unreachable.map(u => u.name).filter(Boolean).join(', ');
  const notice = office.length
    ? `<p style="background:#fde8e8;border-right:4px solid #c53030;padding:10px;margin:0 0 14px">
         <b>ההודעה הזאת הגיעה אליכם כי אין למי לשלוח אותה.</b><br/>
         ${what}${branchName ? ` של סניף ${branchName}` : ''} אמור היה להישלח
         ${who ? `אל ${who}` : 'למנהל/ת הסניף'}, ואין ל${who ? 'ה' : 'מנהל/ת'} כתובת
         מייל אמיתית במערכת — רק ידית התחברות.<br/>
         לתיקון: מסך העובדים ← כרטיס העובדת ← שדה אימייל.
       </p>`
    : '';
  return { to: office, notice, unreachable, fell_back: true };
}

/**
 * One line in the log per unreachable manager, at most once a day each.
 *
 * In memory on purpose: the point is to make the situation visible to whoever
 * reads the logs without turning every payslip run into a hundred identical
 * lines. A restart re-arms it, which costs one extra line and needs no storage.
 */
const warned = new Map();
function warnUnreachable(unreachable, branchName) {
  const today = new Date().toISOString().slice(0, 10);
  for (const u of unreachable) {
    const key = `${today}:${u.email}`;
    if (warned.has(key)) continue;
    if (warned.size > 500) warned.clear();
    warned.set(key, true);
    console.warn(`[recipients] אין כתובת מייל אמיתית ל${u.name || 'מנהל/ת'}`
      + `${branchName ? ` (${branchName})` : ''} — ${u.email}. ההודעות עוברות למשרד.`);
  }
}

module.exports = {
  MANAGER_ROLES,
  branchManagerClauses,
  branchManagerFilter,
  branchManagersFilter,
  branchesCoveredBy,
  mailableManagerEmails,
};
