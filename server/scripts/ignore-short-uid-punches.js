/**
 * Mark every orphan Punch whose israeli_id is a single digit (0-9) as
 * ignored=true. These come from TIMEDOX device users registered with a
 * numeric UID instead of a real Israeli ID — there's no way to identify
 * who they were after the fact, so we hide them from attendance reports.
 *
 * Run:  node scripts/ignore-short-uid-punches.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Punch } = require('../src/models');

async function main() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGODB_URI);

  const candidates = await Punch.find({
    employee_id: null,
    ignored: { $ne: true },
    israeli_id: { $regex: /^\d$/ },
  }).select('_id israeli_id branch_id').lean();

  console.log(`Found ${candidates.length} orphan punches with single-digit israeli_id`);
  if (apply && candidates.length > 0) {
    const result = await Punch.updateMany(
      { _id: { $in: candidates.map(c => c._id) } },
      { $set: { ignored: true, ignored_reason: 'device_user_id 0-9 — לא מזוהה (אין ת"ז אמיתית בשעון)' } },
    );
    console.log(`Marked ignored: ${result.modifiedCount}`);
  } else if (!apply) {
    console.log('Pass --apply to mark as ignored.');
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
