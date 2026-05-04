#!/usr/bin/env node
/**
 * One-off backfill: link existing orphan punches to employees, including
 * cross-branch matches.
 *
 * Before this change the agent only matched a punch to an employee in the
 * SAME branch. Anyone visiting another branch left a string of `employee_id:
 * null` punches there. After the cross-branch fix in agent.controller.js
 * those new punches are matched correctly, but the historical orphans are
 * still null. This script walks the orphans once and links what it can.
 *
 * Safe to re-run.
 *
 * Usage:
 *   node scripts/relink-cross-branch.js          # do the work
 *   node scripts/relink-cross-branch.js --dry    # report only
 */
require('dotenv').config();
const mongoose = require('mongoose');

const DRY = process.argv.includes('--dry');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const { Punch, Employee, Branch } = require('../src/models');

  // Load all active employees keyed by israeli_id. If the same id exists in
  // two branches (data quirk), keep the FIRST one — same precedence as the
  // agent uses now.
  const employees = await Employee.find({ is_active: true })
    .select('_id israeli_id branch_id full_name')
    .lean();
  const byIsraeliId = new Map();
  for (const e of employees) {
    if (!e.israeli_id) continue;
    if (!byIsraeliId.has(e.israeli_id)) byIsraeliId.set(e.israeli_id, e);
  }
  console.log(`Loaded ${employees.length} active employees, ${byIsraeliId.size} unique israeli_ids`);

  const branches = await Branch.find({}).select('_id name').lean();
  const branchById = new Map(branches.map(b => [String(b._id), b.name]));

  const orphans = await Punch.find({
    employee_id: null,
    israeli_id: { $ne: null, $ne: '' },
  }).select('_id branch_id israeli_id').lean();
  console.log(`Found ${orphans.length} orphan punches to inspect`);

  // Group orphans by (israeli_id, branch_id) so we can do one bulkWrite
  // updating per employee, with cross-branch counts for the report.
  const updates = new Map();             // employeeId(string) -> [orphan _ids]
  const sameBranchByEmp = new Map();     // employeeId -> count of same-branch orphans
  const crossBranchByEmp = new Map();    // employeeId -> Map(visitedBranchId -> count)
  let unmatched = 0;
  const unmatchedSampleIds = new Set();

  for (const o of orphans) {
    const emp = byIsraeliId.get(o.israeli_id);
    if (!emp) {
      unmatched++;
      if (unmatchedSampleIds.size < 30) unmatchedSampleIds.add(o.israeli_id);
      continue;
    }
    const empKey = String(emp._id);
    if (!updates.has(empKey)) updates.set(empKey, []);
    updates.get(empKey).push(o._id);

    if (String(o.branch_id) === String(emp.branch_id)) {
      sameBranchByEmp.set(empKey, (sameBranchByEmp.get(empKey) || 0) + 1);
    } else {
      if (!crossBranchByEmp.has(empKey)) crossBranchByEmp.set(empKey, new Map());
      const m = crossBranchByEmp.get(empKey);
      m.set(String(o.branch_id), (m.get(String(o.branch_id)) || 0) + 1);
    }
  }

  let totalLinked = 0;
  for (const [empKey, ids] of updates) totalLinked += ids.length;

  console.log('');
  console.log('=== PLAN ===');
  console.log(`  orphans considered:  ${orphans.length}`);
  console.log(`  will link:           ${totalLinked}`);
  console.log(`  unmatched (skipped): ${unmatched}`);
  if (unmatchedSampleIds.size) {
    console.log(`  sample unmatched ids: ${[...unmatchedSampleIds].slice(0, 15).join(', ')}${unmatchedSampleIds.size > 15 ? ' …' : ''}`);
  }

  // Per-employee report (top 20 by count, with cross-branch breakdown)
  const empReport = [...updates.entries()].map(([empKey, ids]) => {
    const emp = employees.find(e => String(e._id) === empKey);
    const cross = crossBranchByEmp.get(empKey) || new Map();
    const crossList = [...cross.entries()].map(([bid, n]) => `${branchById.get(bid) || bid}:${n}`).join(', ');
    return {
      name: emp?.full_name || empKey,
      home: branchById.get(String(emp?.branch_id)) || '?',
      total: ids.length,
      same: sameBranchByEmp.get(empKey) || 0,
      cross: [...cross.values()].reduce((s, n) => s + n, 0),
      crossList,
    };
  }).sort((a, b) => b.total - a.total);

  console.log('');
  console.log('=== TOP 20 by orphan count ===');
  console.log('  name                                    home               total  same  cross  cross-by-branch');
  for (const r of empReport.slice(0, 20)) {
    console.log(`  ${(r.name).padEnd(38)} ${(r.home).padEnd(18)} ${String(r.total).padStart(5)} ${String(r.same).padStart(5)} ${String(r.cross).padStart(6)}  ${r.crossList}`);
  }

  if (DRY) {
    console.log('\n(DRY RUN — no writes)');
    await mongoose.disconnect();
    return;
  }

  // Apply with bulkWrite, batched by employee. Each updateMany is one round
  // trip so this is fast even for many employees.
  console.log('\n=== APPLYING ===');
  const ops = [...updates.entries()].map(([empKey, ids]) => ({
    updateMany: {
      filter: { _id: { $in: ids } },
      update: { $set: { employee_id: empKey } },
    },
  }));
  if (ops.length === 0) {
    console.log('Nothing to write.');
    await mongoose.disconnect();
    return;
  }
  const t0 = Date.now();
  const result = await Punch.bulkWrite(ops, { ordered: false });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`bulkWrite done in ${dt}s — modified ${result.modifiedCount} punches across ${ops.length} employees.`);

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
