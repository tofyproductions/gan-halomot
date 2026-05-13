/**
 * One-shot: copy `manual.notes` from month 2026-04 → 2026-05 for every
 * employee that had notes. Skips rows where 2026-05 already has a note so
 * we don't overwrite anything entered for May.
 *
 * Run from server/ with `node scripts/migrate-april-notes-to-may.js`.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { PayrollMonth } = require('../src/models');

const SRC_MONTH = '2026-04';
const DST_MONTH = '2026-05';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  await mongoose.connect(uri);

  const srcRows = await PayrollMonth.find({
    month: SRC_MONTH,
    'manual.notes': { $exists: true, $ne: '' },
  }).lean();

  console.log(`Source rows in ${SRC_MONTH} with notes: ${srcRows.length}`);

  let migrated = 0;
  let skipped = 0;
  for (const r of srcRows) {
    const note = (r.manual?.notes || '').trim();
    if (!note) continue;
    const existing = await PayrollMonth.findOne({ employee_id: r.employee_id, month: DST_MONTH }).lean();
    if (existing?.manual?.notes && existing.manual.notes.trim()) {
      console.log(`  skip ${r.employee_id} — May already has note`);
      skipped++;
      continue;
    }
    await PayrollMonth.findOneAndUpdate(
      { employee_id: r.employee_id, month: DST_MONTH },
      {
        $set: { 'manual.notes': note },
        $setOnInsert: { branch_id: r.branch_id, employee_id: r.employee_id, month: DST_MONTH },
      },
      { upsert: true },
    );
    migrated++;
  }

  console.log(`migrated=${migrated} skipped=${skipped}`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
