#!/usr/bin/env node
/**
 * התחייבות שנשארה בסניף הישן — איתור ותיקון.
 *
 * A commitment copies its branch from the employee when SAVED, but changing
 * the employee's branch never touched it (fixed in payroll.controller on
 * 08.10.2026 — this script heals the rows left behind from before the fix).
 * Found with גיל: contract issued to קפלן by mistake, card corrected to
 * משה דיין, commitment stayed on קפלן.
 *
 * Usage:
 *   node scripts/sync-commitment-branches.js              # dry run — report only
 *   node scripts/sync-commitment-branches.js --apply      # move every mismatch
 *   node scripts/sync-commitment-branches.js --apply --employee גיל
 *                                                         # move only matching names
 *
 * Applying also seeds the employee's shifts into her new branch's open rota
 * weeks, exactly as saving the commitment by hand would.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const APPLY = process.argv.includes('--apply');
const nameArgAt = process.argv.indexOf('--employee');
const NAME_FILTER = nameArgAt > -1 ? String(process.argv[nameArgAt + 1] || '').trim() : '';

(async () => {
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI);
  const { Employee, EmployeeCommitment, Branch } = require('../src/models');

  const branches = await Branch.find({}).select('name').lean();
  const nameOf = new Map(branches.map(b => [String(b._id), b.name]));

  const commitments = await EmployeeCommitment.find({}).lean();
  const emps = await Employee.find({ _id: { $in: commitments.map(c => c.employee_id) } })
    .select('full_name branch_id is_active').lean();
  const empById = new Map(emps.map(e => [String(e._id), e]));

  const mismatched = commitments
    .map(c => ({ c, emp: empById.get(String(c.employee_id)) }))
    .filter(({ c, emp }) => emp && emp.branch_id
      && String(c.branch_id || '') !== String(emp.branch_id))
    .filter(({ emp }) => !NAME_FILTER || (emp.full_name || '').includes(NAME_FILTER));

  if (!mismatched.length) {
    console.log('✅ אין התחייבויות שמצביעות על סניף אחר מהעובדת. הכול מסונכרן.');
  } else {
    console.log(`${APPLY ? '🔧 מתקן' : '🔎 דו"ח בלבד (הוסיפו --apply לתיקון)'} — ${mismatched.length} התחייבויות לא על סניף העובדת:\n`);
    for (const { c, emp } of mismatched) {
      const from = nameOf.get(String(c.branch_id)) || c.branch_id;
      const to = nameOf.get(String(emp.branch_id)) || emp.branch_id;
      console.log(`  • ${emp.full_name}${emp.is_active === false ? ' (לא פעילה)' : ''}: ${from} ← ${to}`);
      if (!APPLY) continue;
      await EmployeeCommitment.updateOne({ _id: c._id }, { $set: { branch_id: emp.branch_id } });
      const added = await require('../src/services/shifts/shiftWeek.service')
        .seedMissing({ branchId: String(emp.branch_id), employeeIds: [String(emp._id)] })
        .catch(e => { console.error(`    ⚠ שיבוץ ללוח נכשל: ${e.message}`); return 0; });
      console.log(`    ✓ ההתחייבות הועברה${added ? `, נוספו ${added} משבצות ללוח המשמרות` : ''}`);
    }
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
