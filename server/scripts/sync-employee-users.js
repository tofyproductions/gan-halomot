#!/usr/bin/env node
/**
 * Backfill: give every active employee a login, and make the login's role
 * match her job title.
 *
 * Replaces the old create-users-for-employees.js, which hardcoded
 * `role: 'teacher'` for everyone — that, plus an update path that never
 * touched User at all, is why managers showed up as גננת (or not at all) in
 * "ניהול הרשאות". The mapping and all the linking rules now live in
 * services/userSync.js, so this script and the live create/update path can
 * never drift apart again.
 *
 * Role changes are opt-in: by default the script only creates missing logins
 * and refreshes name/branch/title. Pass --roles to also rewrite roles from
 * positions (it still refuses to touch system_admin).
 *
 * Usage:
 *   node scripts/sync-employee-users.js --dry-run
 *   node scripts/sync-employee-users.js
 *   node scripts/sync-employee-users.js --roles
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Employee, User, Branch } = require('../src/models');
const { syncEmployeeUser, roleForPosition, normalizeIsraeliId } = require('../src/services/userSync');

const DRY_RUN = process.argv.includes('--dry-run');
const WITH_ROLES = process.argv.includes('--roles');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected. mode=${DRY_RUN ? 'DRY RUN' : 'WRITE'} roles=${WITH_ROLES ? 'on' : 'off'}\n`);

  const branches = new Map((await Branch.find().select('name').lean()).map(b => [String(b._id), b.name]));
  const employees = await Employee.find({ is_active: true }).sort({ full_name: 1 });

  const noId = [];
  let created = 0, updated = 0, roleFixed = 0, untouched = 0, failed = 0;

  for (const emp of employees) {
    const branchName = branches.get(String(emp.branch_id)) || '—';
    if (!normalizeIsraeliId(emp.israeli_id)) {
      noId.push(`${emp.full_name} (${branchName})`);
      continue;
    }

    const wantedRole = roleForPosition(emp.position);
    const linked = emp.user_id ? await User.findById(emp.user_id).lean() : null;

    if (DRY_RUN) {
      if (!linked) {
        console.log(`  + CREATE  ${emp.full_name} | ${emp.position || '—'} | ${branchName} → role=${wantedRole || 'teacher'}`);
        created++;
      } else if (WITH_ROLES && wantedRole && wantedRole !== linked.role && linked.role !== 'system_admin') {
        console.log(`  ~ ROLE    ${emp.full_name} | ${emp.position || '—'} | ${linked.role} → ${wantedRole}`);
        roleFixed++;
      } else {
        untouched++;
      }
      continue;
    }

    try {
      const before = linked?.role;
      const res = await syncEmployeeUser(emp, { positionChanged: WITH_ROLES });
      if (!res.user) { failed++; continue; }
      if (res.created) {
        console.log(`  + created ${emp.full_name} | ${emp.position || '—'} | ${branchName} → ${res.user.role}`);
        created++;
      } else if (before && res.user.role !== before) {
        console.log(`  ~ role    ${emp.full_name}: ${before} → ${res.user.role}`);
        roleFixed++;
      } else if (res.updated) {
        console.log(`  · synced  ${emp.full_name}`);
        updated++;
      } else {
        untouched++;
      }
    } catch (err) {
      console.error(`  ! failed  ${emp.full_name}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nCreated: ${created}  Roles fixed: ${roleFixed}  Field-synced: ${updated}  Unchanged: ${untouched}  Failed: ${failed}`);
  if (noId.length) {
    console.log(`\nNo ת"ז — cannot get a login until one is entered (${noId.length}):`);
    noId.forEach(n => console.log(`  - ${n}`));
  }
  await mongoose.disconnect();
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
