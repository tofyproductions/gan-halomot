/**
 * Give every employee a Latin name for the attendance clocks.
 *
 * The device holds a name in a fixed 24-byte field and does not store UTF-8, so
 * a Hebrew name truncates mid-character and comes back as mojibake — the read
 * from the הרצליה clock returned אדולה מהרט as "WWWWW WWW(W".
 * Nobody standing at the device can find anyone in that list.
 *
 * This fills `Employee.clock_name` and, with --push, rewrites the name on every
 * device the employee is already enrolled on. The rewrite is an `add_user`: the
 * agent has no `update_user`, and re-adding an existing ת"ז reuses its uid and
 * overwrites the record — so the name changes and nothing else moves.
 *
 *   node scripts/backfill-clock-names.js              # report
 *   node scripts/backfill-clock-names.js --write      # store clock_name
 *   node scripts/backfill-clock-names.js --write --push   # ...and rewrite on the clocks
 *   node scripts/backfill-clock-names.js --write --force  # re-derive existing values
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { Employee, AgentCommand, Branch } = require('../src/models');
const { toClockName } = require('../src/services/clockName.service');

const WRITE = process.argv.includes('--write');
const PUSH = process.argv.includes('--push');
const FORCE = process.argv.includes('--force');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const employees = await Employee.find({ is_active: true })
    .select('full_name israeli_id clock_name clock_aliases branch_id')
    .sort({ full_name: 1 })
    .lean();

  const branches = await Branch.find({}).select('name').lean();
  const branchName = new Map(branches.map(b => [String(b._id), b.name]));

  let stored = 0;
  let pushed = 0;
  let skipped = 0;

  for (const emp of employees) {
    const name = toClockName(emp.full_name);
    if (!name) { skipped += 1; continue; }

    const changed = emp.clock_name !== name;
    if (changed && (FORCE || !emp.clock_name)) {
      console.log(`${emp.full_name.padEnd(26)} → ${name}`);
      if (WRITE) {
        await Employee.updateOne({ _id: emp._id }, { $set: { clock_name: name } });
        stored += 1;
      }
    }

    if (!PUSH) continue;

    // Only devices this worker is already on. Enrolling her somewhere new is a
    // different decision, and not one a rename should make.
    const ids = [emp.israeli_id, ...(emp.clock_aliases || [])].filter(Boolean);
    const enrolled = await AgentCommand.find({
      type: 'add_user',
      status: 'confirmed',
      'payload.israeli_id': { $in: ids },
    }).select('branch_id payload.israeli_id').lean();

    const seen = new Set();
    for (const cmd of enrolled) {
      const key = `${cmd.branch_id}|${cmd.payload.israeli_id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Don't stack renames on a device that already has one waiting.
      const queued = await AgentCommand.findOne({
        branch_id: cmd.branch_id,
        type: 'add_user',
        status: { $in: ['pending', 'sent'] },
        'payload.israeli_id': cmd.payload.israeli_id,
      }).select('_id').lean();
      if (queued) continue;

      console.log(`  ↳ ${branchName.get(String(cmd.branch_id)) || cmd.branch_id}: rewrite ${cmd.payload.israeli_id} as "${name}"`);
      if (WRITE) {
        await AgentCommand.create({
          branch_id: cmd.branch_id,
          type: 'add_user',
          payload: { israeli_id: cmd.payload.israeli_id, name, privilege: 0 },
          status: 'pending',
        });
        pushed += 1;
      }
    }
  }

  console.log(`\n${employees.length} active employees.`);
  console.log(WRITE ? `${stored} clock names stored.` : `${stored} would be stored.`);
  if (PUSH) console.log(WRITE ? `${pushed} device rewrites queued.` : `${pushed} device rewrites would be queued.`);
  if (skipped) console.log(`${skipped} skipped (no usable name).`);
  if (!WRITE) console.log('Dry run — pass --write to apply.');

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
