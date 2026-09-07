#!/usr/bin/env node
/**
 * distributionPreview — ת"ז matching and per-branch attribution, end to end
 * against a real (ephemeral) MongoDB.
 *
 * Two things this pins down, both of which broke the all-branches August run:
 *
 * 1. The payslip PDF prints an 8-digit ת"ז (leading zero dropped by the payroll
 *    software) while Employee.israeli_id is stored padded to 9. An exact-string
 *    lookup matched nobody, so the payslip was attributed to no employee and
 *    could not be sent. Worst for a payslip with NO salary-table row — someone
 *    whose employment ended and who was archived out of the month — because the
 *    table_row ת"ז that rescued everyone else does not exist for her.
 *
 * 2. `branch` on each item is the branch of the FILE the payslip came from. One
 *    PDF for the whole organisation tags every payslip "כל הסניפים", so the
 *    distribution dialog cannot group by it. `employee_branch` is the
 *    employee's own branch, which is what the dialog groups and sends by.
 *
 *   node scripts/payslip-distribution-branches.test.js
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'audit_test' } });
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'test-secret';
  await mongoose.connect(mongod.getUri());

  const { Branch, Employee, PayslipAuditRecord } = require('../src/models');
  const { distributionPreview } = require('../src/controllers/payslipAudit.controller');

  const herzliya = await Branch.create({ name: 'הרצליה הרצוג' });
  const kfarSaba = await Branch.create({ name: 'כפר סבא - קפלן' });

  // Saved with .create() so the model's pre-save hook pads each ת"ז to 9 —
  // exactly how production rows look.
  const active = await Employee.create({
    full_name: 'דנה כהן', israeli_id: '12345678', branch_id: herzliya._id,
    email: 'dana@example.com', is_active: true,
  });
  // Employment ended in July; archived out of the August salary table, but she
  // still receives an August payslip.
  const terminated = await Employee.create({
    full_name: 'מיכל לוי', israeli_id: '23456789', branch_id: kfarSaba._id,
    email: 'michal@example.com', is_active: false,
    inactive_reason: 'סיום העסקה', inactive_effective_month: '2026-07',
  });
  check('the model padded both ID numbers to 9 digits (production shape)',
    active.israeli_id === '012345678' && terminated.israeli_id === '023456789',
    `${active.israeli_id} / ${terminated.israeli_id}`);

  // One all-branches PDF: every result carries __source_branch "כל הסניפים".
  // The terminated employee has no table_row — she was archived out of the month.
  const audit = await PayslipAuditRecord.create({
    year_month: '2026-08',
    branches: ['כל הסניפים'],
    full_result: {
      results: [
        {
          __source_branch: 'כל הסניפים',
          table_row: { employee_name: 'דנה כהן', israeli_id: '012345678', branch: 'הרצליה הרצוג' },
          payslip: { employee_name: 'דנה כהן', employee_id: '12345678', page_index: 1 },
          findings: [],
        },
        {
          __source_branch: 'כל הסניפים',
          table_row: null,
          payslip: { employee_name: 'מיכל לוי', employee_id: '23456789', page_index: 2 },
          findings: [{ field: 'orphan_payslip', severity: 'warning' }],
        },
      ],
    },
  });

  const items = await new Promise((resolve, reject) => {
    distributionPreview(
      { params: { id: String(audit._id) } },
      { json: (d) => resolve(d.items), status: () => ({ json: (b) => reject(new Error(b.error)) }) },
    ).catch(reject);
  });

  const byName = Object.fromEntries(items.map(it => [it.payslip_name, it]));
  const dana = byName['דנה כהן'];
  const michal = byName['מיכל לוי'];

  console.log('\nת"ז matching');
  check('an 8-digit payslip ת"ז matches the padded employee record',
    dana?.matched === true && dana?.employee_id === String(active._id));
  check('THE BUG: a terminated employee with NO table row is still matched',
    michal?.matched === true && michal?.employee_id === String(terminated._id),
    michal ? `matched=${michal.matched}` : 'row missing entirely');
  check('both read as ת"ז-verified, not "הותאם (בדוק)"',
    dana?.id_verified === true && michal?.id_verified === true);
  check('each carries its own email for the send',
    dana?.email === 'dana@example.com' && michal?.email === 'michal@example.com');

  console.log('\nper-branch attribution');
  check('the file branch really is the useless one (all payslips share it)',
    dana?.branch === 'כל הסניפים' && michal?.branch === 'כל הסניפים');
  check('employee_branch is the employee\'s own branch, not the file\'s',
    dana?.employee_branch === 'הרצליה הרצוג' && michal?.employee_branch === 'כפר סבא - קפלן',
    `${dana?.employee_branch} / ${michal?.employee_branch}`);
  const branchKeys = new Set(items.map(it => it.employee_branch));
  check('grouping by employee_branch yields one NAMED group per real branch',
    branchKeys.size === 2 && !branchKeys.has('') && !branchKeys.has(undefined),
    [...branchKeys].map(b => `"${b}"`).join(', '));
  check('the terminated employee lands in HER branch, not an "unknown" pile',
    michal?.employee_branch === 'כפר סבא - קפלן');

  await mongoose.disconnect();
  await mongod.stop();
}

main().then(() => {
  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
