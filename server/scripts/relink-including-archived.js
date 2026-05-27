#!/usr/bin/env node
/**
 * One-off: link orphan punches (employee_id: null) to employees, INCLUDING
 * archived (is_active: false) employees and across branches.
 *
 * Why: the agent ingest, the Employee post-save hook, and
 * import-historical-punches.js all match only ACTIVE employees. Former staff
 * who were archived keep a trail of orphan historical punches. This attributes
 * those punches to the (archived) person so historical salary/attendance
 * reports are complete. Cross-branch is handled too — a Moshe-Dayan employee
 * who occasionally helped at Kaplan links to their home record.
 *
 * Precedence on duplicate israeli_id: ACTIVE beats archived; within the same
 * status, first found wins.
 *
 * Safe to re-run.  Usage: node scripts/relink-including-archived.js [--dry]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const DRY = process.argv.includes('--dry');
const norm = v => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 7 && d.length <= 9 ? d.padStart(9, '0') : d; };

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const { Punch, Employee, Branch } = require('../src/models');

  const branches = await Branch.find({}).select('name').lean();
  const bn = Object.fromEntries(branches.map(b => [String(b._id), b.name]));

  // Build israeli_id -> employee map, ACTIVE taking precedence over archived.
  const emps = await Employee.find({}).select('full_name israeli_id branch_id is_active').lean();
  const byId = new Map();
  for (const e of emps.sort((a, b) => (b.is_active === true) - (a.is_active === true))) {
    if (!e.israeli_id) continue;
    const k = norm(e.israeli_id);
    if (!byId.has(k)) byId.set(k, e);
  }
  console.log(`Loaded ${emps.length} employees (${byId.size} unique israeli_ids, active-preferred)`);

  const orphans = await Punch.find({ employee_id: null, israeli_id: { $ne: null, $ne: '' } })
    .select('_id branch_id israeli_id').lean();
  console.log(`Found ${orphans.length} orphan punches`);

  const ops = new Map();            // empId -> [punchIds]
  const report = new Map();         // empId -> { name, home, active, count, fromBranches:Set }
  let unmatched = 0;
  for (const o of orphans) {
    const e = byId.get(norm(o.israeli_id));
    if (!e) { unmatched++; continue; }
    const k = String(e._id);
    if (!ops.has(k)) { ops.set(k, []); report.set(k, { name: e.full_name, home: bn[String(e.branch_id)], active: e.is_active, count: 0, fromBranches: new Set() }); }
    ops.get(k).push(o._id);
    const r = report.get(k); r.count++; r.fromBranches.add(bn[String(o.branch_id)]);
  }

  let totalLink = 0; for (const ids of ops.values()) totalLink += ids.length;
  console.log(`\n=== PLAN ===`);
  console.log(`  will link: ${totalLink} punches to ${ops.size} employees`);
  console.log(`  unmatched (still no employee): ${unmatched}`);
  console.log(`\n=== employees getting linked ===`);
  for (const [, r] of [...report.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${String(r.count).padStart(4)}  ${r.name.padEnd(26)} [${r.active ? 'פעיל' : 'ארכיון'}] בית:${r.home} ← החתמות מ: ${[...r.fromBranches].join(', ')}`);
  }

  if (DRY) { console.log('\n(DRY RUN — no writes)'); await mongoose.disconnect(); return; }

  const bulk = [...ops.entries()].map(([empId, ids]) => ({
    updateMany: { filter: { _id: { $in: ids } }, update: { $set: { employee_id: empId } } },
  }));
  if (bulk.length) {
    const r = await Punch.bulkWrite(bulk, { ordered: false });
    console.log(`\nbulkWrite: modified ${r.modifiedCount} punches across ${bulk.length} employees.`);
  } else {
    console.log('\nNothing to link.');
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
