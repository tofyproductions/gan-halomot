#!/usr/bin/env node
/**
 * The viewer role has to exist in exactly one list the model, the admin
 * screen's API and the tests all read — a role the model accepts but the
 * admin API refuses is a role nobody can be given.
 *
 *   node scripts/viewer-role-exists.test.js
 */
const { ROLES, ADMIN_VIEWER, ROLE_LABELS } = require('../src/constants/roles');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };

console.log('\n👀 תפקיד "מנהל מערכת - לצפייה בלבד"\n');
ok(ADMIN_VIEWER === 'admin_viewer', 'המזהה הוא admin_viewer');
ok(ROLES.includes('admin_viewer'), 'הרשימה המרכזית מכילה אותו');
ok(ROLE_LABELS.admin_viewer === 'מנהל מערכת - לצפייה בלבד', 'התווית בעברית מדויקת');
for (const r of ['system_admin', 'branch_manager', 'accountant', 'class_leader', 'teacher', 'assistant', 'cook']) {
  ok(ROLES.includes(r), `התפקיד הקיים ${r} עדיין ברשימה`);
}

// The model's enum must be the same list — not a copy that can drift.
const path = require('path');
const fs = require('fs');
const userSrc = fs.readFileSync(path.join(__dirname, '../src/models/User.js'), 'utf8');
ok(userSrc.includes("require('../constants/roles')"), 'User.js קורא את הרשימה מהקבוע המשותף');
const adminSrc = fs.readFileSync(path.join(__dirname, '../src/controllers/admin.controller.js'), 'utf8');
ok(adminSrc.includes("require('../constants/roles')"), 'admin.controller קורא את הרשימה מהקבוע המשותף');
ok(!/const ALLOWED_ROLES = \[/.test(adminSrc), 'אין עוד רשימה כפולה ALLOWED_ROLES');

console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
process.exit(failures ? 1 : 0);
