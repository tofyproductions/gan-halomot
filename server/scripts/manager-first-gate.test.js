#!/usr/bin/env node
/**
 * THE MANAGER IS THE FIRST GATE — the owner's rule (26.09.2026) for
 * employee self-reported punches:
 *
 *   1. an accountant may NOT approve a self-report the branch manager has
 *      not reviewed (server refuses with MANAGER_STAGE_FIRST);
 *   2. system_admin keeps the bypass — the escape hatch for a branch with no
 *      functioning manager — and it stays recorded as a bypass;
 *   3. the panel tells the accountant WHY the button is disabled instead of
 *      letting the click bounce off a 403.
 *
 * Textual assertions on the real sources — the same last-resort net the
 * scope tests use: each of these rules is one edited line away from quietly
 * disappearing.
 *
 *   node scripts/manager-first-gate.test.js
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
};

const server = fs.readFileSync(
  path.join(__dirname, '../src/controllers/payroll.controller.js'), 'utf8');

console.log('\n🚪 the server rule\n');
ok(server.includes("role === 'accountant'") && server.includes("code: 'MANAGER_STAGE_FIRST'"),
  'הנהח"ש נחסמת בשלב-מנהל עם קוד ברור');
// The refusal must sit on the manager stage, not somewhere else.
const refusalIdx = server.indexOf("code: 'MANAGER_STAGE_FIRST'");
const windowBefore = server.slice(Math.max(0, refusalIdx - 600), refusalIdx);
ok(windowBefore.includes("st === 'pending_manager'"),
  'החסימה מותנית בשלב pending_manager');
ok(server.includes("(st === 'pending_manager' || st === 'pending') && role === 'system_admin'"),
  'מעקף האדמין נשאר — ומוגבל לאדמין בלבד');
ok(server.includes('manager_bypassed = true'),
  'מעקף אדמין עדיין נרשם על ההחתמה');
// The old blanket bypass (isFinal = admin OR accountant) must be gone.
ok(!server.includes("(st === 'pending_manager' || st === 'pending') && isFinal"),
  'המעקף הגורף הישן (isFinal) איננו');

console.log('\n🖥️ the panel\n');
const panel = fs.readFileSync(
  path.join(__dirname, '../../client/src/components/attendance/PendingPunchApprovals.jsx'), 'utf8');
ok(panel.includes("stage === 'manager' && isAccountant && !isAdmin"),
  'הכפתור מנוטרל להנהח"ש בשלב-מנהל (ולא לאדמין)');
ok(panel.includes('ממתין קודם לאישור מנהל/ת הסניף'),
  'וההסבר נאמר במקום להשאיר כפתור מת');
ok(panel.includes('disabled={accountantBlocked}'),
  'הנטרול מחובר לכפתור עצמו');

console.log('\n👁️ source is visually distinct\n');
ok(panel.includes('✍️ דיווח עצמי') && panel.includes('⌚ שעון'),
  'דיווח עצמי ⌍ שעון פיזי מסומנים באייקונים שונים');
ok(panel.includes('לא החתמה פיזית בשעון'),
  'ה-tooltip אומר במפורש שדיווח עצמי אינו החתמת שעון');

console.log('');
if (failures) { console.log(`❌ ${failures} נכשלו`); process.exit(1); }
console.log('✅ הכל עבר');
