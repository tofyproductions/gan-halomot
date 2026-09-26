#!/usr/bin/env node
/**
 * Who may read a single employee's payroll data.
 *
 * Before this guard, GET /payroll/employees/:id (and /salary, /hours-report,
 * /hours-range, /clock-users) answered ANY authenticated login — a teacher
 * could fetch any employee's bank account, rates and loans by iterating ids.
 * The rule under test, `branchInScope`, is the same one listEmployees and
 * salarySummary always enforced inline; these endpoints simply skipped it.
 *
 * Two layers are asserted:
 *   1. the rule itself (unit): admin/accountant see all; a branch manager only
 *      her managed branches; a plain employee only her own-branch fallback;
 *      an internal caller with no user passes (distribution jobs, self-tests);
 *   2. the wiring (text): the five routes carry requireBranchScope, so a
 *      plain-employee login is refused at the door before the controller runs.
 *      Textual on purpose — a route regression is a one-line deletion, and
 *      this is the cheapest net that catches it.
 *
 *   node scripts/payroll-employee-scope.test.js
 */
const fs = require('fs');
const path = require('path');

const { branchInScope } = require('../src/controllers/payroll.controller');

let failures = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
};

console.log('\n🔒 branchInScope — the rule\n');

const B1 = '64b000000000000000000001';
const B2 = '64b000000000000000000002';

ok(branchInScope({ role: 'system_admin' }, B1) === true, 'אדמין — כל סניף');
ok(branchInScope({ role: 'accountant' }, B1) === true, 'הנהלת חשבונות — כל סניף');
ok(branchInScope({ role: 'branch_manager', managed_branch_ids: [B1] }, B1) === true,
  'מנהלת סניף — הסניף שלה עובר');
ok(branchInScope({ role: 'branch_manager', managed_branch_ids: [B1] }, B2) === false,
  'מנהלת סניף — סניף אחר נחסם');
ok(branchInScope({ role: 'branch_manager', managed_branch_ids: [], branch_id: B1 }, B1) === true,
  'בלי managed — נופל ל-branch_id של עצמה');
ok(branchInScope({ role: 'teacher', branch_id: B1 }, B2) === false,
  'גננת — סניף זר נחסם');
// ObjectId vs string — the callers pass either; String() must equalize.
ok(branchInScope({ role: 'branch_manager', managed_branch_ids: [B1] }, { toString: () => B1 }) === true,
  'השוואה עמידה ל-ObjectId מול מחרוזת');
// No user = internal caller (hours distribution, pdf self-test) — passes free.
ok(branchInScope(null, B1) === true, 'קריאה פנימית בלי משתמש — עוברת');
ok(branchInScope(undefined, B1) === true, 'undefined — עובר (זהה)');

console.log('\n🚪 the five doors carry the gate\n');

const routesSrc = fs.readFileSync(
  path.join(__dirname, '../src/routes/payroll.routes.js'), 'utf8');

const gated = (routePart) => {
  const line = routesSrc.split('\n').find(l => l.includes(routePart) && l.includes('router.get'));
  return !!line && line.includes('requireBranchScope');
};

ok(gated("'/employees'"), 'GET /employees — רשימה');
ok(gated("'/employees/:id'"), 'GET /employees/:id — כרטיס מלא');
ok(gated("'/employees/:id/salary'"), 'GET /employees/:id/salary — פירוט שכר');
ok(gated("'/employees/:id/hours-report'"), 'GET /employees/:id/hours-report — דוח נוכחות');
ok(gated("'/employees/:id/hours-range'"), 'GET /employees/:id/hours-range — טווח חודשים');
ok(gated("'/clock-users'"), 'GET /clock-users — רשימת ת״ז של שעון');

console.log('\n🧍 the single-employee controllers apply the rule themselves\n');

// A branch manager passing the route gate must still be clamped to her own
// branches inside the controller — assert the check is present in each body.
const ctrlSrc = fs.readFileSync(
  path.join(__dirname, '../src/controllers/payroll.controller.js'), 'utf8');

const fnBody = (name) => {
  const start = ctrlSrc.indexOf(`async function ${name}(`);
  if (start === -1) return '';
  // Up to the next top-level function declaration — crude but stable here.
  const rest = ctrlSrc.slice(start + 10);
  const end = rest.search(/\n(?:async )?function /);
  return rest.slice(0, end === -1 ? undefined : end);
};

ok(fnBody('getEmployee').includes('branchInScope'), 'getEmployee בודק תיחום');
ok(fnBody('salaryForEmployee').includes('branchInScope'), 'salaryForEmployee בודק תיחום');
ok(fnBody('computeHoursReportData').includes('branchInScope'), 'computeHoursReportData בודק תיחום');
ok(fnBody('listClockUsers').includes('branchInScope'), 'listClockUsers בודק תיחום');

console.log('');
if (failures) {
  console.log(`❌ ${failures} בדיקות נכשלו`);
  process.exit(1);
}
console.log('✅ הכל עבר');
