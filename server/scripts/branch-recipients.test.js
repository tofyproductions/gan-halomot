#!/usr/bin/env node
/**
 * Who is "the manager of this branch", asked once.
 *
 * Eight places asked it separately, and all eight asked it the same wrong way:
 * `role: 'branch_manager'`. That is a question about a job title, not about who
 * runs a gan, and the two stopped being the same thing the day admin_viewer
 * shipped — constants/roles.js has said since then that a viewer "acts as a
 * branch manager inside its own managed_branch_ids", and no query ever read it.
 *
 * תל אביב - יפו has no branch_manager at all. Its manager is an admin_viewer,
 * so every one of the eight returned nobody: no punch reminder, no lead, no
 * task, no payslip, no letter issuer, no push. The screen said "לא מוגדר מנהל
 * לסניף זה" and was, by its own query, telling the truth.
 *
 * The other two things the eight disagreed about, now settled in one place:
 *
 * is_active — three of the eight never filtered it, so a manager who left the
 * gan kept receiving payroll mail. A recipient who no longer works here is not
 * a recipient.
 *
 * Test accounts — "Google Reviewer" exists so Google can sign in and review the
 * app, and it is filed as a branch_manager of כפר סבא - קפלן. It was standing
 * in the same list as the real manager, receiving her reminders and her staff's
 * payslips. A flag keeps the login working and takes it out of the mail.
 *
 *   node scripts/branch-recipients.test.js
 */

const {
  branchManagerClauses,
  branchManagerFilter,
  MANAGER_ROLES,
} = require('../src/services/branch-recipients.service');
const { ADMIN_VIEWER } = require('../src/constants/roles');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

/**
 * The filter, applied to a user in memory.
 *
 * The real query runs in Mongo, so a test that only inspected the object shape
 * would pass while matching the wrong people. This evaluates the same operators
 * Mongo would ($or, $in, $ne, and a scalar against an array), which is the only
 * way to say "this user IS reached" rather than "the filter mentions her".
 */
function matches(filter, user) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some(sub => matches(sub, user));
    const value = user[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$in' in cond) return cond.$in.includes(value);
      if ('$ne' in cond) return value !== cond.$ne;
    }
    // Mongo matches a scalar against an array field by membership.
    if (Array.isArray(value)) return value.map(String).includes(String(cond));
    return String(value) === String(cond);
  });
}

const TLV = 'branch-tlv';
const KFAR = 'branch-kfar';

const person = (over = {}) => ({
  full_name: 'מישהי',
  role: 'teacher',
  is_active: true,
  is_test_account: false,
  managed_branch_ids: [],
  branch_id: null,
  ...over,
});

const reaches = (user, branchId = TLV) => matches(branchManagerFilter(branchId), user);

console.log('\n👥 מי מקבל/ת את ההודעות של הסניף\n');

console.log('מנהלת סניף — כמו שהיה');
{
  ok(reaches(person({ role: 'branch_manager', managed_branch_ids: [TLV] })),
    'מנהלת סניף לפי managed_branch_ids');
  ok(reaches(person({ role: 'branch_manager', branch_id: TLV })),
    'ומנהלת סניף שיש לה רק branch_id — הנפילה לאחור נשמרת');
  ok(!reaches(person({ role: 'branch_manager', managed_branch_ids: [KFAR] })),
    'מנהלת של סניף אחר לא נכנסת');
  ok(!reaches(person({ role: 'teacher', branch_id: TLV })),
    'גננת בסניף היא לא מנהלת הסניף');
}

console.log('\nמנהל מערכת לצפייה בלבד — הבאג שדווח');
{
  ok(reaches(person({ role: ADMIN_VIEWER, managed_branch_ids: [TLV] })),
    'אלעד מנהל את תל אביב ולכן מקבל — זה מה שנשבר');
  ok(!reaches(person({ role: ADMIN_VIEWER, managed_branch_ids: [KFAR] })),
    'אבל רק את הסניפים שלו');

  // A viewer reads every branch. branch_id on such an account is a home
  // branch like any teacher's, not a claim to run it — so unlike a
  // branch_manager, it does not stand in for managed_branch_ids.
  ok(!reaches(person({ role: ADMIN_VIEWER, branch_id: TLV })),
    'branch_id לבדו אינו ניהול סניף אצל צופה — רק שיוך בית');

  ok(MANAGER_ROLES.includes(ADMIN_VIEWER) && MANAGER_ROLES.includes('branch_manager'),
    'שני התפקידים מוכרזים במקום אחד');
}

console.log('\nמי שכבר לא כאן');
{
  ok(!reaches(person({ role: 'branch_manager', managed_branch_ids: [TLV], is_active: false })),
    'מנהלת שסומנה לא פעילה לא מקבלת — שלושה מהמקומות שלחו לה עד היום');
  ok(reaches(person({ role: 'branch_manager', managed_branch_ids: [TLV], is_active: undefined })),
    'חשבון ותיק בלי השדה כלל נחשב פעיל');
}

console.log('\nחשבונות בדיקה');
{
  ok(!reaches(person({ role: 'branch_manager', managed_branch_ids: [TLV], is_test_account: true })),
    'חשבון בדיקה לא נכנס לרשימת הנמענים');
  ok(reaches(person({ role: 'branch_manager', managed_branch_ids: [TLV], is_test_account: undefined })),
    'ובלי השדה — חשבון רגיל לכל דבר, כך שאף אחד לא נופל בשקט');
}

console.log('\nהרכבה');
{
  const clauses = branchManagerClauses(TLV);
  eq(clauses.length, 2, 'שני סעיפים — אחד לכל תפקיד');

  // agent.controller reaches system admins AND the branch's managers in one
  // query. It has to be able to lay these beside its own clause.
  const composed = {
    is_active: { $ne: false },
    $or: [{ role: 'system_admin' }, ...clauses],
  };
  ok(matches(composed, person({ role: 'system_admin' })),
    'מנהל מערכת נכנס כשמרכיבים את הסעיפים עם עוד תנאי');
  ok(matches(composed, person({ role: ADMIN_VIEWER, managed_branch_ids: [TLV] })),
    'ואלעד נכנס באותה שאילתה');

  const extra = branchManagerFilter(TLV, { email: { $ne: null } });
  ok(extra.email !== undefined, 'אפשר להוסיף תנאים משלך לסינון');
  ok(!reaches(person({ role: 'branch_manager', managed_branch_ids: [] })),
    'בלי שיוך לסניף — לא נכנסים');
}

console.log(`\n${failures === 0 ? '✅ הכול עבר' : `❌ ${failures} נכשלו`}\n`);
process.exit(failures === 0 ? 0 : 1);
